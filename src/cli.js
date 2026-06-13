import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { discoverSessions } from './discover.js';
import { parseSessionFile, parsePlainTranscript } from './parse.js';
import { adaptFrom, autoAdapt, TOOLS } from './adapters/index.js';
import { classifyPrompts } from './extract.js';
import { buildTree } from './tree.js';
import { scanText, resolveFindings, applyDecisions, shadowScan } from './redact.js';
import { renderMarkdown } from './render-md.js';
import { renderJson } from './render-json.js';
import { renderHandoff } from './handoff.js';
import { renderReportMarkdown, renderTerminalSummary } from './report.js';
import {
  analyzeTree,
  renderFailuresJson,
  renderLessonsMarkdown,
  renderEvalsJsonl,
  renderMemoryMarkdown,
} from './analyze.js';
import { makeTitle } from './extract.js';
import { renderHallucinationsJson } from './hallucinate.js';
import { renderSecurityReport } from './security-report.js';
import { startMcpServer } from './mcp.js';
import { c, plural, truncate } from './util.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `TreeTrace - turn AI coding sessions into regression-ready prompt lineage

Usage:
  treetrace                     auto-discover Claude Code sessions for this directory
  treetrace --file <path>...    parse specific session/transcript files
  treetrace --from <tool> --file <path>   import another tool's export
  treetrace --stdin             read a pasted transcript from stdin
  treetrace --report            write all artifacts and print the human report
  treetrace --handoff           print an agent-ready handoff brief to stdout
  treetrace --failures          write and print failure-analysis JSON
  treetrace --lessons           write and print lessons Markdown
  treetrace --evals             write and print eval JSONL
  treetrace --memory            write and print compact agent memory
  treetrace --security          print a security-focused report for this session
  treetrace mcp                 start a read-only MCP server over stdio

Options:
  --from <tool>         input format for --file: claude, codex, chatgpt, gemini,
                        copilot, grok, cursor, transcript (default: auto-detect)
  --dir <path>          project directory to trace (default: cwd)
  --out <file>          markdown output path (default: PROMPT_TREE.md)
  --report-file <file>  human report output path (default: TREETRACE_REPORT.md)
  --json                also print lineage JSON to stdout
  --analysis            write failure, lesson, eval, and memory artifacts
  --titles-only         omit full prompt texts from the markdown tree
  --security            print a security-focused report and write hallucinations.json
  --mcp                 start a read-only MCP server over stdio (same as: treetrace mcp)
  --redact-auto         redact every detected secret without prompting
  --since <YYYY-MM-DD>  only include sessions active on/after this date
  --quiet               suppress progress output
  --version, --help

