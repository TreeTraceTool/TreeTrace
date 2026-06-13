import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { parseArgs, loadRedactedTree, detectProjectName, assertClean } from './cli.js';
import { renderHandoff } from './handoff.js';
import { renderLessonsMarkdown, analyzeTree } from './analyze.js';
import { renderSecurityReport } from './security-report.js';
import { renderHallucinationsJson } from './hallucinate.js';

const PROTOCOL_VERSION = '2024-11-05';

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
];

export async function startMcpServer({ argv, version }, io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const opts = parseArgs((argv || []).filter((a) => a !== 'mcp' && a !== '--mcp'));
  const projectDir = resolve(opts.dir || process.cwd());
  const projectName = detectProjectName(projectDir);

  let cache = null;
  const ensureTree = async () => {
    if (cache) return cache;
    const { tree, decisions } = await loadRedactedTree(opts, projectDir, projectName, () => {}, { forceAuto: true });
    cache = { tree, decisions, renderOpts: { projectName, version, projectDir, generatedAt: new Date().toISOString() } };
    return cache;
  };

  return new Promise((resolveServer) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);

    rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) return;
      let req;
      try {
        req = JSON.parse(text);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      try {
        await handle(req, send, ensureTree, version);
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id: req && req.id !== undefined ? req.id : null,
          error: { code: -32603, message: `Internal error: ${err && err.message ? err.message : 'unknown'}` },
        });
      }
    });
    rl.on('close', () => resolveServer());
  });
}

async function handle(req, send, ensureTree, version) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    send({ jsonrpc: '2.0', id: req && req.id !== undefined ? req.id : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const isNotification = req.id === undefined || req.id === null;
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
        schemaVersion: '0.2',
        evalCandidates: analysis.evalCandidates,
        hallucinationEvalCandidates: hall.hallucinations.map((h) => h.evalCandidate),
      };
      return JSON.stringify(payload, null, 2);
    }
    default:
      return '';
  }
}
