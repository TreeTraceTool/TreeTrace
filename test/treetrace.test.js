import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { sha256, escapeMd } from '../src/util.js';

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

test('redaction: whitespace-split secret below the length floor is caught', () => {
  const dirty = 'store key sk-ant-api03-AAAA BBBBCCCCDDDDEEEEFFFFGGGG into the vault';
  const findings = scanText(dirty);
  const hit = findings.find((f) => f.ruleId === 'anthropic-key');
  assert.ok(hit, `split anthropic-key missed: ${JSON.stringify(findings)}`);
  const masked = applyDecisions(dirty, findings, {
    [sha256(hit.match)]: { action: 'redact', replacement: '[REDACTED:anthropic-key]', ruleId: 'anthropic-key' },
  });
  assert.ok(!/sk-ant-api03-AAAA/.test(masked), `secret not redacted: ${masked}`);
  assert.equal(shadowScan(masked, {}).length, 0);
});

test('redaction: scan stays fast on long benign input (ReDoS guard)', () => {
  const big = 'http://' + 'a'.repeat(60000);
  const start = Date.now();
  scanText(big);
  assert.ok(Date.now() - start < 2000, 'scan should stay linear on long input');
});

test('redaction: benign text produces no high/medium findings', () => {
  const benign =
    'Refactor the parser in src/parse.js to handle commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a and bump to v2.1.0-beta.3. The README.md needs a section on CONTRIBUTING.';
  const hard = scanText(benign).filter((f) => f.severity !== 'soft');
  assert.deepEqual(hard, []);
});

test('escapeMd neutralizes HTML-sensitive characters', () => {
  assert.equal(escapeMd('a<script>b</script>&c>'), 'a&lt;script&gt;b&lt;/script&gt;&amp;c&gt;');
});

test('rendering escapes injection in project name and content', async () => {
  const { tree } = await fixtureTree();
  const md = renderMarkdown(tree, { projectName: 'x</summary></details><script>alert(1)</script>' });
  assert.ok(md.includes('# 🌳 Prompt Tree: x&lt;/summary&gt;&lt;/details&gt;&lt;script&gt;'), 'project name not escaped');
  assert.ok(!md.includes('Prompt Tree: x</summary>'), 'raw HTML in project name');
});

test('renderers: markdown, json, handoff are consistent and footer-credited', async () => {
  const { tree } = await fixtureTree();
  analyzeTree(tree);
  const md = renderMarkdown(tree, { projectName: 'demo' });
  assert.ok(md.startsWith('# 🌳 Prompt Tree: demo'));
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
  assert.ok(memory.includes('Constraints the user enforced'));
  assert.ok(!memory.includes('Keep TreeTrace local-first'));
});

test('analysis: tiny transcript without corrections does not invent failures', () => {
  const session = parsePlainTranscript('User: build a tiny CLI\nAssistant: done', 'tiny');
  const nodes = classifyPrompts([session]);
  const tree = buildTree([session], nodes);
  const analysis = analyzeTree(tree);
  assert.equal(analysis.summary.totalFailureSignals, 0);
  assert.deepEqual(analysis.failures, []);
});

test('analysis: a security-sensitive agent action produces a verified, model-attributed signal', () => {
  const root = {
    id: 'node_001', text: 'Add rate limiting to checkout', title: 'Add rate limiting to checkout',
    kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/auth/session.ts', command: null, model: 'claude-sonnet-4-6' }],
  };
  const correction = {
    id: 'node_002', text: 'check the existing auth flow first', title: 'check the existing auth flow first',
    kind: 'correction', status: 'accepted', parent: root, actions: [],
  };
  const analysis = analyzeTree({ nodes: [root, correction] });
  const sec = analysis.failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(sec, 'expected a verified security signal from the auth-file edit');
  assert.equal(sec.tier, 'verified');
  assert.equal(sec.model, 'claude-sonnet-4-6');
  assert.equal(sec.correctedByNodeId, 'node_002');
  assert.ok(sec.evidence.includes('session.ts'));
  assert.deepEqual(analysis.summary.models, ['claude-sonnet-4-6']);
  assert.ok(analysis.summary.tierCounts.verified >= 1);
});

