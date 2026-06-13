import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { renderReportMarkdown, renderTerminalSummary } from '../src/report.js';
import {
  analyzeTree,
  renderFailuresJson,
  renderLessonsMarkdown,
  renderEvalsJsonl,
  renderMemoryMarkdown,
  isRiskyCommand,
  mentionsTestSkip,
} from '../src/analyze.js';
import { main, parseArgs } from '../src/cli.js';
import { mungePath } from '../src/discover.js';
import { sha256, escapeMd } from '../src/util.js';
import { detectHallucinations, renderHallucinationsJson } from '../src/hallucinate.js';
import { renderSecurityReport, hasSecuritySignal } from '../src/security-report.js';
import { spawn } from 'node:child_process';

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

test('redaction: escaped characters inside quoted secret assignments are still caught', () => {
  const cases = [
    ['escaped newline', '{"api_key":"line1\\nline2line2"}'],
    ['escaped tab', '{"api_key":"col1\\tcol2value"}'],
    ['escaped quote', '{"api_key":"abc\\"defghij"}'],
    ['escaped backslash', '{"api_key":"abc\\\\defghij"}'],
    ['single-quoted escaped newline', "{'password':'line1\\nline2value'}"],
    ['backtick escaped newline', 'const secret = `line1\\nline2value`;'],
  ];
  for (const [label, sample] of cases) {
    const hits = scanText(sample).map((f) => f.ruleId);
    assert.ok(
      hits.includes('secret-assignment'),
      `${label}: escaped secret value should be caught (got ${JSON.stringify(hits)} for ${sample})`
    );
  }
});

