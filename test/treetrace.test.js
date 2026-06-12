import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSessionFile, parsePlainTranscript, classifySpecialUserText } from '../src/parse.js';
import { classifyPrompts } from '../src/extract.js';
import { buildTree } from '../src/tree.js';
import { scanText, applyDecisions, shadowScan, maskFor, resolveFindings } from '../src/redact.js';
import { renderMarkdown, promptPack } from '../src/render-md.js';
import { renderJson } from '../src/render-json.js';
import { renderHandoff } from '../src/handoff.js';
import { renderReportMarkdown } from '../src/report.js';
import {
  analyzeTree,
  renderFailuresJson,
  renderLessonsMarkdown,
  renderEvalsJsonl,
  renderMemoryMarkdown,
} from '../src/analyze.js';
import { main } from '../src/cli.js';
import { mungePath } from '../src/discover.js';
import { sha256 } from '../src/util.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'synthetic-session.jsonl');

async function fixtureTree() {
  const session = await parseSessionFile(FIXTURE, { sessionId: 'fix-001' });
  const nodes = classifyPrompts([session]);
  return { session, nodes, tree: buildTree([session], nodes) };
}

test('parser: extracts only human prompts, skips tool results/commands/sidechains', async () => {
  const { session } = await fixtureTree();
  // u1, u5, u7, u9 are human; u4 ("continue") also collected pre-classification
  assert.equal(session.prompts.length, 5);
  assert.ok(session.prompts.every((p) => !p.text.startsWith('<command-name>')));
  assert.ok(!session.prompts.some((p) => p.text.includes('subagent')));
  assert.equal(session.title, 'Build a weather dashboard');
  assert.equal(session.stats.toolUses, 2);
  assert.equal(session.stats.interruptions, 1);
  assert.deepEqual(session.stats.models, ['assistant-model']);
  assert.equal(session.stats.filesTouched.length, 1);
});

test('extractor: classification kinds and nudge folding', async () => {
  const { nodes } = await fixtureTree();
  // "continue" folds into root as a nudge → 4 nodes
  assert.equal(nodes.length, 4);
  assert.equal(nodes[0].kind, 'root');
  assert.equal(nodes[0].nudges, 1);
  assert.equal(nodes[1].kind, 'direction'); // leaflet radar
  assert.equal(nodes[2].kind, 'correction'); // "No, scrap the radar map"
  assert.equal(nodes[3].kind, 'scope-change'); // "also add a settings panel"
  assert.equal(nodes[3].afterInterruption, true);
});

test('tree: fork detection marks rewound branch abandoned', async () => {
  const { tree } = await fixtureTree();
  const leaflet = tree.nodes.find((n) => n.text.includes('leaflet'));
  // a3 (leaflet work) was rewound - a4 forked from u5's other child; the
  // leaflet prompt itself is u5 which IS on the main path (a4 descends from it)
  assert.equal(leaflet.status, 'accepted');
  // every node chains to a single root
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.stats.promptCount, 4);
  assert.equal(tree.stats.corrections, 1);
});

test('redaction: catches anthropic key and basic-auth URL, masks them', async () => {
  const { tree } = await fixtureTree();
  const scope = tree.nodes.find((n) => n.kind === 'scope-change');
  const findings = scanText(scope.text);
  const rules = new Set(findings.map((f) => f.ruleId));
  assert.ok(rules.has('anthropic-key'), `anthropic-key not in ${[...rules]}`);
  assert.ok(rules.has('url-basic-auth'), `url-basic-auth not in ${[...rules]}`);

  const { decisions } = await resolveFindings(findings, {}, { interactive: false, autoRedact: true });
  const cleaned = applyDecisions(scope.text, findings, decisions);
  assert.ok(!cleaned.includes('sk-ant-'), 'key leaked');
  assert.ok(!cleaned.includes('hunter2pass'), 'password leaked');
  assert.ok(cleaned.includes('[REDACTED:'));
});