test('analysis: a credential-handling Bash action produces a verified security signal', () => {
  const root = {
    id: 'node_001', text: 'deploy the marketing site', title: 'deploy the marketing site',
    kind: 'root', status: 'accepted', parent: null,
    actions: [{
      tool: 'Bash', file: null,
      command: 'set -a; . /srv/app/.env; export CLOUDFLARE_API_KEY="$DEPLOY_API_KEY"; wrangler pages deploy site',
      input: 'set -a; . /srv/app/.env; export CLOUDFLARE_API_KEY="$DEPLOY_API_KEY"; wrangler pages deploy site',
      model: 'claude-opus-4-8',
    }],
  };
  const analysis = analyzeTree({ nodes: [root] });
  const sec = analysis.failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(sec, 'expected a security signal from the credential-handling deploy');
  assert.equal(sec.tier, 'verified');
  assert.ok(/credential/.test(sec.evidence), 'evidence should name the credential kind');
  assert.ok(analysis.summary.tierCounts.verified >= 1);
});

test('analysis: a PAT-update prompt produces an inferred security signal even with no action', () => {
  const root = { id: 'node_001', text: 'build the cli', title: 'build the cli', kind: 'root', status: 'accepted', parent: null, actions: [] };
  const intent = {
    id: 'node_002', text: 'I updated the PAT in the master access ref doc', title: 'I updated the PAT',
    kind: 'direction', status: 'accepted', parent: root, actions: [],
  };
  const analysis = analyzeTree({ nodes: [root, intent] });
  const sec = analysis.failures.find((f) => f.type === 'security_or_privacy_risk' && f.firstSeenNodeId === 'node_002');
  assert.ok(sec, 'expected an inferred security signal from the PAT-update prompt');
  assert.equal(sec.tier, 'inferred');
  const memory = renderMemoryMarkdown({ nodes: [root, intent] });
  assert.ok(memory.includes('## Security-sensitive actions'), 'memory should list the security section');
  assert.ok(/stated intent/.test(memory), 'memory should tag the stated intent');
});

test('analysis: a long pasted spec listing security categories does not over-fire as intent', () => {
  const root = { id: 'node_001', text: 'build the cli', title: 'build the cli', kind: 'root', status: 'accepted', parent: null, actions: [] };
  const seed =
    'Here is the full product spec to read and react to. '.repeat(20) +
    'The detector flags when an agent changed auth logic, touched secrets, modified access control, or disabled tests. ' +
    'More pitch copy about water, compute, investors, and the cloud. '.repeat(20);
  const pitch = { id: 'node_002', text: seed, title: 'pasted spec', kind: 'checkpoint', status: 'accepted', parent: root, actions: [] };
  const analysis = analyzeTree({ nodes: [root, pitch] });
  const sec = analysis.failures.filter((f) => f.type === 'security_or_privacy_risk');
  assert.equal(sec.length, 0, 'a long pasted spec should not mint a stated-intent security signal');
});

test('analysis: the constraints section extracts directive requirements and never reports none when constraints exist', () => {
  const root = { id: 'node_001', text: 'build the cli', title: 'build the cli', kind: 'root', status: 'accepted', parent: null, actions: [] };
  const rule = {
    id: 'node_002',
    text: 'no em dashes and do not add inline code comments, and keep it Apache licensed',
    title: 'no em dashes', kind: 'direction', status: 'accepted', parent: root, actions: [],
  };
  const memory = renderMemoryMarkdown({ nodes: [root, rule] });
  const block = memory.slice(memory.indexOf('## Constraints the user enforced'), memory.indexOf('## Lessons'));
  assert.ok(/no em dashes/i.test(block), 'em-dash constraint should be listed');
  assert.ok(/inline code comments/i.test(block), 'inline-comment constraint should be listed');
  assert.ok(/apache/i.test(block), 'license constraint should be listed');
  assert.ok(!/No explicit constraints were flagged/.test(block), 'must not claim none when constraints exist');
});

test('analysis: a benign descriptive prompt with no directive yields no false constraints', () => {
  const root = { id: 'node_001', text: 'build the cli', title: 'build the cli', kind: 'root', status: 'accepted', parent: null, actions: [] };
  const benign = {
    id: 'node_002', text: 'I like where we stand so far and I think this looks good to me',
    title: 'looks good', kind: 'direction', status: 'accepted', parent: root, actions: [],
  };
  const memory = renderMemoryMarkdown({ nodes: [root, benign] });
  const block = memory.slice(memory.indexOf('## Constraints the user enforced'), memory.indexOf('## Lessons'));
  assert.ok(/No explicit constraints were flagged/.test(block), 'benign descriptive text should not mint constraints');
});