Every export passes a redaction gate: detected secrets must be resolved
(redact/keep/edit) before anything is written. Outside a terminal, every
hit is redacted automatically - treetrace fails closed.`;

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void console.log(HELP);
  if (opts.version) return void console.log(VERSION);
  if (opts.mcp) return await startMcpServer({ argv, version: VERSION });

  const projectDir = resolve(opts.dir || process.cwd());
  const projectName = detectProjectName(projectDir);
  const log = opts.quiet ? () => {} : (msg) => process.stderr.write(`${msg}\n`);

  const { tree, decisions, asked, sourceTool } = await loadRedactedTree(opts, projectDir, projectName, log);

  const ttDir = join(projectDir, '.treetrace');
  const decisionsPath = join(ttDir, 'redactions.json');

  const generatedAt = new Date().toISOString();
  const renderOpts = { projectName, titlesOnly: opts.titlesOnly, version: VERSION, generatedAt, sourceType: sourceTypeFor(sourceTool) };

  if (opts.handoff) {
    const pack = renderHandoff(tree, renderOpts);
    assertClean(pack, decisions, 'handoff brief');
    process.stdout.write(pack);
    log(c.green(`✓ handoff brief for ${projectName} (${plural(tree.stats.promptCount, 'prompt')} distilled)`));
    return;
  }

  if (opts.security) {
    const securityReport = renderSecurityReport(tree, projectDir, renderOpts);
    const hallucinationsText = JSON.stringify(renderHallucinationsJson(tree, projectDir, renderOpts), null, 2);
    assertClean(securityReport, decisions, 'security report');
    assertClean(hallucinationsText, decisions, 'hallucinations.json');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(ttDir, { recursive: true });
    writeFileSync(join(ttDir, 'hallucinations.json'), hallucinationsText);
    writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2));
    process.stdout.write(securityReport);
    log(c.green(`✓ security report for ${projectName}; wrote .treetrace/hallucinations.json`));
    return;
  }

  const md = renderMarkdown(tree, renderOpts);
  const json = renderJson(tree, renderOpts);
  const jsonText = JSON.stringify(json, null, 2);
  const artifacts = analysisArtifacts(ttDir, tree, renderOpts, projectDir);
  const outPath = resolve(projectDir, opts.out || 'PROMPT_TREE.md');
  const reportPath = resolve(projectDir, opts.reportFile || 'TREETRACE_REPORT.md');
  const report = renderReportMarkdown(tree, renderOpts);

  const requested = requestedArtifacts(opts, artifacts);
  if (requested.length && !opts.report) {
    for (const artifact of requested) assertClean(artifact.text, decisions, artifact.label);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(ttDir, { recursive: true });
    for (const artifact of requested) writeFileSync(artifact.path, artifact.text);
    writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2));
    if (requested.length === 1) {
      process.stdout.write(requested[0].text);
    } else {
      process.stdout.write(requested.map((a) => `# ${a.label}\n\n${a.text}`).join('\n'));
    }
    log(c.green(`wrote ${requested.map((a) => relativeish(a.path, projectDir)).join(', ')}`));
    return;
  }

  assertClean(md, decisions, 'PROMPT_TREE.md');
  assertClean(jsonText, decisions, 'tree.json');
  for (const artifact of Object.values(artifacts)) assertClean(artifact.text, decisions, artifact.label);
  assertClean(report, decisions, 'TREETRACE_REPORT.md');

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(ttDir, { recursive: true });
  writeFileSync(outPath, md);
  writeFileSync(reportPath, report);
  writeFileSync(join(ttDir, 'tree.json'), jsonText);
  for (const artifact of Object.values(artifacts)) writeFileSync(artifact.path, artifact.text);

  writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2));

  if (opts.json) process.stdout.write(jsonText + '\n');
  if (opts.report) process.stdout.write(report);

  log('');
  log(summaryLine(tree.stats, projectName));
  log(renderTerminalSummary(tree, renderOpts).trimEnd());
  previewTree(tree, log);
  log('');
  log(
    `${c.green('ok')} wrote ${c.bold(relativeish(reportPath, projectDir))}, ${c.bold(relativeish(outPath, projectDir))}, .treetrace/tree.json, and analysis artifacts`
  );
  if (!opts.report) log(c.dim('  run `treetrace --report` to print the human report in this terminal'));
  if (asked) log(c.dim(`  ${plural(asked, 'redaction decision')} saved to .treetrace/redactions.json`));
}

export async function loadRedactedTree(opts, projectDir, projectName, log = () => {}, { forceAuto = false } = {}) {
  let sessions = [];
  let sourceTool = 'claude';
  if (opts.stdin) {
    const text = readFileSync(0, 'utf8');
    if (opts.from && opts.from !== 'transcript') {
      const { sessions: adapted, tool } = ingestText(opts.from, text, 'stdin', log);
      sessions = adapted;
      sourceTool = tool;
    } else {
      sessions = [parsePlainTranscript(text)];
      sourceTool = 'transcript';
    }
  } else if (opts.files.length) {
    const tools = new Set();
    for (const file of opts.files) {
      const { sessions: fileSessions, tool } = await ingestFile(file, opts.from, log);
      sessions.push(...fileSessions);
      tools.add(tool);
    }
    sourceTool = tools.size === 1 ? [...tools][0] : 'mixed';
  } else {
    const found = discoverSessions(projectDir);
    const filtered = opts.since
      ? found.filter((s) => s.mtimeMs >= Date.parse(opts.since))
      : found;
    if (!filtered.length) {
      throw new Error(
        `no Claude Code sessions found for ${projectDir}.\n` +
          `Looked in ~/.claude/projects/ for sessions started from this directory.\n` +
          `Use --file <transcript> or --stdin to import a transcript directly.`
      );
    }
    const totalMB = filtered.reduce((a, s) => a + s.sizeBytes, 0) / 1048576;
    log(
      `${c.cyan('treetrace')} found ${plural(filtered.length, 'session')} for ${c.bold(projectName)} (${totalMB.toFixed(1)} MB)`
    );
    for (const meta of filtered) {
      if (meta.sizeBytes > 5 * 1048576)
        log(c.dim(`  parsing ${meta.sessionId.slice(0, 8)}... (${(meta.sizeBytes / 1048576).toFixed(0)} MB)`));
      sessions.push(await parseSessionFile(meta.path, meta));
    }
  }

  if (opts.since) {
    sessions = sessions.filter((s) => !s.lastTs || s.lastTs >= opts.since);
  }

  const nodes = classifyPrompts(sessions);
  if (!nodes.length) {
    throw new Error('no human prompts found in these sessions, nothing to trace.');
  }
  const tree = buildTree(sessions, nodes);

  const ttDir = join(projectDir, '.treetrace');
  const decisionsPath = join(ttDir, 'redactions.json');
  let priorDecisions = {};
  if (existsSync(decisionsPath)) {
    try {
      priorDecisions = JSON.parse(readFileSync(decisionsPath, 'utf8'));
    } catch {
      priorDecisions = {};
    }
  }

  const ACTION_FIELDS = ['command', 'file', 'input'];
  const findings = [];
  for (const node of tree.nodes) {
    findings.push(...scanText(node.text));
    for (const action of node.actions || []) {
      for (const field of ACTION_FIELDS) {
        if (typeof action[field] === 'string') findings.push(...scanText(action[field]));
      }
    }
  }

  const interactive = !forceAuto && process.stdin.isTTY && process.stderr.isTTY && !opts.redactAuto;
  const { decisions, asked, autoRedacted } = await resolveFindings(findings, priorDecisions, {
    interactive,
    autoRedact: forceAuto || opts.redactAuto,
  });
  if (autoRedacted) {
    log(
      c.yellow(
        `redacted ${plural(autoRedacted, 'potential secret')} automatically (non-interactive mode fails closed)`
      )
    );
  }

  for (const node of tree.nodes) {
    const before = node.text;
    node.text = applyDecisions(node.text, findings, decisions);
    if (node.text !== before) node.title = makeTitle(node.text);
    for (const action of node.actions || []) {
      for (const field of ACTION_FIELDS) {
        if (typeof action[field] === 'string') {
          action[field] = applyDecisions(action[field], findings, decisions);
        }
      }
    }
  }
  analyzeTree(tree);

  return { tree, decisions, asked, sourceTool };
}