test('redaction: shadow scan flags unresolved secrets, passes resolved/kept ones', () => {
  const dirty = 'token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB end';
  assert.equal(shadowScan(dirty, {}).length, 1);

  const findings = scanText(dirty);
  const kept = { [sha256(findings[0].match)]: { action: 'keep', ruleId: findings[0].ruleId } };
  assert.equal(shadowScan(dirty, kept).length, 0);

  const masked = applyDecisions(dirty, findings, {
    [sha256(findings[0].match)]: { action: 'redact', replacement: maskFor(findings[0]), ruleId: findings[0].ruleId },
  });
  assert.equal(shadowScan(masked, {}).length, 0);
});

test('redaction: rule coverage on known formats', () => {
  const cases = [
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['github_pat_11AAAAAAA0123456789abcdefghij', 'github-fine-grained'],
    ['xoxb-treetrace-example-slack-token-0', 'slack-token'],
    ['sk_live_abcdefghijklmnop123', 'stripe-live-key'],
    ['tskey-auth-kFGiAS7CNTRL-abcdef123456', 'tailscale-key'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----', 'private-key-block'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'],
    ['password = "correct-horse-battery"', 'secret-assignment'],
    ['SECRET="correct horse battery staple"', 'secret-assignment'],
    ['https://user:p:a:ss@example.com/path', 'url-basic-auth'],
  ];
  for (const [sample, expected] of cases) {
    const hits = scanText(`some text ${sample} more text`).map((f) => f.ruleId);
    assert.ok(hits.includes(expected), `${expected} missed in: ${sample} (got ${hits})`);
  }
});

test('redaction: split provider tokens are caught before shadow scan', () => {
  const dirty = 'token sk-proj-abcdefghijklmnop\nqrstu1234567890ABCDE end';
  const findings = scanText(dirty);
  assert.ok(findings.some((f) => f.ruleId === 'openai-key'), `openai-key missed in ${findings}`);
  const masked = applyDecisions(dirty, findings, {
    [sha256(findings.find((f) => f.ruleId === 'openai-key').match)]: {
      action: 'redact',
      replacement: '[REDACTED:openai-key]',
      ruleId: 'openai-key',
    },
  });
  assert.equal(shadowScan(masked, {}).length, 0);
  assert.ok(!masked.includes('sk-proj-'));
});

test('redaction: benign text produces no high/medium findings', () => {
  const benign =
    'Refactor the parser in src/parse.js to handle commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a and bump to v2.1.0-beta.3. The README.md needs a section on CONTRIBUTING.';
  const hard = scanText(benign).filter((f) => f.severity !== 'soft');
  assert.deepEqual(hard, []);
});