test('analysis: a destructive-then-recovery turn yields a known bad path and is not the preferred next work', () => {
  const root = { id: 'node_001', text: 'build the marketing deck', title: 'build the marketing deck', kind: 'root', status: 'accepted', parent: null, actions: [] };
  const direction = {
    id: 'node_002', text: 'Also you can send an agent out to develop these sections',
    title: 'send an agent out to develop these sections', kind: 'direction', status: 'accepted', parent: root, actions: [],
  };
  const mishap = {
    id: 'node_003', text: 'Also messed up the deck file in the P:/ it is gone I am sorry can you bring it back',
    title: 'Also messed up the deck file in the P:/ it is gone I am sorry can you bring it back',
    kind: 'direction', status: 'accepted', parent: direction,
    actions: [{ tool: 'Write', file: 'P:/deck/index.html' }],
  };
  const nodes = [root, direction, mishap];
  const analysis = analyzeTree({ nodes });
  const bad = analysis.failures.filter((f) => f.type === 'abandoned_path');
  assert.ok(bad.length >= 1, 'destructive-then-recovery should produce a bad-path entry');
  const memory = renderMemoryMarkdown({ nodes });
  const badBlock = memory.slice(memory.indexOf('## Known bad paths'), memory.indexOf('## Security-sensitive'));
  assert.ok(!/No abandoned paths were detected/.test(badBlock), 'must not claim no abandoned paths when a destructive event occurred');
  assert.ok(/recover|destructive/i.test(badBlock), 'bad-path entry should warn about the destructive event');
  const nextBlock = memory.slice(memory.indexOf('## Preferred next work'));
  assert.ok(!/messed up the deck/i.test(nextBlock), 'preferred next work must not parrot the apology turn');
  assert.ok(/develop these sections/i.test(nextBlock), 'preferred next work should point at the real forward direction');
});

test('analysis: a keyword-only correction stays in the inferred or confirmed tier, not verified', () => {
  const root = { id: 'node_001', text: 'build a dashboard', title: 'build a dashboard', kind: 'root', status: 'accepted', parent: null, actions: [] };
  const corr = { id: 'node_002', text: 'no, that is overbuilt, keep it minimal', title: 'no, that is overbuilt', kind: 'correction', status: 'accepted', parent: root, actions: [] };
  const analysis = analyzeTree({ nodes: [root, corr] });
  assert.ok(analysis.failures.length >= 1);
  assert.ok(analysis.failures.every((f) => f.tier !== 'verified'));
  assert.equal(analysis.summary.tierCounts.verified, 0);
});

test('analysis: a single benign prompt does not yield multiple failure types', () => {
  const root = {
    id: 'node_001', text: 'build the marketing deck', title: 'build the marketing deck',
    kind: 'root', status: 'accepted', parent: null, ts: '2026-06-12T14:00:00.000Z', actions: [],
  };
  const benign = {
    id: 'node_002', text: 'and slide an agent to make the decks mobile friendly too please',
    title: 'make the decks mobile friendly', kind: 'direction', status: 'accepted', parent: root,
    ts: '2026-06-12T14:52:00.000Z', actions: [],
  };
  const longPaste = {
    id: 'node_003',
    text: 'ok sounds good i agree. ' + 'do not overbuild it, it is too much, try again later if it keeps failing. '.repeat(40),
    title: 'long strategy paste', kind: 'checkpoint', status: 'accepted', parent: benign,
    ts: '2026-06-12T12:52:00.000Z', actions: [],
  };
  const analysis = analyzeTree({ nodes: [root, benign, longPaste] });
  const benignFailures = analysis.failures.filter((f) => f.firstSeenNodeId === 'node_002');
  assert.equal(benignFailures.length, 0, 'a benign request should not mint failures from wording alone');
  for (const id of ['node_001', 'node_002', 'node_003']) {
    const types = analysis.failures.filter((f) => f.firstSeenNodeId === id).map((f) => f.type);
    assert.ok(new Set(types).size <= 1, `node ${id} emitted multiple failure types: ${types.join(', ')}`);
  }
});

