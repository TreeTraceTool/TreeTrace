import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { discoverSessions } from './discover.js';
import { parseSessionFile, parsePlainTranscript } from './parse.js';
import { classifyPrompts } from './extract.js';
import { buildTree } from './tree.js';
import { scanText, resolveFindings, applyDecisions, shadowScan } from './redact.js';
import { renderMarkdown } from './render-md.js';
import { renderJson } from './render-json.js';
import { renderHandoff } from './handoff.js';
import { makeTitle } from './extract.js';
import { c, plural, truncate } from './util.js';

const VERSION = '0.1.0';

const HELP = `treetrace — turn AI coding sessions into a shareable PROMPT_TREE.md

Usage:
  treetrace                     auto-discover Claude Code sessions for this directory
  treetrace --file <path>...    parse specific transcript files (.jsonl or plain text)
  treetrace --stdin             read a pasted transcript from stdin
  treetrace --handoff           print an agent-ready handoff brief to stdout

Options:
  --dir <path>          project directory to trace (default: cwd)
  --out <file>          markdown output path (default: PROMPT_TREE.md)
  --json                also print lineage JSON to stdout
  --titles-only         omit full prompt texts from the markdown tree
  --redact-auto         redact every detected secret without prompting
  --since <YYYY-MM-DD>  only include sessions active on/after this date
  --quiet               suppress progress output
  --version, --help

Every export passes a redaction gate: detected secrets must be resolved
(redact/keep/edit) before anything is written. Outside a terminal, every
hit is redacted automatically — treetrace fails closed.`;

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void console.log(HELP);
  if (opts.version) return void console.log(VERSION);

  const projectDir = resolve(opts.dir || process.cwd());
  const projectName = detectProjectName(projectDir);
  const log = opts.quiet ? () => {} : (msg) => process.stderr.write(`${msg}\n`);

  // ---- gather sessions ----
  let sessions = [];
  if (opts.stdin) {
    const text = readFileSync(0, 'utf8');
    sessions = [parsePlainTranscript(text)];
  } else if (opts.files.length) {
    for (const file of opts.files) {
      if (file.endsWith('.jsonl')) {
        sessions.push(await parseSessionFile(file, { sessionId: basename(file, '.jsonl') }));
      } else {
        sessions.push(parsePlainTranscript(readFileSync(file, 'utf8'), basename(file)));
      }
    }
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

  // ---- extract + build ----
  const nodes = classifyPrompts(sessions);
  if (!nodes.length) {
    throw new Error('no human prompts found in these sessions — nothing to trace.');
  }
  const tree = buildTree(sessions, nodes);

  // ---- redaction gate ----
  const ttDir = join(projectDir, '.treetrace');
  const decisionsPath = join(ttDir, 'redactions.json');
  const priorDecisions = existsSync(decisionsPath)
    ? JSON.parse(readFileSync(decisionsPath, 'utf8'))
    : {};

  const findings = [];
  for (const node of tree.nodes) findings.push(...scanText(node.text));

  const interactive = process.stdin.isTTY && process.stderr.isTTY && !opts.redactAuto;
  const { decisions, asked, autoRedacted } = await resolveFindings(findings, priorDecisions, {
    interactive,
    autoRedact: opts.redactAuto,
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
  }

  // ---- render ----
  const generatedAt = new Date().toISOString();
  const renderOpts = { projectName, titlesOnly: opts.titlesOnly, version: VERSION, generatedAt };

  if (opts.handoff) {
    const pack = renderHandoff(tree, renderOpts);
    assertClean(pack, decisions, 'handoff brief');
    process.stdout.write(pack);
    log(c.green(`✓ handoff brief for ${projectName} (${plural(tree.stats.promptCount, 'prompt')} distilled)`));
    return;
  }

  const md = renderMarkdown(tree, renderOpts);
  const json = renderJson(tree, renderOpts);
  const jsonText = JSON.stringify(json, null, 2);

  assertClean(md, decisions, 'PROMPT_TREE.md');
  assertClean(jsonText, decisions, 'tree.json');

  const outPath = resolve(projectDir, opts.out || 'PROMPT_TREE.md');
  writeFileSync(outPath, md);
  mkdirSync(ttDir, { recursive: true });
  writeFileSync(join(ttDir, 'tree.json'), jsonText);
  // decisions file stores only hashes + actions — safe to keep, never secrets
  writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2));

  if (opts.json) process.stdout.write(jsonText + '\n');

  // ---- terminal summary ----
  log('');
  log(summaryLine(tree.stats, projectName));
  previewTree(tree, log);
  log('');
  log(`${c.green('✓')} wrote ${c.bold(relativeish(outPath, projectDir))} and .treetrace/tree.json`);
  if (asked) log(c.dim(`  ${plural(asked, 'redaction decision')} saved to .treetrace/redactions.json`));
}

function assertClean(rendered, decisions, label) {
  const leaks = shadowScan(rendered, decisions);
  if (leaks.length) {
    throw new Error(
      `shadow scan found ${plural(leaks.length, 'unresolved secret')} in the rendered ${label} ` +
        `(${[...new Set(leaks.map((l) => l.ruleId))].join(', ')}) — refusing to write. ` +
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
  return `${c.cyan('🌳')} ${c.bold(projectName)} — ${bits.join(' · ')}`;
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
  // flat for linear chains, indent only at forks (matches the md renderer)
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

function detectProjectName(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch {
    /* no package.json — fall through */
  }
  return basename(dir);
}

function parseArgs(argv) {
  const opts = {
    files: [],
    stdin: false,
    handoff: false,
    json: false,
    titlesOnly: false,
    redactAuto: false,
    quiet: false,
    help: false,
    version: false,
    dir: null,
    out: null,
    since: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--file':
        while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.files.push(argv[++i]);
        break;
      case '--stdin': opts.stdin = true; break;
      case '--handoff': opts.handoff = true; break;
      case '--json': opts.json = true; break;
      case '--titles-only': opts.titlesOnly = true; break;
      case '--redact-auto': opts.redactAuto = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--version': case '-v': opts.version = true; break;
      case '--dir': opts.dir = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--since': opts.since = argv[++i]; break;
      default:
        throw new Error(`unknown option ${a} (try --help)`);
    }
  }
  return opts;
}