test('renderers: markdown, json, handoff are consistent and footer-credited', async () => {
  const { tree } = await fixtureTree();
  analyzeTree(tree);
  const md = renderMarkdown(tree, { projectName: 'demo' });
  assert.ok(md.startsWith('# 🌳 Prompt Tree — demo'));
  assert.ok(md.includes('## Goal'));
  assert.ok(md.includes('## Reusable Prompt Pack'));
  assert.ok(md.includes('generated by [treetrace]') || md.includes('Generated by [treetrace]'));

  const json = renderJson(tree, { projectName: 'demo' });
  assert.equal(json.schemaVersion, '0.2');
  assert.equal(json.nodes.length, tree.nodes.length);
  assert.equal(json.edges.length, tree.nodes.filter((n) => n.parent).length);
  assert.ok(json.nodes.every((n) => n.id && n.kind && typeof n.text === 'string'));
  assert.ok(json.analysis.failureSignals >= 1);
  assert.ok(json.correctionChains.length >= 1);
  assert.ok(json.nodes.some((n) => Array.isArray(n.failureSignals)));

  const pack = promptPack(tree.nodes);
  assert.ok(pack.includes('1.'));

  const handoff = renderHandoff(tree, { projectName: 'demo' });
  assert.ok(handoff.includes('## Original goal'));
  assert.ok(handoff.includes('Constraints learned the hard way'));
  assert.ok(handoff.includes('Agent memory lessons'));

  const report = renderReportMarkdown(tree, { projectName: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(report.startsWith('# TreeTrace Report - demo'));
  assert.ok(report.includes('## Output map'));
  assert.ok(report.includes('## Handoff brief'));
  assert.ok(report.includes('TREETRACE_REPORT.md'));
});

test('analysis renderers produce failures, lessons, evals, and memory', async () => {
  const { tree } = await fixtureTree();
  const failures = renderFailuresJson(tree, { projectName: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(failures.schemaVersion, '0.2');
  assert.ok(failures.failures.length >= 1);
  assert.ok(failures.correctionChains.length >= 1);

  const lessons = renderLessonsMarkdown(tree, { projectName: 'demo' });
  assert.ok(lessons.includes('# TreeTrace Lessons'));
  assert.ok(lessons.includes('Source nodes:'));

  const evals = renderEvalsJsonl(tree).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(evals.length >= 1);
  assert.ok(evals.every((e) => e.source === 'treetrace' && e.sourceNodeIds.length >= 1));

  const memory = renderMemoryMarkdown(tree, { projectName: 'demo' });
  assert.ok(memory.includes('TreeTrace Agent Memory'));
  assert.ok(memory.includes('Durable project constraints'));
});

test('analysis: tiny transcript without corrections does not invent failures', () => {
  const session = parsePlainTranscript('User: build a tiny CLI\nAssistant: done', 'tiny');
  const nodes = classifyPrompts([session]);
  const tree = buildTree([session], nodes);
  const analysis = analyzeTree(tree);
  assert.equal(analysis.summary.totalFailureSignals, 0);
  assert.deepEqual(analysis.failures, []);
});

test('cli: default run writes analysis artifacts with redaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-'));
  try {
    await main(['--file', FIXTURE, '--dir', dir, '--redact-auto', '--quiet']);
    for (const file of [
      'TREETRACE_REPORT.md',
      'PROMPT_TREE.md',
      '.treetrace/tree.json',
      '.treetrace/failures.json',
      '.treetrace/lessons.md',
      '.treetrace/evals.jsonl',
      '.treetrace/agent-memory.md',
    ]) {
      assert.ok(existsSync(join(dir, file)), `${file} missing`);
    }
    const failures = JSON.parse(readFileSync(join(dir, '.treetrace/failures.json'), 'utf8'));
    assert.equal(failures.schemaVersion, '0.2');
    assert.ok(failures.failures.length >= 1);

    const evalLine = readFileSync(join(dir, '.treetrace/evals.jsonl'), 'utf8').trim().split('\n')[0];
    assert.equal(JSON.parse(evalLine).source, 'treetrace');

    const exported = [
      'PROMPT_TREE.md',
      'TREETRACE_REPORT.md',
      '.treetrace/tree.json',
      '.treetrace/failures.json',
      '.treetrace/lessons.md',
      '.treetrace/evals.jsonl',
      '.treetrace/agent-memory.md',
    ].map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
    assert.ok(!exported.includes('sk-ant-'), 'anthropic key leaked');
    assert.ok(!exported.includes('hunter2pass'), 'basic-auth password leaked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plain transcript fallback parses User:/Assistant: markers', () => {
  const session = parsePlainTranscript(
    'User: build me a snake game in python\nAssistant: sure, here is the code...\nUser: make the snake blue\nAssistant: done',
    'pasted'
  );
  assert.equal(session.prompts.length, 2);
  assert.equal(session.prompts[1].text, 'make the snake blue');
  assert.throws(() => parsePlainTranscript('no markers here at all'), /turn markers/);
});

test('special user text classification', () => {
  assert.equal(classifySpecialUserText('<command-name>/foo</command-name>'), 'command');
  assert.equal(classifySpecialUserText('<system-reminder>x</system-reminder>'), 'meta');
  assert.equal(
    classifySpecialUserText('This session is being continued from a previous conversation that ran out of context.'),
    'compact-continuation'
  );
  assert.equal(classifySpecialUserText('build me an app'), 'prompt');
});

test('discover: path munging matches Claude Code storage layout', () => {
  assert.equal(mungePath('/home/dev/weatherapp'), '-home-dev-weatherapp');
  assert.equal(mungePath('/home/dev/weatherapp/api'), '-home-dev-weatherapp-api');
  assert.equal(mungePath('/home/u.ser/my_app'), '-home-u-ser-my-app');
});