test('analysis: a corrector is never linked with an earlier timestamp than its failure', () => {
  const failure = {
    id: 'node_001', text: 'i do not see the deck, just the index file showing text',
    title: 'deck not rendering', kind: 'direction', status: 'accepted', parent: null,
    ts: '2026-06-12T14:06:20.000Z',
    actions: [{ tool: 'Edit', file: 'site/deck/index.html', command: null, input: null, model: 'claude-opus-4-8' }],
  };
  const earlier = {
    id: 'node_002', text: 'no that is wrong, the deck still does not work, redo it instead',
    title: 'still broken', kind: 'correction', status: 'accepted', parent: failure,
    ts: '2026-06-12T12:52:00.000Z',
    actions: [{ tool: 'Edit', file: 'site/deck/index.html', command: null, input: null, model: 'claude-opus-4-8' }],
  };
  const analysis = analyzeTree({ nodes: [failure, earlier] });
  const byId = { node_001: failure, node_002: earlier };
  for (const f of analysis.failures) {
    if (!f.correctedByNodeId) continue;
    const ft = new Date(byId[f.firstSeenNodeId].ts).getTime();
    const ct = new Date(byId[f.correctedByNodeId].ts).getTime();
    assert.ok(ct >= ft, `failure ${f.id} corrected by an earlier-timestamped node`);
  }
  for (const c of analysis.correctionChains) {
    const ft = new Date(byId[c.failureNodeId].ts).getTime();
    const ct = new Date(byId[c.correctionNodeId].ts).getTime();
    assert.ok(ct >= ft, `chain ${c.id} links a corrector that precedes its failure`);
    if (c.resolvedNodeId) {
      const rt = new Date(byId[c.resolvedNodeId].ts).getTime();
      assert.ok(rt >= ft, `chain ${c.id} resolves before its failure`);
    }
  }
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

test('cli: creates the output directory and .treetrace subdirectory when missing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'treetrace-'));
  const dir = join(base, 'does', 'not', 'exist', 'yet');
  try {
    assert.ok(!existsSync(dir), 'target dir should not exist before the run');
    await main(['--file', FIXTURE, '--dir', dir, '--redact-auto', '--quiet']);
    assert.ok(existsSync(join(dir, 'PROMPT_TREE.md')), 'PROMPT_TREE.md missing');
    assert.ok(existsSync(join(dir, '.treetrace', 'tree.json')), '.treetrace/tree.json missing');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('redaction: the literal phrase "security-risk" is not a false-positive secret', () => {
  for (const phrase of ['security-risk', 'skip the security-risk step']) {
    const hard = scanText(phrase).filter((f) => f.severity !== 'soft');
    assert.deepEqual(hard, [], `"${phrase}" should not match any secret rule (got ${JSON.stringify(hard)})`);
  }
});

test('redaction: a real-format GitHub token is caught', () => {
  const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const hits = scanText(`set the remote with ${token} now`).map((f) => f.ruleId);
  assert.ok(hits.includes('github-token'), `github-token missed (got ${hits})`);
});

test('redaction: a token inside a Bash action body is redacted end to end', async () => {
  const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const lines = [
    { type: 'summary', summary: 'wire up the remote', leafUuid: 'b3' },
    {
      parentUuid: null, isSidechain: false, type: 'user', userType: 'external', uuid: 'b1',
      sessionId: 'leak-001', timestamp: '2026-06-01T10:00:00.000Z', cwd: '/tmp/demo', gitBranch: 'main', version: '2.1.0',
      message: { role: 'user', content: 'Point the git remote at my fork.' },
    },
    {
      parentUuid: 'b1', isSidechain: false, type: 'assistant', uuid: 'b2', sessionId: 'leak-001',
      timestamp: '2026-06-01T10:00:30.000Z',
      message: {
        role: 'assistant', model: 'assistant-model', usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          { type: 'text', text: 'Setting the remote.' },
          { type: 'tool_use', id: 'g1', name: 'Bash', input: { command: `git push --force origin main && git remote set-url origin https://x:${token}@github.com/me/fork.git` } },
        ],
      },
    },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-leak-'));
  const session = join(dir, 'session.jsonl');
  writeFileSync(session, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    const parsed = await parseSessionFile(session, { sessionId: 'leak-001' });
    const action = parsed.prompts[0].actions.find((a) => a.tool === 'Bash');
    assert.ok(action, 'expected a captured Bash action');
    assert.ok(action.command.includes(token), 'fixture should carry the raw token before redaction');
    assert.ok(typeof action.input === 'string' && action.input.includes(token), 'input summary should carry the command');

    await main(['--file', session, '--dir', dir, '--redact-auto', '--quiet']);
    const exported = [
      'PROMPT_TREE.md', 'TREETRACE_REPORT.md', '.treetrace/tree.json',
      '.treetrace/failures.json', '.treetrace/lessons.md', '.treetrace/evals.jsonl', '.treetrace/agent-memory.md',
    ].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.ok(!exported.includes(token), 'GitHub token leaked from an action body into output');
    assert.ok(!/ghp_[0-9A-Za-z]/.test(exported), 'a partial GitHub token prefix leaked from an action body into output');
    assert.ok(exported.includes('[REDACTED:'), 'expected a redaction marker where the action-body token was');
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