const SOURCE_TYPE_BY_TOOL = {
  claude: 'claude-code-jsonl',
  codex: 'codex-rollout',
  chatgpt: 'chatgpt-export',
  gemini: 'gemini-cli',
  copilot: 'copilot-chat',
  cursor: 'cursor-export',
  grok: 'grok-cli',
  transcript: 'transcript',
};

function sourceTypeFor(tool) {
  return SOURCE_TYPE_BY_TOOL[tool] || 'claude-code-jsonl';
}

function ingestText(from, text, label, log) {
  const sessions = adaptFrom(from, text, label);
  log(c.dim(`  read ${from} format from ${label}`));
  return { sessions, tool: from };
}

async function ingestFile(file, from, log) {
  if (from && from !== 'claude' && from !== 'transcript') {
    const text = readFileSync(file, 'utf8');
    return { sessions: adaptFrom(from, text, file), tool: from };
  }
  if (from === 'claude') {
    return { sessions: [await parseSessionFile(file, { sessionId: basename(file, '.jsonl') })], tool: 'claude' };
  }
  if (from === 'transcript') {
    return { sessions: [parsePlainTranscript(readFileSync(file, 'utf8'), basename(file))], tool: 'transcript' };
  }

  if (file.endsWith('.jsonl')) {
    const text = readFileSync(file, 'utf8');
    const adapted = autoAdapt(text, file);
    if (adapted && adapted.sessions.some((s) => s.prompts.length)) {
      log(c.dim(`  detected ${adapted.tool} format in ${basename(file)}`));
      return { sessions: adapted.sessions, tool: adapted.tool };
    }
    return { sessions: [await parseSessionFile(file, { sessionId: basename(file, '.jsonl') })], tool: 'claude' };
  }

  if (file.endsWith('.json')) {
    const text = readFileSync(file, 'utf8');
    const adapted = autoAdapt(text, file);
    if (adapted && adapted.sessions.some((s) => s.prompts.length)) {
      log(c.dim(`  detected ${adapted.tool} format in ${basename(file)}`));
      return { sessions: adapted.sessions, tool: adapted.tool };
    }
  }

  return { sessions: [parsePlainTranscript(readFileSync(file, 'utf8'), basename(file))], tool: 'transcript' };
}

function analysisArtifacts(ttDir, tree, renderOpts, projectDir) {
  return {
    failures: {
      label: 'failures.json',
      path: join(ttDir, 'failures.json'),
      text: JSON.stringify(renderFailuresJson(tree, renderOpts), null, 2),
    },
    hallucinations: {
      label: 'hallucinations.json',
      path: join(ttDir, 'hallucinations.json'),
      text: JSON.stringify(renderHallucinationsJson(tree, projectDir, renderOpts), null, 2),
    },
    lessons: {
      label: 'lessons.md',
      path: join(ttDir, 'lessons.md'),
      text: renderLessonsMarkdown(tree, renderOpts),
    },
    evals: {
      label: 'evals.jsonl',
      path: join(ttDir, 'evals.jsonl'),
      text: renderEvalsJsonl(tree, renderOpts),
    },
    memory: {
      label: 'agent-memory.md',
      path: join(ttDir, 'agent-memory.md'),
      text: renderMemoryMarkdown(tree, renderOpts),
    },
  };
}

