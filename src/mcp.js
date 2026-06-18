import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { parseArgs, loadRedactedTree, detectProjectName, assertClean } from './cli.js';
import { renderHandoff } from './handoff.js';
import { renderLessonsMarkdown, analyzeTree } from './analyze.js';
import { renderSecurityReport } from './security-report.js';
import { renderHallucinationsJson } from './hallucinate.js';
import { renderJson } from './render-json.js';
import { SCHEMA_VERSION } from './config.js';
import { TreetraceError, ExitCode } from './util.js';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_REQUEST_BYTES = 1048576;

const TOOL_DEFS = [
  {
    name: 'handoff',
    description: 'Continuation brief for the next agent: goal, accepted decisions, constraints, and dead ends. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'lessons',
    description: 'Accepted constraints and repeated corrections distilled from the session lineage. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'security_summary',
    description: 'Evidence-backed security-sensitive touches, test changes, risky commands, and hallucinated references. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'eval_candidates',
    description: 'Compact regression cases derived from session corrections and hallucinated references. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tree',
    description: 'Full prompt-lineage tree as canonical JSON (nodes, stats, analysis). The structured counterpart to the Markdown reports. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export async function startMcpServer({ argv, version }, io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const opts = parseArgs((argv || []).filter((a) => a !== 'mcp' && a !== '--mcp'));
  if (opts.stdin) {
    throw new TreetraceError(
      'treetrace mcp does not support --stdin: stdin is the JSON-RPC transport for the MCP server. ' +
        'Point the server at a project with --dir, or import a transcript with --file.',
      ExitCode.USAGE
    );
  }
  const projectDir = resolve(opts.dir || process.cwd());
  const projectName = detectProjectName(projectDir);

  let cache = null;
  let inFlight = null;
  const ensureTree = async () => {
    if (cache) return cache;
    if (!inFlight) {
      inFlight = (async () => {
        const { tree, decisions } = await loadRedactedTree(opts, projectDir, projectName, () => {}, { forceAuto: true });
        cache = { tree, decisions, renderOpts: { projectName, version, projectDir, generatedAt: new Date().toISOString() } };
        return cache;
      })().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  return new Promise((resolveServer) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);

    rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) return;
      if (text.length > MAX_REQUEST_BYTES) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: request exceeds size limit' } });
        return;
      }
      let req;
      try {
        req = JSON.parse(text);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (Array.isArray(req)) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: JSON-RPC batch requests are not supported' } });
        return;
      }
      try {
        await handle(req, send, ensureTree, version);
      } catch (err) {
        if (isRequestWithId(req)) {
          send({
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32603, message: `Internal error: ${err && err.message ? err.message : 'unknown'}` },
          });
        }
      }
    });
    rl.on('close', () => resolveServer());
  });
}

function isRequestWithId(req) {
  return Boolean(req) && typeof req === 'object' && !Array.isArray(req) && 'id' in req;
}

async function handle(req, send, ensureTree, version) {
  const hasId = isRequestWithId(req);
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    if (hasId) send({ jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const isNotification = !hasId;
  const reply = (result) => { if (!isNotification) send({ jsonrpc: '2.0', id: req.id, result }); };
  const fail = (code, message) => { if (!isNotification) send({ jsonrpc: '2.0', id: req.id, error: { code, message } }); };

  switch (req.method) {
    case 'initialize':
      reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'treetrace', version: version || '0.0.0' },
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: TOOL_DEFS });
      return;
    case 'tools/call': {
      const params = req.params || {};
      const name = params.name;
      const def = TOOL_DEFS.find((t) => t.name === name);
      if (!def) {
        fail(-32602, `Unknown tool: ${name}`);
        return;
      }
      const args = params.arguments;
      if (args !== undefined && args !== null) {
        if (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > 0) {
          fail(-32602, `Tool ${name} accepts no arguments`);
          return;
        }
      }
      const { tree, decisions, renderOpts } = await ensureTree();
      const text = renderTool(name, tree, renderOpts);
      assertClean(text, decisions, `mcp tool ${name}`);
      reply({ content: [{ type: 'text', text }], isError: false });
      return;
    }
    default:
      fail(-32601, `Method not found: ${req.method}`);
  }
}

function renderTool(name, tree, renderOpts) {
  switch (name) {
    case 'handoff':
      return renderHandoff(tree, renderOpts);
    case 'lessons':
      return renderLessonsMarkdown(tree, renderOpts);
    case 'security_summary':
      return renderSecurityReport(tree, renderOpts.projectDir || null, renderOpts);
    case 'eval_candidates': {
      const analysis = analyzeTree(tree);
      const hall = renderHallucinationsJson(tree, renderOpts.projectDir || null, renderOpts);
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        evalCandidates: analysis.evalCandidates,
        hallucinationEvalCandidates: hall.hallucinations.map((h) => h.evalCandidate),
      };
      return JSON.stringify(payload, null, 2);
    }
    case 'tree':
      return JSON.stringify(renderJson(tree, renderOpts), null, 2);
    default:
      return '';
  }
}