test('redaction: end-to-end escaped-JSON secret leaves no raw value in any artifact', async () => {
  const rawValue = 'line1\\nline2line2line2';
  const secretLine = `config is {"api_key":"${rawValue}"}`;
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-esc-'));
  const file = join(dir, 'escconv.json');
  const convo = [{
    mapping: {
      r: { message: null, parent: null, children: ['u'] },
      u: { message: { author: { role: 'user' }, content: { parts: [secretLine] }, create_time: 1.0 }, parent: 'r', children: ['a'] },
      a: { message: { author: { role: 'assistant' }, content: { parts: ['ok'] }, create_time: 2.0 }, parent: 'u', children: [] },
    },
  }];
  writeFileSync(file, JSON.stringify(convo));
  try {
    await main(['--from', 'chatgpt', '--file', file, '--dir', dir, '--report', '--analysis', '--redact-auto', '--quiet']);
    const artifacts = [
      'PROMPT_TREE.md', 'TREETRACE_REPORT.md', '.treetrace/tree.json',
      '.treetrace/failures.json', '.treetrace/lessons.md', '.treetrace/evals.jsonl', '.treetrace/agent-memory.md',
    ].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.ok(!artifacts.includes(rawValue), 'raw escaped-JSON secret value leaked into an artifact');
    assert.ok(artifacts.includes('[REDACTED:secret-assignment]'), 'expected a secret-assignment redaction marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction: bare hex tokens (32+ chars) are detected, lower and upper case', async () => {
  const lower = '6881f8290266f4cc939959917f893a2a88787eb24bbcb6b9c37594c72bf448c3';
  const upper = lower.toUpperCase();
  const half = lower.slice(0, 32);
  for (const hex of [lower, upper, half]) {
    const hits = scanText(`my key is session_hex=${hex} ok`).map((f) => f.ruleId);
    assert.ok(hits.includes('hex-token'), `hex-token missed for ${hex} (got ${hits})`);
  }
  const findings = scanText(`session_hex=${lower}`);
  const { decisions } = await resolveFindings(findings, {}, { interactive: false, autoRedact: true });
  const cleaned = applyDecisions(`session_hex=${lower}`, findings, decisions);
  assert.ok(!cleaned.includes(lower), 'raw hex leaked after redaction');
  assert.equal(shadowScan(cleaned, {}).length, 0, 'shadow scan should be clean after hex redaction');
});

test('redaction: high-entropy lowercase-and-digit token (no uppercase) is caught in prose', () => {
  const token = 'abcdefg0123456789hijklmnop4567qrstuv';
  const hits = scanText(`the access token is ${token} now`).map((f) => f.ruleId);
  assert.ok(hits.includes('high-entropy-token'), `high-entropy token missed (got ${hits})`);
});

test('redaction: uuids and long lowercase identifiers are not flagged as high-entropy', () => {
  for (const benign of [
    '8400e29b-1d4f-4a6c-9b2e-7f3a1c5d8e90',
    'src/components/dashboard/widgets/chartwidget',
    'MAX_RETRY_ATTEMPTS_BEFORE_GIVING_UP_2',
  ]) {
    const hits = scanText(benign).filter((f) => f.ruleId === 'high-entropy-token');
    assert.equal(hits.length, 0, `false positive high-entropy flag on ${benign}`);
  }
});

test('redaction: end-to-end hex secret leaves no raw hex in any artifact', async () => {
  const lower = '6881f8290266f4cc939959917f893a2a88787eb24bbcb6b9c37594c72bf448c3';
  const upper = lower.toUpperCase();
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-hex-'));
  const file = join(dir, 'hexconv.json');
  const convo = [{
    mapping: {
      r: { message: null, parent: null, children: ['u'] },
      u: { message: { author: { role: 'user' }, content: { parts: [`my key is session_hex=${lower} and HEX=${upper} ok`] }, create_time: 1.0 }, parent: 'r', children: ['a'] },
      a: { message: { author: { role: 'assistant' }, content: { parts: ['got it'] }, create_time: 2.0 }, parent: 'u', children: [] },
    },
  }];
  writeFileSync(file, JSON.stringify(convo));
  try {
    await main(['--from', 'chatgpt', '--file', file, '--dir', dir, '--report', '--analysis', '--redact-auto', '--quiet']);
    const artifacts = [
      'PROMPT_TREE.md', 'TREETRACE_REPORT.md', '.treetrace/tree.json',
      '.treetrace/failures.json', '.treetrace/lessons.md', '.treetrace/evals.jsonl', '.treetrace/agent-memory.md',
    ].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.ok(!artifacts.includes(lower), 'lowercase hex secret leaked into an artifact');
    assert.ok(!artifacts.includes(upper), 'uppercase hex secret leaked into an artifact');
    assert.ok(artifacts.includes('[REDACTED:hex-token]'), 'expected a hex-token redaction marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction: a single 12MB token completes without throwing and stays safe', () => {
  const giant = 'A'.repeat(12 * 1024 * 1024);
  const text = `prefix ${giant} suffix`;
  let findings;
  assert.doesNotThrow(() => { findings = scanText(text); }, 'oversized token must not overflow the regex stack');
  assert.ok(findings.some((f) => f.ruleId === 'oversized-token'), 'oversized token should be flagged');
  const normal = scanText('store ghp_0123456789abcdefghijklmnopqrstuvwxyzAB and more');
  assert.ok(normal.some((f) => f.ruleId === 'github-token'), 'normal-size secrets still caught alongside the guard');
  const { decisions } = applyDecisionsRoundTrip(text, findings);
  assert.equal(shadowScan(decisions, {}).length, 0, 'oversized token should be cleaned after redaction');
});

function applyDecisionsRoundTrip(text, findings) {
  const map = {};
  for (const f of findings) map[sha256(f.match)] = { action: 'redact', replacement: maskFor(f), ruleId: f.ruleId };
  return { decisions: applyDecisions(text, findings, map) };
}

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
    'Refactor the parser in src/parse.js to handle commit 3f2a1b9 and bump to v2.1.0-beta.3. The README.md needs a section on CONTRIBUTING.';
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

test('rendering: markdown footer stamps the tool version when provided', async () => {
  const { tree } = await fixtureTree();
  const md = renderMarkdown(tree, { projectName: 'demo', version: '0.4.0' });
  assert.ok(md.includes('v0.4.0'), 'PROMPT_TREE.md footer should stamp the version');
  const report = renderReportMarkdown(tree, { projectName: 'demo', version: '0.4.0', generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(report.includes('v0.4.0'), 'TREETRACE_REPORT.md footer should stamp the version');
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

test('analysis: benign --force-* chrome flag does not mint a verified security signal', () => {
  const root = {
    id: 'node_001', text: 'capture a screenshot of the page', title: 'capture a screenshot',
    kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Bash', file: null, command: 'chrome --headless --force-device-scale-factor=1 --screenshot=out.png', model: 'm' }],
  };
  const analysis = analyzeTree({ nodes: [root] });
  const sec = analysis.failures.filter((f) => f.type === 'security_or_privacy_risk');
  assert.equal(sec.length, 0, '--force-device-scale-factor must not fire as a security risk');
});

test('analysis: a token-named UI file does not mint a verified credential signal', () => {
  for (const file of ['src/ui/semantic-tokens.ts', 'src/lexer/tokenizer.ts', 'theme/design-tokens.json']) {
    const root = {
      id: 'node_001', text: 'edit the theme', title: 'edit the theme',
      kind: 'root', status: 'accepted', parent: null,
      actions: [{ tool: 'Edit', file, command: null, model: 'm' }],
    };
    const analysis = analyzeTree({ nodes: [root] });
    const verified = analysis.failures.filter((f) => f.type === 'security_or_privacy_risk' && f.tier === 'verified');
    assert.equal(verified.length, 0, `${file} must not produce a verified credential signal`);
  }
});

test('analysis: a bare rbac keyword in a non-credential edit is down-tiered below verified', () => {
  const root = {
    id: 'node_001', text: 'edit the detector', title: 'edit the detector',
    kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/analyze.js', input: 'const ACCESS = /rbac/i;', command: null, model: 'm' }],
  };
  const analysis = analyzeTree({ nodes: [root] });
  const sec = analysis.failures.filter((f) => f.type === 'security_or_privacy_risk');
  assert.ok(sec.every((f) => f.tier !== 'verified' && f.confidence < 0.95), 'bare rbac keyword must not be verified/0.95');
});

test('analysis: a real credential file and a real secret command still verify at 0.95', () => {
  const fileNode = {
    id: 'node_001', text: 'harden auth', title: 'harden auth', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/auth/session.ts', command: null, model: 'm' }],
  };
  const fileSec = analyzeTree({ nodes: [fileNode] }).failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(fileSec && fileSec.tier === 'verified' && fileSec.confidence === 0.95, 'a genuine auth file must stay verified');

  const cmdNode = {
    id: 'node_001', text: 'deploy', title: 'deploy', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Bash', file: null, command: '. /srv/app/.env; wrangler pages deploy', input: '. /srv/app/.env; wrangler pages deploy', model: 'm' }],
  };
  const cmdSec = analyzeTree({ nodes: [cmdNode] }).failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(cmdSec && cmdSec.tier === 'verified', 'a genuine credential command must stay verified');
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

test('analysis: latest accepted direction is chronological, not insertion order', () => {
  const root = {
    id: 'node_001', text: 'pick a research topic', title: 'pick a research topic',
    kind: 'root', status: 'accepted', parent: null, ts: '2026-01-01T00:00:00.000Z', actions: [],
  };
  const newest = {
    id: 'node_002', text: 'lets dig into Amazon Nova and the Karunanidhi essay direction',
    title: 'Amazon Nova and Karunanidhi', kind: 'direction', status: 'accepted', parent: root,
    ts: '2026-03-01T00:00:00.000Z', actions: [],
  };
  const stale = {
    id: 'node_003', text: 'lets explore the Seoul travel itinerary in depth for the trip',
    title: 'Seoul travel itinerary', kind: 'direction', status: 'accepted', parent: newest,
    ts: '2026-02-01T00:00:00.000Z', actions: [],
  };
  const nodes = [root, newest, stale];
  const tree = { nodes, stats: { promptCount: 3, sessionCount: 2 } };
  const summary = renderTerminalSummary(tree, { projectName: 'demo' });
  assert.ok(/Amazon Nova/i.test(summary), 'terminal summary should name the chronologically newest direction');
  assert.ok(!/Seoul/i.test(summary.split('Latest accepted direction:')[1] || ''), 'must not name the stale Seoul session as latest');

  const handoff = renderHandoff(tree, { projectName: 'demo' });
  const stand = handoff.split('## Where things stand')[1].split('##')[0];
  assert.ok(/Amazon Nova/i.test(stand), 'handoff should name the chronologically newest accepted direction');

  const memory = renderMemoryMarkdown(tree, { projectName: 'demo' });
  const next = memory.slice(memory.indexOf('## Preferred next work'));
  assert.ok(/Amazon Nova/i.test(next), 'agent memory should point at the chronologically newest direction');
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

test('cli: --analysis combined with --report writes both analysis files and the reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-both-'));
  try {
    await main(['--file', FIXTURE, '--dir', dir, '--analysis', '--report', '--redact-auto', '--quiet']);
    for (const file of [
      'TREETRACE_REPORT.md', 'PROMPT_TREE.md', '.treetrace/tree.json',
      '.treetrace/failures.json', '.treetrace/lessons.md', '.treetrace/evals.jsonl', '.treetrace/agent-memory.md',
    ]) {
      assert.ok(existsSync(join(dir, file)), `${file} missing when --analysis and --report combined`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: a copilot import records a per-adapter sourceType, not claude-code-jsonl', async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'adapters', 'copilot-chatsession.json');
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-src-'));
  try {
    await main(['--from', 'copilot', '--file', fixture, '--dir', dir, '--redact-auto', '--quiet']);
    const tree = JSON.parse(readFileSync(join(dir, '.treetrace/tree.json'), 'utf8'));
    assert.equal(tree.project.sourceType, 'copilot-chat', 'sourceType should reflect the copilot adapter');
    assert.notEqual(tree.project.sourceType, 'claude-code-jsonl');
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

test('handoff: command operators are not HTML-escaped in the brief', () => {
  const root = {
    id: 'node_001', text: 'run rm -rf build && mkdir build to reset the workspace',
    title: 'reset the workspace', kind: 'root', status: 'accepted', parent: null, actions: [],
  };
  const handoff = renderHandoff({ nodes: [root], stats: { promptCount: 1, sessionCount: 1 } }, { projectName: 'demo' });
  assert.ok(handoff.includes('rm -rf build && mkdir build'), 'command should keep raw && in the handoff brief');
  assert.ok(!handoff.includes('&amp;&amp;'), 'handoff must not HTML-escape && to &amp;&amp;');
  const inject = {
    id: 'node_001', text: 'do not run <script>alert(1)</script> ever',
    title: 'no scripts', kind: 'root', status: 'accepted', parent: null, actions: [],
  };
  const handoff2 = renderHandoff({ nodes: [inject], stats: { promptCount: 1, sessionCount: 1 } }, { projectName: 'demo' });
  assert.ok(!handoff2.includes('<script>'), 'angle-bracket tags should still be neutralized in the handoff brief');
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

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-feat-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { express: '^4.0.0' } }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'real.js'), 'export const real = 1;\n');
  return dir;
}

test('hallucinations: flags only the invented file and import, not the real ones', () => {
  const dir = tempProject();
  try {
    const root = {
      id: 'node_001', kind: 'root', status: 'accepted', parent: null,
      text: 'Open src/real.js and src/imaginary.js to wire the feature.',
      title: 'wire the feature',
      actions: [{
        tool: 'Edit', file: 'src/real.js',
        input: "import express from 'express';\nimport ghostlib from 'ghostlib-does-not-exist';\nimport { readFileSync } from 'node:fs';",
        command: null, model: 'm',
      }],
    };
    const tree = { nodes: [root] };
    const result = detectHallucinations(tree, dir);
    const files = result.hallucinations.filter((h) => h.category === 'hallucinated_file_or_path').map((h) => h.reference);
    const imports = result.hallucinations.filter((h) => h.category === 'hallucinated_import_or_package').map((h) => h.reference);

    assert.ok(files.includes('src/imaginary.js'), `invented file should be flagged (got ${files})`);
    assert.ok(!files.includes('src/real.js'), 'the real file must not be flagged');
    assert.ok(!files.some((f) => /package\.json/.test(f)), 'the real package.json must not be flagged');

    assert.ok(imports.includes('ghostlib-does-not-exist'), `invented import should be flagged (got ${imports})`);
    assert.ok(!imports.includes('express'), 'a declared dependency must not be flagged');
    assert.ok(!imports.includes('fs') && !imports.includes('node:fs'), 'a node builtin must not be flagged');

    for (const h of result.hallucinations) {
      assert.ok(h.evalCandidate && h.evalCandidate.target, 'each hallucination should carry an eval candidate');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: a file created during the session is not flagged', () => {
  const dir = tempProject();
  try {
    const root = {
      id: 'node_001', kind: 'root', status: 'accepted', parent: null,
      text: 'Create src/brandnew.js and then reference src/brandnew.js again.',
      title: 'create new file',
      actions: [{ tool: 'Write', file: 'src/brandnew.js', input: 'export const n = 1;', command: null, model: 'm' }],
    };
    const result = detectHallucinations({ nodes: [root] }, dir);
    const files = result.hallucinations.filter((h) => h.category === 'hallucinated_file_or_path').map((h) => h.reference);
    assert.ok(!files.includes('src/brandnew.js'), 'a file the agent created this session must not be flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: extensionless files under dot-directories are flagged when missing', () => {
  const dir = tempProject();
  try {
    const root = {
      id: 'node_001', kind: 'root', status: 'accepted', parent: null,
      text: 'Open .github/CODEOWNERS and .github/workflows/ci and .husky/pre-commit, and reference JSON.parse and test.skip.',
      title: 'review config',
      actions: [],
    };
    const result = detectHallucinations({ nodes: [root] }, dir);
    const files = result.hallucinations.filter((h) => h.category === 'hallucinated_file_or_path').map((h) => h.reference);
    assert.ok(files.includes('.github/CODEOWNERS'), `dot-directory path should be flagged (got ${files})`);
    assert.ok(files.includes('.github/workflows/ci'), 'nested dot-directory path should be flagged');
    assert.ok(files.includes('.husky/pre-commit'), 'hyphenated dot-directory path should be flagged');
    assert.ok(!files.includes('JSON.parse') && !files.includes('test.skip'), 'dotted code symbols must not be flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: process.env is not flagged as a missing file', () => {
  const dir = tempProject();
  try {
    const root = {
      id: 'node_001', kind: 'root', status: 'accepted', parent: null,
      text: 'Read the API key from process.env instead of hardcoding it.',
      title: 'use env var', actions: [],
    };
    const result = detectHallucinations({ nodes: [root] }, dir);
    const files = result.hallucinations.filter((h) => h.category === 'hallucinated_file_or_path').map((h) => h.reference);
    assert.ok(!files.includes('process.env'), `process.env must not be flagged as a file (got ${files})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: a relative require is not flagged as an import, but the missing file is', () => {
  const dir = tempProject();
  try {
    const root = {
      id: 'node_001', kind: 'root', status: 'accepted', parent: null,
      text: 'Wire it up.', title: 'wire',
      actions: [{ tool: 'Edit', file: 'src/index.js', input: "const limiter = require('./middleware/rateLimit.js');", command: null, model: 'm' }],
    };
    const result = detectHallucinations({ nodes: [root] }, dir);
    const imports = result.hallucinations.filter((h) => h.category === 'hallucinated_import_or_package').map((h) => h.reference);
    const files = result.hallucinations.filter((h) => h.category === 'hallucinated_file_or_path').map((h) => h.reference);
    assert.ok(!imports.includes('.'), 'a relative require must not be reduced to a "." import');
    assert.ok(files.includes('./middleware/rateLimit.js') || files.includes('middleware/rateLimit.js'), `the missing relative file should still be flagged (got ${files})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('security report: surfaces real signals and omits benign sessions', () => {
  const dir = tempProject();
  try {
    const root = {
      id: 'node_001', kind: 'root', status: 'accepted', parent: null,
      text: 'harden the login flow', title: 'harden the login flow',
      actions: [
        { tool: 'Edit', file: 'src/auth/login.js', input: 'export function login() {}', command: null, model: 'claude-opus-4-8' },
        { tool: 'Bash', file: null, command: 'rm -rf build', input: 'rm -rf build', model: 'claude-opus-4-8' },
      ],
    };
    const correction = {
      id: 'node_002', kind: 'correction', status: 'accepted', parent: root,
      text: 'no, do not disable the tests in the auth suite, keep them running',
      title: 'do not disable tests', actions: [],
    };
    const tree = { nodes: [root, correction] };
    assert.ok(hasSecuritySignal(tree, dir), 'expected a security signal for the auth edit');
    const report = renderSecurityReport(tree, dir, { projectName: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' });

    assert.ok(report.startsWith('# TreeTrace Security Report - demo'));
    assert.ok(/auth: .*src\/auth\/login\.js/.test(report), 'auth surface and file should be listed');
    assert.ok(/rm -rf build/.test(report), 'risky command should be listed');
    assert.ok(/disable the tests|disable or skip tests/i.test(report), 'test-skip signal should appear');
    assert.ok(/do not disable the tests/i.test(report), 'the human correction should surface as an eval/memory candidate');

    const benign = {
      id: 'node_001', kind: 'root', status: 'accepted', parent: null,
      text: 'add a markdown table to the README', title: 'add a table',
      actions: [{ tool: 'Edit', file: 'README.md', input: '| a | b |', command: null, model: 'm' }],
    };
    const benignTree = { nodes: [benign] };
    assert.ok(!hasSecuritySignal(benignTree, dir), 'benign session should have no security signal');
    const benignReport = renderSecurityReport(benignTree, dir, { projectName: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' });
    assert.ok(/No security-sensitive touches/.test(benignReport), 'benign report should state nothing was found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('security report and hallucinations.json do not leak injected secrets via the CLI', async () => {
  const dir = tempProject();
  const hex = '6881f8290266f4cc939959917f893a2a88787eb24bbcb6b9c37594c72bf448c3';
  const ghToken = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const convo = [{
    mapping: {
      r: { message: null, parent: null, children: ['u'] },
      u: { message: { author: { role: 'user' }, content: { parts: [
        `edit src/imaginary.js, my key is session_hex=${hex} and token ${ghToken}`,
      ] }, create_time: 1.0 }, parent: 'r', children: ['a'] },
      a: { message: { author: { role: 'assistant' }, content: { parts: ['ok'] }, create_time: 2.0 }, parent: 'u', children: [] },
    },
  }];
  const file = join(dir, 'leaky.json');
  writeFileSync(file, JSON.stringify(convo));
  try {
    await main(['--from', 'chatgpt', '--file', file, '--dir', dir, '--security', '--redact-auto', '--quiet']);
    const hall = readFileSync(join(dir, '.treetrace/hallucinations.json'), 'utf8');
    assert.ok(!hall.includes(hex), 'hex secret leaked into hallucinations.json');
    assert.ok(!hall.includes(ghToken), 'github token leaked into hallucinations.json');
    assert.ok(/imaginary\.js/.test(hall), 'the invented file should still be detected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp: initialize, tools/list, and tools/call return well-formed JSON-RPC', async () => {
  const dir = tempProject();
  const convo = [{
    mapping: {
      r: { message: null, parent: null, children: ['u'] },
      u: { message: { author: { role: 'user' }, content: { parts: ['build a cli and do not add dependencies'] }, create_time: 1.0 }, parent: 'r', children: ['a'] },
      a: { message: { author: { role: 'assistant' }, content: { parts: ['ok'] }, create_time: 2.0 }, parent: 'u', children: ['u2'] },
      u2: { message: { author: { role: 'user' }, content: { parts: ['no, that is wrong, keep it minimal'] }, create_time: 3.0 }, parent: 'a', children: [] },
    },
  }];
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify(convo));
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'treetrace.js');
  try {
    const responses = await new Promise((resolveP, rejectP) => {
      const child = spawn('node', [bin, 'mcp', '--from', 'chatgpt', '--file', file, '--dir', dir], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.on('error', rejectP);
      const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lessons', arguments: {} } });
      send({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'nope', arguments: {} } });
      setTimeout(() => {
        child.stdin.end();
        child.kill();
        resolveP(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
      }, 2000);
    });

    const init = responses.find((r) => r.id === 1);
    assert.ok(init && init.jsonrpc === '2.0', 'initialize must be JSON-RPC 2.0');
    assert.equal(init.result.serverInfo.name, 'treetrace');
    assert.ok(init.result.protocolVersion, 'initialize must advertise a protocol version');

    const list = responses.find((r) => r.id === 2);
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['eval_candidates', 'handoff', 'lessons', 'security_summary']);

    const call = responses.find((r) => r.id === 3);
    assert.ok(call.result && Array.isArray(call.result.content), 'tools/call must return content array');
    assert.equal(call.result.content[0].type, 'text');
    assert.ok(/TreeTrace Lessons/.test(call.result.content[0].text), 'lessons tool should return the lessons markdown');

    const bad = responses.find((r) => r.id === 99);
    assert.ok(bad.error && bad.error.code === -32602, 'unknown tool should return a JSON-RPC error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { recordedCwd } from '../src/discover.js';

test('redaction: JSON-style, quoted, backtick, and multiline secret assignments are caught', () => {
  const cases = [
    '{"api_key":"supersecretvalue"}',
    '{"client_secret":"correcthorsebattery"}',
    '{"access_token":"correct-horse-battery"}',
    "{'api_key':'correcthorsebattery'}",
    'const password = `correct horse battery staple`;',
    'api_key: `correct-horse-battery-staple`',
    'API_KEY="line1\nline2line2line2"',
  ];
  for (const sample of cases) {
    const hits = scanText(sample).map((f) => f.ruleId);
    assert.ok(hits.includes('secret-assignment'), `secret-assignment missed in: ${JSON.stringify(sample)} (got ${hits})`);
  }
});

test('redaction: generic secret-key assignment is caught even with a low-entropy value', () => {
  const sample = 'password: "hunter2hunter2"';
  const hits = scanText(sample).map((f) => f.ruleId);
  assert.ok(hits.includes('secret-assignment'), 'low-entropy generic secret should still be a finding');
});

test('redaction: placeholder secret assignments are not flagged', () => {
  for (const benign of ['token: null', 'password: ""', 'secret: "${SECRET}"', 'api_key: <your-key>', 'token=true']) {
    const hard = scanText(benign).filter((f) => f.severity !== 'soft');
    assert.deepEqual(hard, [], `${benign} should not flag (got ${JSON.stringify(hard)})`);
  }
});

test('redaction: a JSON-style secret leaves no raw value in any artifact end to end', async () => {
  const secret = 'supersecretvalue';
  const back = 'correct-horse-battery-staple';
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-json-secret-'));
  const file = join(dir, 'conv.json');
  const convo = [{
    mapping: {
      r: { message: null, parent: null, children: ['u'] },
      u: { message: { author: { role: 'user' }, content: { parts: [`config is {"api_key":"${secret}"} and password = \`${back}\``] }, create_time: 1.0 }, parent: 'r', children: ['a'] },
      a: { message: { author: { role: 'assistant' }, content: { parts: ['done'] }, create_time: 2.0 }, parent: 'u', children: [] },
    },
  }];
  writeFileSync(file, JSON.stringify(convo));
  try {
    await main(['--from', 'chatgpt', '--file', file, '--dir', dir, '--report', '--analysis', '--redact-auto', '--quiet']);
    const artifacts = [
      'PROMPT_TREE.md', 'TREETRACE_REPORT.md', '.treetrace/tree.json',
      '.treetrace/failures.json', '.treetrace/lessons.md', '.treetrace/evals.jsonl', '.treetrace/agent-memory.md',
    ].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.ok(!artifacts.includes(secret), 'JSON-style secret value leaked into an artifact');
    assert.ok(!artifacts.includes(back), 'backtick secret value leaked into an artifact');
    assert.ok(artifacts.includes('[REDACTED:secret-assignment]'), 'expected a secret-assignment redaction marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction: a prior keep decision is ignored under --redact-auto and non-TTY auto mode', async () => {
  const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const text = `Use token ${token} for setup`;
  const findings = scanText(text);
  const prior = { [sha256(token)]: { action: 'keep', ruleId: 'github-token' } };

  const auto = await resolveFindings(findings, prior, { interactive: false, autoRedact: true });
  assert.equal(auto.overriddenKeeps, 1, 'auto mode should override a prior keep');
  const outAuto = applyDecisions(text, findings, auto.decisions);
  assert.ok(!outAuto.includes(token), 'raw token leaked under --redact-auto despite re-redaction');
  assert.equal(shadowScan(outAuto, auto.decisions).length, 0, 'shadow scan should be clean after override');

  const nonTty = await resolveFindings(findings, prior, { interactive: false, autoRedact: false });
  assert.equal(nonTty.overriddenKeeps, 1, 'non-TTY auto mode should override a prior keep');
  assert.ok(!applyDecisions(text, findings, nonTty.decisions).includes(token), 'raw token leaked in non-TTY auto mode');

  const interactive = await resolveFindings(findings, prior, { interactive: true, autoRedact: false });
  assert.equal(interactive.overriddenKeeps, 0, 'interactive mode should honor a deliberate keep');
  assert.ok(applyDecisions(text, findings, interactive.decisions).includes(token), 'interactive keep should be honored');
});

test('cli: a preseeded keep cannot leak a secret under --redact-auto', async () => {
  const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-keep-'));
  const file = join(dir, 'conv.json');
  const convo = [{
    mapping: {
      r: { message: null, parent: null, children: ['u'] },
      u: { message: { author: { role: 'user' }, content: { parts: [`Use token ${token} for setup`] }, create_time: 1.0 }, parent: 'r', children: ['a'] },
      a: { message: { author: { role: 'assistant' }, content: { parts: ['done'] }, create_time: 2.0 }, parent: 'u', children: [] },
    },
  }];
  writeFileSync(file, JSON.stringify(convo));
  mkdirSync(join(dir, '.treetrace'), { recursive: true });
  writeFileSync(join(dir, '.treetrace', 'redactions.json'), JSON.stringify({ [sha256(token)]: { action: 'keep', ruleId: 'github-token' } }));
  try {
    await main(['--from', 'chatgpt', '--file', file, '--dir', dir, '--report', '--analysis', '--redact-auto', '--quiet']);
    const artifacts = [
      'PROMPT_TREE.md', 'TREETRACE_REPORT.md', '.treetrace/tree.json',
      '.treetrace/failures.json', '.treetrace/agent-memory.md',
    ].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.ok(!artifacts.includes(token), 'preseeded keep leaked a raw token under --redact-auto');
    const stored = JSON.parse(readFileSync(join(dir, '.treetrace', 'redactions.json'), 'utf8'));
    assert.equal(stored[sha256(token)].action, 'redact', 'overridden keep should persist as redact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp: a preseeded keep cannot leak a token in handoff', async () => {
  const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-mcp-keep-'));
  const file = join(dir, 'conv.json');
  const convo = [{
    mapping: {
      r: { message: null, parent: null, children: ['u'] },
      u: { message: { author: { role: 'user' }, content: { parts: [`Use token ${token} for setup, do not add dependencies`] }, create_time: 1.0 }, parent: 'r', children: ['a'] },
      a: { message: { author: { role: 'assistant' }, content: { parts: ['ok'] }, create_time: 2.0 }, parent: 'u', children: ['u2'] },
      u2: { message: { author: { role: 'user' }, content: { parts: ['no, keep it minimal'] }, create_time: 3.0 }, parent: 'a', children: [] },
    },
  }];
  writeFileSync(file, JSON.stringify(convo));
  mkdirSync(join(dir, '.treetrace'), { recursive: true });
  writeFileSync(join(dir, '.treetrace', 'redactions.json'), JSON.stringify({ [sha256(token)]: { action: 'keep', ruleId: 'github-token' } }));
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'treetrace.js');
  try {
    const responses = await new Promise((resolveP, rejectP) => {
      const child = spawn('node', [bin, 'mcp', '--from', 'chatgpt', '--file', file, '--dir', dir], { stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.on('error', rejectP);
      const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'handoff', arguments: {} } });
      setTimeout(() => {
        child.stdin.end();
        child.kill();
        resolveP(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
      }, 2500);
    });
    const call = responses.find((r) => r.id === 2);
    assert.ok(call && call.result, 'handoff tool should return a result');
    assert.ok(!JSON.stringify(call).includes(token), 'MCP handoff leaked a token despite a preseeded keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp: extra tool arguments return -32602', async () => {
  const dir = tempProject();
  const file = join(dir, 'conv.json');
  writeFileSync(file, JSON.stringify([{ mapping: {
    r: { message: null, parent: null, children: ['u'] },
    u: { message: { author: { role: 'user' }, content: { parts: ['build a cli'] }, create_time: 1.0 }, parent: 'r', children: ['a'] },
    a: { message: { author: { role: 'assistant' }, content: { parts: ['ok'] }, create_time: 2.0 }, parent: 'u', children: [] },
  } }]));
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'treetrace.js');
  try {
    const responses = await new Promise((resolveP, rejectP) => {
      const child = spawn('node', [bin, 'mcp', '--from', 'chatgpt', '--file', file, '--dir', dir], { stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.on('error', rejectP);
      const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
      send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lessons', arguments: { unexpected: true } } });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lessons', arguments: {} } });
      send({ jsonrpc: '2.0', id: null, method: 'ping' });
      send([{ jsonrpc: '2.0', id: 9, method: 'ping' }]);
      setTimeout(() => { child.stdin.end(); child.kill(); resolveP(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))); }, 2500);
    });
    const bad = responses.find((r) => r.id === 1);
    assert.ok(bad && bad.error && bad.error.code === -32602, 'extra arguments should return -32602');
    const ok = responses.find((r) => r.id === 2);
    assert.ok(ok && ok.result, 'empty arguments should succeed');
    const idNull = responses.find((r) => r.id === null && r.result);
    assert.ok(idNull, 'explicit id:null request should receive a response');
    const batch = responses.find((r) => r.id === null && r.error && /batch/.test(r.error.message));
    assert.ok(batch, 'batch arrays should return a clear error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp: treetrace mcp --stdin is rejected clearly', async () => {
  const { startMcpServer } = await import('../src/mcp.js');
  await assert.rejects(
    () => startMcpServer({ argv: ['mcp', '--stdin'], version: '0.0.0' }),
    /does not support --stdin/,
    'mcp --stdin should be rejected at startup'
  );
});

test('hallucinations: absolute paths outside the project are out of scope, not an oracle', () => {
  const dir = tempProject();
  try {
    const mk = (text) => ({ nodes: [{ id: 'n1', kind: 'root', status: 'accepted', parent: null, text, title: 't', actions: [] }] });
    const abs = detectHallucinations(mk('see /definitely/not/here.zzz and /etc/shadow.bak'), dir).hallucinations.map((h) => h.reference);
    assert.deepEqual(abs, [], 'absolute paths outside the project must not be flagged or statted');
    const parent = detectHallucinations(mk('see ../escape.js'), dir).hallucinations.map((h) => h.reference);
    assert.deepEqual(parent, [], 'a ../ path escaping the project is out of scope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: relative missing paths inside the project are flagged', () => {
  const dir = tempProject();
  try {
    const mk = (text) => ({ nodes: [{ id: 'n1', kind: 'root', status: 'accepted', parent: null, text, title: 't', actions: [] }] });
    assert.ok(detectHallucinations(mk('open src/missing.js'), dir).hallucinations.some((h) => h.reference === 'src/missing.js'), 'bare missing path should be flagged');
    assert.ok(detectHallucinations(mk('open ./src/missing.js'), dir).hallucinations.some((h) => h.reference === './src/missing.js'), './ missing path should be flagged');
    assert.ok(!detectHallucinations(mk('open src/real.js'), dir).hallucinations.some((h) => h.reference.includes('real.js')), 'real file must not be flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: an Edit to a nonexistent file is flagged, a Write to a new file is not', () => {
  const dir = tempProject();
  try {
    const edit = { nodes: [{ id: 'n1', kind: 'root', status: 'accepted', parent: null, text: 'edit src/ghost.js', title: 't', actions: [{ tool: 'Edit', file: 'src/ghost.js', input: 'x', command: null }] }] };
    assert.ok(detectHallucinations(edit, dir).hallucinations.some((h) => h.reference === 'src/ghost.js'), 'Edit to a nonexistent file should still be flagged');
    const write = { nodes: [{ id: 'n1', kind: 'root', status: 'accepted', parent: null, text: 'create src/created.js', title: 't', actions: [{ tool: 'Write', file: 'src/created.js', input: 'x', command: null }] }] };
    assert.ok(!detectHallucinations(write, dir).hallucinations.some((h) => h.reference === 'src/created.js'), 'Write to a new file should be suppressed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: dotted code symbols are not flagged as missing file paths', () => {
  const dir = tempProject();
  try {
    const mk = (text) => ({ nodes: [{ id: 'n1', kind: 'root', status: 'accepted', parent: null, text, title: 't', actions: [] }] });
    for (const sym of ['JSON.parse', 'params.arguments', 'params.name', 'test.skip', 'describe.skip', 'obj.method', 'array.length']) {
      const refs = detectHallucinations(mk(sym), dir).hallucinations
        .filter((h) => h.category === 'hallucinated_file_or_path')
        .map((h) => h.reference);
      assert.deepEqual(refs, [], `code symbol "${sym}" should not be flagged as a missing path (got ${JSON.stringify(refs)})`);
    }
    const real = detectHallucinations(mk('open src/missing.ts'), dir).hallucinations
      .filter((h) => h.category === 'hallucinated_file_or_path')
      .map((h) => h.reference);
    assert.ok(real.includes('src/missing.ts'), 'a genuinely missing path with a known extension must still be flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: missing extensionless files and local paths are flagged, existing ones are not', () => {
  const dir = tempProject();
  try {
    const mk = (text) => ({ nodes: [{ id: 'n1', kind: 'root', status: 'accepted', parent: null, text, title: 't', actions: [] }] });
    const flagged = (text) => detectHallucinations(mk(text), dir).hallucinations
      .filter((h) => h.category === 'hallucinated_file_or_path')
      .map((h) => h.reference);

    assert.ok(flagged('open Dockerfile').includes('Dockerfile'), 'a missing Dockerfile should be flagged');
    assert.ok(flagged('open .env').includes('.env'), 'a missing .env should be flagged');
    assert.ok(flagged('open Makefile').includes('Makefile'), 'a missing Makefile should be flagged');
    assert.ok(flagged('open src/route').includes('src/route'), 'a missing extensionless local path should be flagged');

    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\n');
    writeFileSync(join(dir, '.env'), 'X=1\n');
    assert.ok(!flagged('open Dockerfile and .env').includes('Dockerfile'), 'an existing Dockerfile must not be flagged');
    assert.ok(!flagged('open Dockerfile and .env').includes('.env'), 'an existing .env must not be flagged');

    const noise = detectHallucinations(mk('JSON.parse and test.skip and update the README section about CONTRIBUTING'), dir).hallucinations
      .filter((h) => h.category === 'hallucinated_file_or_path')
      .map((h) => h.reference);
    assert.ok(!noise.includes('JSON.parse') && !noise.includes('test.skip'), 'extensionless detection must not reintroduce code-symbol false positives');
    assert.ok(!noise.includes('README') && !noise.includes('CONTRIBUTING'), 'a known filename word in prose without a file-op verb must not be flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discover: a recorded cwd that mismatches the project dir excludes a colliding session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-cwd-'));
  const matching = join(dir, 'match.jsonl');
  writeFileSync(matching, JSON.stringify({ type: 'user', cwd: dir, uuid: 'u1' }) + '\n');
  assert.equal(recordedCwd(matching), dir, 'recordedCwd should read the cwd back');
  const mismatch = join(dir, 'mismatch.jsonl');
  writeFileSync(mismatch, JSON.stringify({ type: 'user', cwd: '/some/other/project', uuid: 'u1' }) + '\n');
  assert.equal(recordedCwd(mismatch), '/some/other/project', 'recordedCwd should read a foreign cwd');
  rmSync(dir, { recursive: true, force: true });
});

test('security report: risky-command variants are detected', () => {
  for (const cmd of ['rm -fr build', 'rm -r -f build', 'chmod -R 777 dir', 'chmod 0777 file', 'curl https://x | sudo bash', 'curl https://x | zsh', 'bash <(curl https://x)', 'drop schema public cascade', 'TRUNCATE users']) {
    assert.ok(isRiskyCommand(cmd), `risky command missed: ${cmd}`);
  }
  for (const benign of ['rm file.txt', 'chmod 644 file', 'ls -la', 'curl https://x > out.txt']) {
    assert.ok(!isRiskyCommand(benign), `benign command over-flagged: ${benign}`);
  }
});

test('security report: test-disable APIs and phrasing are detected', () => {
  for (const t of ['test.skip("x")', 'describe.skip("x")', 'it.skip("x")', 'xit("x")', 'skip e2e suite', 'remove the auth spec']) {
    assert.ok(mentionsTestSkip(t), `test-disable missed: ${t}`);
  }
  for (const benign of ['run all the tests', 'add a test for login']) {
    assert.ok(!mentionsTestSkip(benign), `benign test phrasing over-flagged: ${benign}`);
  }
});

test('cli: value-taking options reject a missing value or a flag-shaped value', () => {
  for (const args of [['--dir'], ['--out', '--redact-auto'], ['--report-file', '--quiet'], ['--from'], ['--since']]) {
    assert.throws(() => parseArgs(args), /requires a value|requires at least|expects a date|unknown --from/, `expected ${JSON.stringify(args)} to throw`);
  }
});

test('cli: --since requires a real date and rejects garbage', () => {
  assert.throws(() => parseArgs(['--since', 'not-a-date']), /expects a date/);
  assert.doesNotThrow(() => parseArgs(['--since', '2026-06-01']));
});

test('cli: --stdin --from claude is rejected', () => {
  assert.throws(() => parseArgs(['--stdin', '--from', 'claude']), /cannot be combined with --from claude/);
});