function requestedArtifacts(opts, artifacts) {
  const requested = [];
  if (opts.failures) requested.push(artifacts.failures);
  if (opts.lessons) requested.push(artifacts.lessons);
  if (opts.evals) requested.push(artifacts.evals);
  if (opts.memory) requested.push(artifacts.memory);
  if (opts.analysis && !requested.length) requested.push(...Object.values(artifacts));
  return requested;
}

export function assertClean(rendered, decisions, label) {
  const leaks = shadowScan(rendered, decisions);
  if (leaks.length) {
    throw new Error(
      `shadow scan found ${plural(leaks.length, 'unresolved secret')} in the rendered ${label} ` +
        `(${[...new Set(leaks.map((l) => l.ruleId))].join(', ')}). Refusing to write. ` +
        `This is a bug worth reporting; as a workaround run interactively to resolve hits.`
    );
  }
}

function summaryLine(stats, projectName) {
  const bits = [
    c.bold(plural(stats.promptCount, 'prompt')),
    plural(stats.sessionCount, 'session'),
  ];
  if (stats.days) bits.push(plural(stats.days, 'day'));
  if (stats.corrections) bits.push(`${stats.corrections} ${c.yellow('↩')} corrections`);
  if (stats.abandonedBranches) bits.push(`${stats.abandonedBranches} ${c.red('✗')} abandoned`);
  if (stats.toolUses) bits.push(`${stats.toolUses.toLocaleString()} tool calls`);
  return `${c.cyan('🌳')} ${c.bold(projectName)} · ${bits.join(' · ')}`;
}

const PREVIEW_LIMIT = 30;
function previewTree(tree, log) {
  let shown = 0;
  const emit = (node, depth) => {
    if (shown >= PREVIEW_LIMIT) return false;
    shown++;
    const icon =
      node.kind === 'root' ? c.magenta('⬢')
      : node.kind === 'correction' ? c.yellow('↩')
      : node.kind === 'scope-change' ? c.cyan('⚑')
      : node.kind === 'checkpoint' ? c.blue('◆')
      : node.kind === 'question' ? c.gray('?')
      : c.green('→');
    const title =
      node.status === 'abandoned' ? c.dim(`${truncate(node.title, 70)} ${c.red('✗')}`) : truncate(node.title, 70);
    log(`${'  '.repeat(depth + 1)}${icon} ${title}`);
    return true;
  };

  const walk = (node, depth) => {
    let cur = node;
    for (;;) {
      if (!emit(cur, depth)) return;
      if (cur.children.length === 1) {
        cur = cur.children[0];
        continue;
      }
      for (const ch of cur.children) walk(ch, depth + 1);
      return;
    }
  };
  for (const r of tree.roots) walk(r, 0);
  if (shown >= PREVIEW_LIMIT && tree.nodes.length > shown)
    log(c.dim(`  ... ${tree.nodes.length - shown} more (see PROMPT_TREE.md)`));
}

function relativeish(p, base) {
  return p.startsWith(base) ? p.slice(base.length + 1) : p;
}

export function detectProjectName(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch {

  }
  return basename(dir);
}

export function parseArgs(argv) {
  const opts = {
    files: [],
    stdin: false,
    report: false,
    handoff: false,
    json: false,
    analysis: false,
    failures: false,
    lessons: false,
    evals: false,
    memory: false,
    security: false,
    mcp: false,
    titlesOnly: false,
    redactAuto: false,
    quiet: false,
    help: false,
    version: false,
    from: null,
    dir: null,
    out: null,
    reportFile: null,
    since: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--file':
        while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.files.push(argv[++i]);
        break;
      case '--stdin': opts.stdin = true; break;
      case '--report': opts.report = true; break;
      case '--handoff': opts.handoff = true; break;
      case '--json': opts.json = true; break;
      case '--analysis': opts.analysis = true; break;
      case '--failures': opts.failures = true; break;
      case '--lessons': opts.lessons = true; break;
      case '--evals': opts.evals = true; break;
      case '--memory': opts.memory = true; break;
      case '--security': opts.security = true; break;
      case 'mcp': case '--mcp': opts.mcp = true; break;
      case '--titles-only': opts.titlesOnly = true; break;
      case '--redact-auto': opts.redactAuto = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--version': case '-v': opts.version = true; break;
      case '--from':
        opts.from = argv[++i];
        if (!TOOLS.includes(opts.from)) {
          throw new Error(`unknown --from value "${opts.from}" (expected one of: ${TOOLS.join(', ')})`);
        }
        break;
      case '--dir': opts.dir = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--report-file': opts.reportFile = argv[++i]; break;
      case '--since': opts.since = argv[++i]; break;
      default:
        throw new Error(`unknown option ${a} (try --help)`);
    }
  }
  return opts;
}
