import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSessionFile, parsePlainTranscript, classifySpecialUserText } from '../src/parse.js';
import { classifyPrompts } from '../src/extract.js';
import { buildTree } from '../src/tree.js';
import { scanText, applyDecisions, shadowScan, maskFor, resolveFindings, isGitShaCandidate, patchResiduals } from '../src/redact.js';
import { renderMarkdown, promptPack } from '../src/render-md.js';
import { renderMermaid, isSummaryByDefault, SUMMARY_NODE_THRESHOLD } from '../src/render-mermaid.js';
import { renderJson } from '../src/render-json.js';
import { renderHandoff } from '../src/handoff.js';
import { renderReportMarkdown, renderTerminalSummary } from '../src/report.js';
import {
  analyzeTree,
  renderFailuresJson,
  renderRejectionsJson,
  renderLessonsMarkdown,
  renderEvalsJsonl,
  renderMemoryMarkdown,
  isRiskyCommand,
  mentionsTestSkip,
  SECURITY_INTENT_PARTS,
  RISKY_CMD_PARTS,
} from '../src/analyze.js';
import { main, parseArgs, wrapMermaidDoc } from '../src/cli.js';
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

test('redaction: git object hashes are classified as candidates only in a git context', () => {
  const sha1 = '0123456789abcdef0123456789abcdef01234567';
  const sha256hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  assert.ok(isGitShaCandidate(sha1, `commit ${sha1}`, 7), 'commit <sha1> should be a candidate');
  assert.ok(isGitShaCandidate(sha256hex, `git tree ${sha256hex}`, 9), 'git tree <sha256> should be a candidate');
  assert.ok(isGitShaCandidate(sha1, `${sha1} fix the parser\n`, 0), 'oneline sha should be a candidate');
  assert.ok(!isGitShaCandidate(sha1, `token=${sha1} end`, 6), 'token= context is not git');
  assert.ok(!isGitShaCandidate(sha256hex, `session_hex=${sha256hex}`, 12), 'session_hex= context is not git');
  assert.ok(!isGitShaCandidate('0123456789abcdef0123456789abcdef', `commit ${'0123456789abcdef0123456789abcdef'}`, 7), '32-hex is not a git object id');
});

test('redaction: --keep-git-shas keeps git hashes but stays fail-closed for other hex', async () => {
  const sha1 = '0123456789abcdef0123456789abcdef01234567';
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const text = `commit ${sha1}\nmy key is session_hex=${secret} ok`;
  const findings = scanText(text);
  const git = findings.find((f) => f.match === sha1);
  const sec = findings.find((f) => f.match === secret);
  assert.ok(git && git.gitShaCandidate, 'git sha must be flagged as a candidate');
  assert.ok(sec && !sec.gitShaCandidate, 'session_hex secret must NOT be a git candidate');

  const { decisions } = await resolveFindings(findings, {}, { interactive: false, autoRedact: true, keepGitShas: true });
  assert.equal(decisions[sha256(sha1)].action, 'keep', 'git object hash should be kept');
  assert.equal(decisions[sha256(sha1)].ruleId, 'git-commit-sha', 'kept under git-commit-sha rule');
  assert.equal(decisions[sha256(secret)].action, 'redact', 'non-git hex must still be redacted');

  const { decisions: d2 } = await resolveFindings(findings, {}, { interactive: false, autoRedact: true });
  assert.equal(d2[sha256(sha1)].action, 'redact', 'default must redact git sha too (fail-closed)');

  const cleaned = applyDecisions(text, findings, decisions);
  assert.ok(cleaned.includes(sha1), 'kept git sha should survive in output');
  assert.ok(!cleaned.includes(secret), 'non-git secret must be redacted');
  assert.equal(shadowScan(cleaned, decisions).length, 0, 'shadow scan must be clean after keep + redact');
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
  assert.ok(md.includes('# Prompt Tree: x&lt;/summary&gt;&lt;/details&gt;&lt;script&gt;'), 'project name not escaped');
  assert.ok(!md.includes('Prompt Tree: x</summary>'), 'raw HTML in project name');
});

test('renderers: markdown, json, handoff are consistent and footer-credited', async () => {
  const { tree } = await fixtureTree();
  analyzeTree(tree);
  const md = renderMarkdown(tree, { projectName: 'demo' });
  assert.ok(md.startsWith('# Prompt Tree: demo'));
  assert.ok(md.includes('## Goal'));
  assert.ok(md.includes('## Reusable Prompt Pack'));
  assert.ok(md.includes('[treetrace]'));

  const json = renderJson(tree, { projectName: 'demo' });
  assert.equal(json.schemaVersion, '0.3');
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
  assert.ok(handoff.includes('## Constraints'));
  assert.ok(handoff.includes('## Lessons'));

  const report = renderReportMarkdown(tree, { projectName: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(report.startsWith('# TreeTrace Report - demo'));
  assert.ok(report.includes('## Output map'));
  assert.ok(report.includes('## Artifacts'));
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
  assert.equal(failures.schemaVersion, '0.3');
  assert.ok(failures.failures.length >= 1);
  assert.ok(failures.correctionChains.length >= 1);

  const lessons = renderLessonsMarkdown(tree, { projectName: 'demo' });
  assert.ok(lessons.includes('# Lessons'));
  assert.ok(/\[node_\w+/.test(lessons), 'lessons should inline node ids in brackets');

  const evals = renderEvalsJsonl(tree).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(evals.length >= 1);
  assert.ok(evals.every((e) => e.source === 'treetrace' && e.sourceNodeIds.length >= 1));

  const memory = renderMemoryMarkdown(tree, { projectName: 'demo' });
  assert.ok(!memory.includes('TreeTrace Agent Memory'), 'H1 title removed in diet');
  assert.ok(memory.includes('## Constraints'), 'compact constraints header');
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
  assert.ok(memory.includes('## Security'), 'memory should list the security section');
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
  const block = memory.slice(memory.indexOf('## Constraints'), memory.indexOf('## Lessons'));
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
  // Diet spec: omit-if-empty; empty constraints section should not appear at all
  assert.ok(!memory.includes('## Constraints'), 'benign descriptive text should not mint constraints');
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
  const badBlock = memory.slice(memory.indexOf('## Bad paths'), memory.indexOf('## Security'));
  assert.ok(!/No abandoned paths were detected/.test(badBlock), 'must not claim no abandoned paths when a destructive event occurred');
  assert.ok(/recover|destructive/i.test(badBlock), 'bad-path entry should warn about the destructive event');
  const nextBlock = memory.slice(memory.indexOf('## Next'));
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
  const next = memory.slice(memory.indexOf('## Next'));
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
    assert.equal(failures.schemaVersion, '0.3');
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

    writeFileSync(join(dir, 'README.md'), '# demo\n');
    const benign = {
      id: 'node_001', kind: 'root', status: 'accepted', parent: null,
      text: 'add a markdown table to the README', title: 'add a table',
      actions: [{ tool: 'Edit', file: 'README.md', input: '| a | b |', command: null, model: 'm' }],
    };
    const benignTree = { nodes: [benign] };
    assert.ok(!hasSecuritySignal(benignTree, dir), 'benign session should have no security signal');
    const benignReport = renderSecurityReport(benignTree, dir, { projectName: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' });
    assert.ok(/None detected\./.test(benignReport), 'benign report should state nothing was found');
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

test('cli: structured exit codes for CI consumers', async () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'treetrace.js');
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn('node', [bin, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stderr }));
    });
  const empty = mkdtempSync(join(tmpdir(), 'treetrace-exit-'));
  try {
    const usage = await run(['--bogus']);
    assert.equal(usage.code, 2, `bad option should exit 2 (got ${usage.code}): ${usage.stderr}`);
    const nodata = await run(['--dir', empty]);
    assert.equal(nodata.code, 3, `nothing-to-trace should exit 3 (got ${nodata.code}): ${nodata.stderr}`);
  } finally {
    rmSync(empty, { recursive: true, force: true });
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
    assert.deepEqual(names, ['eval_candidates', 'handoff', 'lessons', 'rejections_summary', 'security_summary', 'tree']);

    const call = responses.find((r) => r.id === 3);
    assert.ok(call.result && Array.isArray(call.result.content), 'tools/call must return content array');
    assert.equal(call.result.content[0].type, 'text');
    assert.ok(/# Lessons/.test(call.result.content[0].text), 'lessons tool should return the lessons markdown');

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

test('regex decomposition: every RISKY_CMD named piece fires on its command family', () => {
  const compose = (parts) => new RegExp(parts.map((p) => `(?:${p.re.source})`).join('|'), 'i');
  const byName = new Map(RISKY_CMD_PARTS.map((p) => [p.name, p.re]));
  const positives = {
    rm_rf_combined: 'rm -rf build',
    rm_r_then_f: 'rm -r -f build',
    rm_f_then_r: 'rm -f -r build',
    chmod_world_writable: 'chmod -R 777 dir',
    curl_pipe_shell: 'curl https://x | sudo bash',
    shell_process_substitution: 'bash <(curl https://x)',
    no_verify: 'git commit --no-verify',
    force: 'git push --force',
    drop_table: 'DROP TABLE users',
    drop_schema: 'drop schema public cascade',
    truncate: 'TRUNCATE users',
  };
  for (const [name, cmd] of Object.entries(positives)) {
    const re = byName.get(name);
    assert.ok(re, `unknown piece ${name}`);
    assert.ok(re.test(cmd), `piece ${name} missed its command: ${cmd}`);
  }
  assert.equal(RISKY_CMD_PARTS.length, Object.keys(positives).length, 'piece count drifted');
  const composed = compose(RISKY_CMD_PARTS);
  for (const cmd of [...Object.values(positives), 'rm -fr /tmp', 'chmod 0777 f']) {
    assert.equal(composed.test(cmd), isRiskyCommand(cmd), `composed != isRiskyCommand for: ${cmd}`);
  }
  for (const benign of ['rm file.txt', 'chmod 644 file', 'ls -la', 'curl https://x > out.txt', '--force-with-lease']) {
    assert.equal(composed.test(benign), isRiskyCommand(benign), `benign mismatch: ${benign}`);
    assert.ok(!composed.test(benign), `benign over-flagged: ${benign}`);
  }
});

test('regex decomposition: every SECURITY_INTENT named piece fires on its phrasing family', () => {
  const compose = (parts) => new RegExp(parts.map((p) => `(?:${p.re.source})`).join('|'), 'i');
  const byName = new Map(SECURITY_INTENT_PARTS.map((p) => [p.name, p.re]));
  const positives = {
    credential_lifecycle: 'please rotate the api key',
    pat_lifecycle: 'the pat was rotated yesterday',
    email_change: 'change the email to a public contact',
    do_not_expose: 'never expose the token',
    expose_us: 'this could expose us',
    leak_list: 'audit for leak anything',
    audit_repos: 'do a full audit of the repo',
    commit_history_audit: 'the commit history needs an audit',
    relicensing: 'relicense the project to MIT',
    disable_tests: 'skip the auth test',
    access_control_change: 'tighten the auth flow',
  };
  for (const [name, phrase] of Object.entries(positives)) {
    const re = byName.get(name);
    assert.ok(re, `unknown piece ${name}`);
    assert.ok(re.test(phrase), `piece ${name} missed its phrase: ${phrase}`);
  }
  assert.equal(SECURITY_INTENT_PARTS.length, Object.keys(positives).length, 'piece count drifted');
  const composed = compose(SECURITY_INTENT_PARTS);
  for (const phrase of Object.values(positives)) assert.ok(composed.test(phrase), `composed missed: ${phrase}`);
  for (const benign of ['a normal sentence about the weather', 'use the api carefully', 'email me later']) {
    assert.ok(!composed.test(benign), `benign security phrasing over-flagged: ${benign}`);
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


// ---------------------------------------------------------------------------
// Labeling-accuracy fixes (proposal P1-P7) + negative-corpus release gate.
// ---------------------------------------------------------------------------

test('P7: short escaped-JSON secret values fail closed (redaction gate)', () => {
  // Escape-inflated character counts must never let a short escaped value slip the floor.
  const cases = [
    ['short escaped newline', '{"api_key":"a\\nz"}'],
    ['tiny escaped value', '{"api_key":"x\\ny"}'],
    ['escaped quote', '{"token":"a\\"b"}'],
    ['escaped backslash', '{"secret":"a\\\\b"}'],
    ['spec literal-\\n form', '{"api_key":"line1\\nline2line2line2"}'],
  ];
  for (const [label, sample] of cases) {
    const hits = scanText(sample).map((f) => f.ruleId);
    assert.ok(hits.includes('secret-assignment'), `${label}: escaped secret must be caught (got ${JSON.stringify(hits)})`);
  }
  // Must not over-fire on benign short non-escaped values or placeholders.
  assert.equal(scanText('{"api_key":"ab"}').length, 0, 'benign short value below floor must stay clean');
  assert.equal(scanText('{"api_key":"${SECRET}"}').filter((f) => f.ruleId === 'secret-assignment').length, 0, 'placeholder must stay clean');
});

test('P7: a short escaped-JSON secret leaves no raw value in any artifact end to end', async () => {
  const rawValue = 'a\\nz';
  const secretLine = `config is {"api_key":"${rawValue}"}`;
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-p7-'));
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
    assert.ok(!artifacts.includes(rawValue), 'raw short escaped-JSON secret leaked into an artifact');
    assert.ok(artifacts.includes('[REDACTED:secret-assignment]'), 'expected a secret-assignment redaction marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1: a single strong security signal stays verified at exactly 0.95', () => {
  const node = {
    id: 'node_001', text: 'harden auth', title: 'harden auth', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/auth/session.ts', command: null, model: 'm' }],
  };
  const sec = analyzeTree({ nodes: [node] }).failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(sec && sec.tier === 'verified' && sec.confidence === 0.95, 'strong anchor must remain verified/0.95');
});

test('P1: confidence is derived from corroboration and the contributing signals are in the evidence', () => {
  // Many independent signals (credential content + credential file + risky cmd + surface) vs one weak keyword.
  const strong = {
    id: 'node_001', text: 'deploy', title: 'deploy', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Bash', file: 'src/auth/session.ts', command: '. /srv/app/.env; rm -rf /tmp/x; chmod 777 /etc', input: '. /srv/app/.env; rm -rf /tmp/x; chmod 777 /etc', model: 'm' }],
  };
  const strongSec = analyzeTree({ nodes: [strong] }).failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.equal(strongSec.tier, 'verified');
  assert.ok(/signals:/.test(strongSec.evidence), 'evidence must list the contributing signals (auditable)');
  assert.ok(/strong credential content/.test(strongSec.evidence), 'evidence must name the strong credential signal');

  const weak = {
    id: 'node_001', text: 'edit detector', title: 'x', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/analyze.js', input: 'const ACCESS = /rbac/i;', command: null, model: 'm' }],
  };
  const weakSec = analyzeTree({ nodes: [weak] }).failures.find((f) => f.type === 'security_or_privacy_risk');
  // Derived: the lone-weak-keyword score must be strictly below the strong score.
  assert.ok(weakSec.confidence < strongSec.confidence, 'lone weak keyword must score below a multi-signal strong event');
});

test('P2: afterFailure does not link a corrector that precedes its failure when timestamps are missing', () => {
  // Ingestion ordinal (node id suffix) is the tiebreak: node_001 precedes node_002 in the stream.
  const failure = {
    id: 'node_002', text: 'the deck still does not render here', title: 'still broken', kind: 'direction', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'site/deck/index.html', command: null, input: null, model: 'm' }],
  };
  const earlier = {
    id: 'node_001', text: 'no that is wrong redo the deck here please', title: 'redo', kind: 'correction', status: 'accepted', parent: failure,
    actions: [{ tool: 'Edit', file: 'site/deck/index.html', command: null, input: null, model: 'm' }],
  };
  const analysis = analyzeTree({ nodes: [failure, earlier] });
  for (const f of analysis.failures) {
    if (!f.correctedByNodeId) continue;
    const fo = Number(/(\d+)$/.exec(f.firstSeenNodeId)[1]);
    const co = Number(/(\d+)$/.exec(f.correctedByNodeId)[1]);
    assert.ok(co >= fo, `failure ${f.id} corrected by an earlier-ordinal node`);
  }
});

test('P2: resolvedBy is null when no resolution ties back to the failure, instead of the temporally-nearest node', () => {
  const failure = {
    id: 'node_001', text: 'do not hardcode the database url into the config file please', title: 'no hardcoding', kind: 'correction', status: 'accepted', parent: null,
    ts: '2026-06-12T10:00:00.000Z', actions: [{ tool: 'Edit', file: 'config/db.ts', command: null, input: null, model: 'm' }],
  };
  const unrelatedLater = {
    id: 'node_002', text: 'now lets switch topics entirely and write the marketing landing copy', title: 'marketing', kind: 'direction', status: 'accepted', parent: failure,
    ts: '2026-06-12T11:00:00.000Z', actions: [{ tool: 'Edit', file: 'site/index.html', command: null, input: null, model: 'm' }],
  };
  const analysis = analyzeTree({ nodes: [failure, unrelatedLater] });
  for (const chain of analysis.correctionChains) {
    // The unrelated later node shares neither file nor surface token nor acceptance phrasing.
    assert.notEqual(chain.resolvedNodeId, 'node_002', 'must not resolve to an unrelated temporally-nearest node');
  }
});

test('P2: an explicit acceptance turn IS accepted as a resolution even with no shared evidence', () => {
  // The failure/correction share a file (so they link), but the acceptance turn shares
  // NOTHING structural with the failure -- only its acceptance phrasing can recover it as
  // the resolution. This proves the acceptance path, not temporal-nearest guessing.
  const failure = {
    id: 'node_001', text: 'the checkout total is off by a cent on tax rounding', title: 'rounding bug', kind: 'direction', status: 'accepted', parent: null,
    ts: '2026-06-12T10:00:00.000Z', actions: [{ tool: 'Edit', file: 'src/checkout/total.ts', command: null, input: null, model: 'm' }],
  };
  const correction = {
    id: 'node_002', text: 'no the checkout total rounding is still wrong, redo the total calc', title: 'still wrong', kind: 'correction', status: 'accepted', parent: failure,
    ts: '2026-06-12T10:30:00.000Z', actions: [{ tool: 'Edit', file: 'src/checkout/total.ts', command: null, input: null, model: 'm' }],
  };
  const accepted = {
    id: 'node_003', text: 'perfect, that works now', title: 'works', kind: 'direction', status: 'accepted', parent: correction,
    ts: '2026-06-12T11:00:00.000Z', actions: [{ tool: 'Edit', file: 'src/unrelated/widget.ts', command: null, input: null, model: 'm' }],
  };
  const analysis = analyzeTree({ nodes: [failure, correction, accepted] });
  // failure + correction share total.ts, so a chain forms; the acceptance turn (node_003)
  // shares no file/surface with the failure, so only its acceptance phrasing can recover it
  // as the resolution -- proving the acceptance path, not temporal-nearest guessing.
  assert.ok(
    analysis.correctionChains.some((c) => c.resolvedNodeId === 'node_003'),
    'the explicit acceptance turn should be recorded as the resolution'
  );
});

test('P3: a node that leaks a secret and runs a risky command surfaces both kinds', () => {
  const node = {
    id: 'node_001', text: 'deploy', title: 'deploy', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Bash', file: null, command: '. /srv/app/.env; rm -rf /var/data', input: '. /srv/app/.env; rm -rf /var/data', model: 'm' }],
  };
  const sec = analyzeTree({ nodes: [node] }).failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(/credential/.test(sec.evidence) && /risky-command/.test(sec.evidence), `both kinds must appear: ${sec.evidence}`);
});

test('P3: inferSignals can return multiple process kinds for a multi-class correction', () => {
  const root = { id: 'node_001', text: 'build a dashboard', title: 'x', kind: 'root', status: 'accepted', parent: null, actions: [] };
  const corr = {
    id: 'node_002', kind: 'correction', status: 'accepted', parent: root, actions: [],
    text: 'no, you ignored what i asked for and this is overbuilt, scrap the web app, keep it minimal',
    title: 'multi-class correction',
  };
  const analysis = analyzeTree({ nodes: [root, corr] });
  const types = new Set(analysis.failures.map((f) => f.type));
  assert.ok(types.size >= 2, `expected multiple process labels, got ${[...types].join(', ')}`);
});

test('P4: a bare rbac keyword with no co-signal stays inferred, never high/verified', () => {
  const node = {
    id: 'node_001', text: 'edit detector', title: 'x', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/analyze.js', input: 'const ACCESS_CONTROL_WEAK_RE = /rbac|access-control/i;', command: null, model: 'm' }],
  };
  const sec = analyzeTree({ nodes: [node] }).failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(sec && sec.tier === 'inferred', `lone weak keyword must be inferred (got ${sec && sec.tier})`);
});

test('P4: a bare rbac keyword WITH a security-surface co-signal earns high tier', () => {
  const node = {
    id: 'node_001', text: 'wire up access control', title: 'x', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/rbac/policy.ts', input: 'enable rbac for the route', command: null, model: 'm' }],
  };
  const sec = analyzeTree({ nodes: [node] }).failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(sec && (sec.tier === 'high' || sec.tier === 'verified'), `keyword + surface co-signal should tier up (got ${sec && sec.tier})`);
});

test('P6: a human security correction backstops a prior action that carried no security label', () => {
  const prior = {
    id: 'node_001', text: 'put the deploy config value directly into the deploy script', title: 'deploy config', kind: 'direction', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'deploy.sh', command: null, input: null, model: 'm' }],
  };
  const correction = {
    id: 'node_002', text: 'that is a secret, rotate that key and do not commit it to the deploy script', title: 'rotate', kind: 'correction', status: 'accepted', parent: prior,
    actions: [{ tool: 'Edit', file: 'deploy.sh', command: null, input: null, model: 'm' }],
  };
  const analysis = analyzeTree({ nodes: [prior, correction] });
  const sec = analysis.failures.find((f) => f.type === 'security_or_privacy_risk');
  assert.ok(sec, 'human security correction should backstop a missed security event');
  assert.equal(sec.tier, 'inferred', 'the backstop must be inferred only, never strong/verified');
  assert.ok(sec.confidence <= 0.7, 'the backstop confidence must stay low');
});

test('P6: the backstop never fabricates a strong/verified security label from prose alone', () => {
  const root = { id: 'node_001', text: 'build the cli', title: 'x', kind: 'root', status: 'accepted', parent: null, actions: [] };
  const correction = {
    id: 'node_002', text: 'never leak the api secret token again', title: 'no leaks', kind: 'correction', status: 'accepted', parent: root, actions: [],
  };
  const analysis = analyzeTree({ nodes: [root, correction] });
  const strongSec = analysis.failures.filter((f) => f.type === 'security_or_privacy_risk' && (f.tier === 'verified' || f.tier === 'high'));
  assert.equal(strongSec.length, 0, 'a human-correction backstop must never mint strong/verified labels');
});

// RELEASE GATE: the negative corpus must produce ZERO security/failure/hallucination false positives.
test('NEGATIVE CORPUS (release gate): benign inputs produce zero security/failure false positives', () => {
  const dir = tempProject();
  // Benign prompts that historically tripped keyword/substring/path false positives.
  const benign = [
    'capture a screenshot with chrome --headless --force-device-scale-factor=1 --screenshot=out.png',
    'edit src/ui/semantic-tokens.ts to adjust the design token palette',
    'update theme/design-tokens.json and src/lexer/tokenizer.ts for the new theme',
    'the access-control documentation mentions rbac as a concept; just explaining it in the readme',
    'we use JSON.parse and params.arguments and test.skip in the code, no changes needed',
    'add a token field to the response schema and document the bearer header format in the api guide',
    'rename the file from auth-helpers.md to authentication-notes.md in the docs folder',
    'the password strength meter component needs a tooltip, purely a UI label',
  ];
  try {
    // The benign corpus references real files; create them so any hallucination flag is a
    // genuine false positive rather than a correct missing-file detection.
    mkdirSync(join(dir, 'src', 'ui'), { recursive: true });
    mkdirSync(join(dir, 'src', 'lexer'), { recursive: true });
    mkdirSync(join(dir, 'theme'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'out.png'), 'x');
    writeFileSync(join(dir, 'src', 'ui', 'semantic-tokens.ts'), 'export const t = 1;\n');
    writeFileSync(join(dir, 'src', 'lexer', 'tokenizer.ts'), 'export const t = 1;\n');
    writeFileSync(join(dir, 'theme', 'design-tokens.json'), '{}');
    writeFileSync(join(dir, 'auth-helpers.md'), '# notes\n');
    writeFileSync(join(dir, 'authentication-notes.md'), '# notes\n');
    writeFileSync(join(dir, 'readme'), 'rbac is a concept\n');

    const nodes = benign.map((text, i) => ({
      id: `node_${String(i + 1).padStart(3, '0')}`,
      text, title: text.slice(0, 40), kind: i === 0 ? 'root' : 'direction',
      status: 'accepted', parent: null,
      ts: `2026-06-12T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
      // Benign UI/doc file edits, plus the chrome flag command.
      actions: i === 0
        ? [{ tool: 'Bash', file: null, command: 'chrome --headless --force-device-scale-factor=1 --screenshot=out.png', model: 'm' }]
        : i === 1 ? [{ tool: 'Edit', file: 'src/ui/semantic-tokens.ts', model: 'm' }]
        : i === 2 ? [{ tool: 'Edit', file: 'theme/design-tokens.json', model: 'm' }]
        : [],
    }));
    for (let k = 1; k < nodes.length; k++) nodes[k].parent = nodes[k - 1];

    const analysis = analyzeTree({ nodes: nodes.map((n) => ({ ...n })) });
    const secFps = analysis.failures.filter((f) => f.type === 'security_or_privacy_risk');
    assert.equal(secFps.length, 0, `negative corpus minted security false positives: ${JSON.stringify(secFps.map((f) => f.evidence))}`);

    const halluc = detectHallucinations({ nodes: nodes.map((n) => ({ ...n })) }, dir).hallucinations;
    assert.equal(halluc.length, 0, `negative corpus minted hallucination false positives: ${JSON.stringify(halluc.map((h) => h.reference))}`);

    // Redaction must not over-fire high/medium on benign prose.
    for (const text of benign) {
      const hi = scanText(text).filter((f) => f.severity === 'high' || f.severity === 'medium');
      assert.equal(hi.length, 0, `redaction over-fired on benign text "${text}": ${JSON.stringify(hi.map((f) => f.ruleId))}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mermaid: renders a branded flowchart with goal, result, and spine styling', async () => {
  const { tree } = await fixtureTree();
  const out = renderMermaid(tree, { projectName: 'weather-dashboard' });

  // Branded init theme leads, then the top-down flowchart and class scaffolding.
  assert.ok(out.startsWith("%%{init:"), 'must lead with a Mermaid init directive');
  assert.match(out, /'background':'#0B1210'/, 'dark Bark canvas background');
  assert.match(out, /'edgeLabelBackground':'#0B1210'/, 'opaque edge-label backing for legibility');
  assert.match(out, /JetBrains Mono/, 'JetBrains Mono brand font');
  assert.match(out, /^flowchart TD$/m, 'declares a top-down flowchart');
  assert.match(out, /classDef spine fill:#121A17,stroke:#0CA08A/, 'brand spine class (teal)');
  assert.match(out, /classDef abandoned [^\n]*stroke:#34493F[^\n]*stroke-dasharray/, 'Branch-Dim dashed abandoned class');
  assert.match(out, /classDef failure [^\n]*stroke:#F0B86A/, 'amber failure class');

  // Goal = root, stadium-shaped and annotated; result annotated; both on the spine.
  assert.match(out, /N001\(\["GOAL: /, 'root node is a stadium labelled GOAL');
  assert.match(out, /class N001 [^\n]*goal/, 'root carries the goal class');
  assert.match(out, /RESULT: /, 'a result node is annotated');
  assert.match(out, /class \w+ [^\n]*result/, 'a node carries the result class');
  assert.match(out, /\(\["RESULT: /, 'the result node is a stadium terminal');

  // Spine links are tinted Canopy and thickened.
  assert.match(out, /class N001 [^\n]*spine/, 'root is on the spine');
  assert.match(out, /linkStyle [\d,]+ stroke:#5BF0B8,stroke-width:2\.5px;/, 'spine links are Canopy-tinted');

  // Edges carry relationship labels from the tree, including the correction.
  assert.match(out, /N001 -->\|refines\| N002/, 'root refines into the first direction');
  assert.match(out, /-->\|corrects\| /, 'correction edge labelled');

  // Node-declaration lines must not leak raw angle brackets into labels (entity-encoded).
  const labelLines = out.split('\n').filter((l) => /^  (N\w+|A\d+|S\d+)(\[|\(\[|\{\{)"/.test(l));
  assert.ok(labelLines.length >= 4, 'each prompt is declared as a node');
  for (const line of labelLines) {
    const label = line.match(/"([^"]*)"/)[1];
    assert.ok(!/[<>]/.test(label.replace(/&lt;|&gt;/g, '')), `unescaped angle bracket in label: ${line}`);
  }
});

test('mermaid: labels truncate on a word boundary, never mid-word', () => {
  const root = {
    id: 'node_001', kind: 'root', status: 'accepted', parent: null, actions: [],
    title: 'Build a resilient weather dashboard with hourly forecast charts and radar layers everywhere',
    text: 'Build a resilient weather dashboard with hourly forecast charts and radar layers everywhere',
  };
  const out = renderMermaid({ nodes: [root] }, { projectName: 'demo' });
  const label = out.match(/N001\(\["GOAL: ([^"]*)"\]\)/)[1];
  assert.ok(label.endsWith('…'), `label should end with a single-char ellipsis: ${label}`);
  // The character before the ellipsis must be a full word, not a cut-off fragment: the
  // visible body (sans ellipsis) is a prefix of the source ending at a word in the source.
  const body = label.slice(0, -1);
  assert.ok(/\w$/.test(body), 'body ends on a word character (no trailing space)');
  assert.ok(root.title.startsWith(body), 'body is a clean prefix of the source');
  assert.ok(/(^|\s)$/.test(root.title.slice(body.length, body.length + 1)) || root.title.length === body.length,
    `truncation landed mid-word: "${body}|${root.title.slice(body.length, body.length + 8)}"`);
});

test('mermaid: abandoned branches render as dimmed dotted detours off the spine', () => {
  // Synthetic tree: root -> good direction -> result; root -> abandoned detour.
  const mk = (id, kind, title, status) => ({
    id,
    kind,
    title,
    text: title,
    status: status || 'accepted',
    ts: `2026-06-01T10:0${id.slice(-1)}:00.000Z`,
    parent: null,
    actions: [],
  });
  const root = mk('node_001', 'root', 'Build the thing');
  const good = mk('node_002', 'direction', 'Refine the good approach');
  const result = mk('node_003', 'direction', 'Ship the chosen design');
  const dead = mk('node_004', 'direction', 'Try a heavy approach we drop', 'abandoned');
  good.parent = root;
  result.parent = good;
  dead.parent = root;
  const tree = { nodes: [root, good, result, dead] };

  const out = renderMermaid(tree, { projectName: 'demo' });

  // Abandoned node is classed abandoned (not spine) and its edge is dotted.
  assert.match(out, /class N004 abandoned;/, 'abandoned node carries only the abandoned class');
  assert.ok(!/class N004 [^\n]*spine/.test(out), 'abandoned node is not on the spine');
  assert.match(out, /N001 -\.->\|refines\| N004/, 'abandoned branch uses a dotted edge');

  // Live nodes stay on the spine; the dotted detour edge is excluded from spine linkStyle.
  assert.match(out, /class N002 [^\n]*spine/, 'good direction on spine');
  assert.match(out, /class N003 [^\n]*result/, 'last live direction is the result');
  // Spine links are the two live edges (indexes 0 and 1), not the abandoned edge (index 2).
  assert.match(out, /linkStyle 0,1 stroke/, 'only live edges are thickened');
});

test('mermaid: wrapMermaidDoc emits a fenced mermaid block that renders on GitHub', () => {
  const doc = wrapMermaidDoc('flowchart TD\n  N001["x"]', 'demo');
  assert.ok(doc.includes('```mermaid\n'), 'opens a mermaid fence');
  assert.ok(doc.trimEnd().endsWith('```'), 'closes the fence');
  assert.ok(doc.includes('flowchart TD'), 'contains the diagram');
  const summaryDoc = wrapMermaidDoc('flowchart TD\n  N001["x"]', 'demo', true);
  assert.match(summaryDoc, /count stubs/, 'summary doc explains the folding');
  assert.match(summaryDoc, /--full/, 'summary doc points at --full to expand');
});

// Build a linear live spine of `liveDirections` direction nodes off a root, with a small
// abandoned detour, so we can exercise the summary collapse deterministically.
function bigTree(liveDirections, withAbandoned = true) {
  const nodes = [];
  const root = {
    id: 'node_001', kind: 'root', status: 'accepted', parent: null, actions: [],
    title: 'Build the whole product', text: 'Build the whole product',
    ts: '2026-06-01T10:00:00.000Z',
  };
  nodes.push(root);
  let prev = root;
  for (let k = 2; k <= liveDirections + 1; k++) {
    // Alternate direction (strategic, kept) with checkpoint (routine, folded).
    const kind = k % 3 === 0 ? 'checkpoint' : 'direction';
    const n = {
      id: `node_${String(k).padStart(3, '0')}`, kind, status: 'accepted', parent: prev,
      title: `Strategic move number ${k} in the plan`, text: `Strategic move number ${k} in the plan`,
      ts: `2026-06-01T10:${String(k).padStart(2, '0')}:00.000Z`, actions: [],
    };
    nodes.push(n);
    prev = n;
  }
  if (withAbandoned) {
    const dead1 = {
      id: 'node_900', kind: 'direction', status: 'abandoned', parent: root, actions: [],
      title: 'Heavy approach we dropped', text: 'Heavy approach we dropped',
      ts: '2026-06-01T10:05:00.000Z',
    };
    const dead2 = {
      id: 'node_901', kind: 'direction', status: 'abandoned', parent: dead1, actions: [],
      title: 'Follow-up on the dropped approach', text: 'Follow-up on the dropped approach',
      ts: '2026-06-01T10:06:00.000Z',
    };
    nodes.push(dead1, dead2);
  }
  return { nodes };
}

test('mermaid: small trees render in full, large trees auto-summarize', () => {
  const small = bigTree(4);
  assert.equal(isSummaryByDefault(small), false, 'a 5-live-node tree renders in full');
  const smallOut = renderMermaid(small, { projectName: 'demo' });
  // Every live node is declared individually in full mode (N004 is a plain box).
  assert.match(smallOut, /N004\[/, 'full mode declares each live node');
  assert.ok(!/\d+ steps"/.test(smallOut), 'full mode has no count stubs');

  const big = bigTree(SUMMARY_NODE_THRESHOLD + 5);
  assert.equal(isSummaryByDefault(big), true, 'over the threshold auto-summarizes');
  const bigOut = renderMermaid(big, { projectName: 'demo' });
  assert.match(bigOut, /^flowchart TD$/m, 'summary is still a valid flowchart');
  assert.match(bigOut, /\(\["GOAL: /, 'GOAL stadium preserved in summary');
  assert.match(bigOut, /RESULT: /, 'RESULT preserved in summary');
  // Routine intermediate steps fold into count stubs; the summary is smaller than full.
  assert.match(bigOut, /\d+ steps?"/, 'routine steps fold into a count stub');
  const fullOut = renderMermaid(big, { projectName: 'demo', full: true });
  assert.ok(bigOut.split('\n').length < fullOut.split('\n').length, 'summary is more compact than full');
  assert.match(fullOut, /N0\d\d\[/, 'forcing --full declares each node even on a big tree');
});

test('mermaid: summary folds abandoned branches into one dim count stub', () => {
  const big = bigTree(SUMMARY_NODE_THRESHOLD + 3, true);
  const out = renderMermaid(big, { projectName: 'demo', summary: true });
  // The two-node abandoned subtree collapses to a single "2 abandoned steps" stub.
  assert.match(out, /A\d+\["2 abandoned steps"\]/, 'abandoned subtree folds into a counted stub');
  assert.match(out, /class A\d+ abandoned;/, 'the stub keeps the dim abandoned class');
  // The individual abandoned node ids are not declared in the summary.
  assert.ok(!/N900\[/.test(out) && !/N901\[/.test(out), 'individual abandoned nodes are not drawn');
  // Word-boundary truncation still applies to kept labels.
  assert.ok(!/[A-Za-z]…[A-Za-z]/.test(out), 'no mid-word ellipsis in any label');
});

test('mermaid: --summary forces summary mode even on a small tree', () => {
  const small = bigTree(3);
  const forced = renderMermaid(small, { projectName: 'demo', summary: true });
  // Forcing summary on a tiny tree still produces a valid flowchart with the GOAL/RESULT.
  assert.match(forced, /^flowchart TD$/m, 'forced summary is a valid flowchart');
  assert.match(forced, /\(\["GOAL: /, 'forced summary keeps the GOAL');
});

test('cli: --graph writes PROMPT_TREE_GRAPH.md with a mermaid flowchart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-graph-'));
  try {
    await main(['--file', FIXTURE, '--dir', dir, '--graph', '--redact-auto', '--quiet']);
    const p = join(dir, 'PROMPT_TREE_GRAPH.md');
    assert.ok(existsSync(p), 'PROMPT_TREE_GRAPH.md must be written');
    const text = readFileSync(p, 'utf8');
    assert.ok(text.includes('```mermaid'), 'contains a mermaid fence');
    assert.ok(text.includes('flowchart TD'), 'contains a flowchart');
    assert.ok(/GOAL: /.test(text), 'annotates the goal');
    // Redaction gate still holds: the planted secret must not leak into the graph.
    assert.ok(!text.includes('sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE1234'), 'secret stays redacted');
    assert.ok(!text.includes('hunter2pass'), 'embedded credential stays redacted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- v0.3 rejection / refusal / decline capture ---
// Fixture: test/fixtures/claude-code-rejections.jsonl
// All six rejection classes represented in one Claude Code JSONL session.

const REJECTIONS_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-code-rejections.jsonl');

async function loadRejectionsFixture() {
  return parseSessionFile(REJECTIONS_FIXTURE, { sessionId: 'rejections-fixture' });
}

test('rejections: user_declined_tool captured from canonical tool_result text', async () => {
  const session = await loadRejectionsFixture();
  const all = session.prompts.flatMap((p) => p.rejections || []);
  const declined = all.filter((r) => r.kind === 'user_declined_tool');
  assert.equal(declined.length, 1, 'one user_declined_tool must be captured');
  assert.equal(declined[0].source, 'tool_result');
  assert.equal(declined[0].confidence, 1.0);
  assert.equal(declined[0].toolUseId, 'toolu-0001');
  assert.ok(declined[0].evidence && declined[0].evidence.includes("doesn't want to proceed"));
});

test('rejections: user_interrupt typed as a rejection AND counter still increments', async () => {
  const session = await loadRejectionsFixture();
  assert.ok(session.stats.interruptions >= 1, 'interruption counter must still increment');
  const interrupts = session.prompts.flatMap((p) => p.rejections || []).filter((r) => r.kind === 'user_interrupt');
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].confidence, 1.0);
  assert.equal(interrupts[0].source, 'text');
});

test('rejections: tool_execution_error captured from is_error tool_result', async () => {
  const session = await loadRejectionsFixture();
  const errs = session.prompts.flatMap((p) => p.rejections || []).filter((r) => r.kind === 'tool_execution_error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].toolUseId, 'toolu-0003');
  assert.ok(errs[0].evidence.includes('cannot create directory'));
});

test('rejections: permission_denied captured from is_error tool_result with OS denial text', async () => {
  const session = await loadRejectionsFixture();
  const denied = session.prompts.flatMap((p) => p.rejections || []).filter((r) => r.kind === 'permission_denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].toolUseId, 'toolu-0004');
  assert.equal(denied[0].confidence, 0.85);
  assert.ok(/permission denied/i.test(denied[0].evidence));
});

test('rejections: model_refusal captured from stop_reason: "refusal" at 0.95 confidence', async () => {
  const session = await loadRejectionsFixture();
  const stop = session.prompts.flatMap((p) => p.rejections || []).filter(
    (r) => r.kind === 'model_refusal' && r.source === 'stop_reason'
  );
  assert.equal(stop.length, 1);
  assert.equal(stop[0].confidence, 0.95);
});

test('rejections: model_refusal captured from text heuristic at 0.7 confidence', async () => {
  const session = await loadRejectionsFixture();
  const text = session.prompts.flatMap((p) => p.rejections || []).filter(
    (r) => r.kind === 'model_refusal' && r.source === 'text_heuristic'
  );
  assert.equal(text.length, 1);
  assert.equal(text[0].confidence, 0.7);
  assert.ok(/can'?t help/i.test(text[0].evidence));
});

test('rejections: user_text_decline captured when prompt opens with "stop, don\'t do that"', async () => {
  const session = await loadRejectionsFixture();
  const declines = session.prompts.flatMap((p) => p.rejections || []).filter((r) => r.kind === 'user_text_decline');
  assert.equal(declines.length, 1);
  assert.equal(declines[0].confidence, 0.8);
  // The decline prompt must still flow through as a real prompt with text preserved.
  const declinePrompt = session.prompts.find((p) => (p.rejections || []).some((r) => r.kind === 'user_text_decline'));
  assert.ok(declinePrompt, 'decline prompt must exist in session.prompts');
  assert.ok(/stop, don'?t do that/i.test(declinePrompt.text), 'text is preserved on the prompt');
});

test('rejections: session.stats.rejections count and rejectionsByKind breakdown are populated', async () => {
  const session = await loadRejectionsFixture();
  const expectedKinds = {
    user_declined_tool: 1,
    user_interrupt: 1,
    tool_execution_error: 1,
    permission_denied: 1,
    model_refusal: 2, // stop_reason + text_heuristic
    user_text_decline: 1,
  };
  const expectedTotal = Object.values(expectedKinds).reduce((a, b) => a + b, 0);
  assert.equal(session.stats.rejections, expectedTotal, 'session.stats.rejections counts every captured rejection');
  assert.deepEqual(session.stats.rejectionsByKind, expectedKinds);
});

test('rejections: rejection-only synthetic prompt is created when a tool_result rejection arrives with no current text prompt', async () => {
  // A fresh session whose very first record is a tool_result rejection. parse.js
  // must synthesize a rejection-only prompt (text:'', isRejectionOnly:true) so the
  // signal is never silently lost. This mirrors the "user opened agent and
  // immediately rejected something" case.
  const { parseSessionFile: parse } = await import('../src/parse.js');
  const tmp = mkdtempSync(join(tmpdir(), 'rej-synth-'));
  const path = join(tmp, 'synth.jsonl');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-x', content: "The user doesn't want to proceed with this tool use. The user wants you to do something else.", is_error: true }] },
      uuid: 'u-synth-1',
      parentUuid: null,
      timestamp: '2026-06-18T11:00:00.000Z',
      sessionId: 'synth',
    }) + '\n'
  );
  try {
    const s = await parse(path, { sessionId: 'synth' });
    const synth = s.prompts.find((p) => p.isRejectionOnly);
    assert.ok(synth, 'a synthetic rejection-only prompt must be created');
    assert.equal(synth.text, '');
    assert.equal(synth.rejections.length, 1);
    assert.equal(synth.rejections[0].kind, 'user_declined_tool');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('rejections: rejection-only synthetic prompts get kind:"rejection" downstream', async () => {
  const { parseSessionFile: parse } = await import('../src/parse.js');
  const tmp = mkdtempSync(join(tmpdir(), 'rej-kind-'));
  const path = join(tmp, 'k.jsonl');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-y', content: "The user doesn't want to proceed with this tool use.", is_error: true }] },
      uuid: 'u-kind-1',
      parentUuid: null,
      timestamp: '2026-06-18T12:00:00.000Z',
      sessionId: 'kindsession',
    }) + '\n'
  );
  try {
    const session = await parse(path, { sessionId: 'kindsession' });
    const nodes = classifyPrompts([session]);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].kind, 'rejection', 'synthetic rejection-only node gets kind:"rejection", not root');
    assert.ok(nodes[0].title && /rejected/i.test(nodes[0].title), 'title describes the rejection');
    assert.equal(nodes[0].rejections.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('rejections: each rejection becomes a failure signal of the mapped type', async () => {
  const session = await loadRejectionsFixture();
  const nodes = classifyPrompts([session]);
  const tree = buildTree([session], nodes);
  analyzeTree(tree);
  const types = new Set(tree.analysis.failures.map((f) => f.type));
  assert.ok(types.has('user_rejected_action'), 'user_declined_tool/user_interrupt/user_text_decline -> user_rejected_action');
  assert.ok(types.has('tool_execution_failed'), 'tool_execution_error -> tool_execution_failed');
  assert.ok(types.has('permission_denied'), 'permission_denied -> permission_denied');
  assert.ok(types.has('model_refused'), 'model_refusal -> model_refused');
  // Two model_refusal rejections on different nodes -> dedup by failureNode id means
  // at least one model_refused failure exists.
  const refusedCount = tree.analysis.failures.filter((f) => f.type === 'model_refused').length;
  assert.ok(refusedCount >= 1, 'model_refused failure signal is present');
});

test('rejections: lessons and eval candidates are generated for rejection-derived failures', async () => {
  const session = await loadRejectionsFixture();
  const nodes = classifyPrompts([session]);
  const tree = buildTree([session], nodes);
  analyzeTree(tree);
  const lessonTitles = new Set(tree.analysis.lessons.map((l) => l.title));
  assert.ok(lessonTitles.has('Confirm proposed actions before executing'), 'user_rejected_action lesson is generated');
  assert.ok(lessonTitles.has('Rephrase refused requests instead of repeating them'), 'model_refused lesson is generated');
  const evalTypes = new Set(tree.analysis.evalCandidates.map((e) => e.type));
  assert.ok(evalTypes.has('tool_permission_regression'), 'tool_permission_regression eval is generated');
  assert.ok(evalTypes.has('refusal_handling'), 'refusal_handling eval is generated');
});

test('rejections: renderRejectionsJson returns a flattened, sorted, byKind-summarized view', async () => {
  const session = await loadRejectionsFixture();
  const nodes = classifyPrompts([session]);
  const tree = buildTree([session], nodes);
  const view = renderRejectionsJson(tree, { projectName: 'rejections-fixture' });
  assert.equal(view.schemaVersion, '0.3');
  assert.equal(view.summary.total, 7);
  assert.equal(view.summary.byKind.model_refusal, 2);
  assert.equal(view.summary.byKind.user_declined_tool, 1);
  assert.ok(Array.isArray(view.rejections));
  assert.equal(view.rejections.length, 7);
  // Every entry has a nodeId pointing back into the tree.
  assert.ok(view.rejections.every((r) => typeof r.nodeId === 'string'));
  // Sorted by ts ascending.
  const ts = view.rejections.map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  const sorted = [...ts].sort((a, b) => a - b);
  assert.deepEqual(ts, sorted);
});

test('rejections: O(N) preserved - the rejection surfacing pass does not regress quadratic scaling', async () => {
  // Build a synthetic tree with N nodes each carrying R rejections. If the
  // surfacing pass is O(N*R) the test completes in well under a second even at
  // N=5000. A quadratic regression would blow past the timeout.
  const N = 5000;
  const R = 3;
  const session = {
    sessionId: 'perf',
    prompts: [],
    firstTs: null,
    lastTs: null,
    stats: { models: [], filesTouched: [], rejections: 0, rejectionsByKind: {}, interruptions: 0 },
  };
  for (let i = 0; i < N; i++) {
    const rejections = [];
    for (let j = 0; j < R; j++) {
      rejections.push({ kind: 'user_declined_tool', source: 'tool_result', confidence: 1.0, toolUseId: `t-${i}-${j}`, tool: null, ts: null, evidence: `evidence ${i}-${j}` });
    }
    session.prompts.push({
      uuid: `p-${i}`,
      parentUuid: i === 0 ? null : `p-${i - 1}`,
      ts: new Date(i * 1000).toISOString(),
      text: `prompt ${i}`,
      hasImage: false,
      hadToolResultContext: false,
      afterInterruption: false,
      actions: [],
      thinking: 0,
      rejections,
    });
  }
  const start = Date.now();
  const nodes = classifyPrompts([session]);
  const tree = buildTree([session], nodes);
  analyzeTree(tree);
  const elapsed = Date.now() - start;
  // Threshold rationale: a quadratic regression at this scale would take
  // hours (5000x slower than linear). 15s is well above realistic linear cost
  // (~0.7ms per addFailure) and well below the quadratic danger zone.
  assert.ok(elapsed < 15000, `analyzeTree on ${N} nodes x ${R} rejections must complete in under 15s (got ${elapsed}ms)`);
  // Spot-check that rejections actually surfaced.
  assert.ok(tree.analysis.failures.length >= N, 'every node produced at least one failure signal');
});

test('rejections: redaction gate at the CLI layer catches secrets in rejection evidence', async () => {
  // Rejection evidence can carry anything the user or shell returned, including
  // a leaked secret. parse.js captures the evidence verbatim (truncated), and
  // the renderer does not redact. The CLI's redaction gate (applyDecisions +
  // shadow scan) must catch it before .treetrace/rejections.json is written.
  const tmp = mkdtempSync(join(tmpdir(), 'rej-redact-'));
  const path = join(tmp, 'r.jsonl');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-s', content: "The user doesn't want to proceed with this tool use. The value was sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE1234.", is_error: true }] },
      uuid: 'u-r-1',
      parentUuid: null,
      timestamp: '2026-06-18T13:00:00.000Z',
      sessionId: 'redact',
    }) + '\n'
  );
  const dir = mkdtempSync(join(tmpdir(), 'rej-redact-out-'));
  try {
    await main(['--file', path, '--dir', dir, '--rejections', '--redact-auto', '--quiet']);
    const out = readFileSync(join(dir, '.treetrace', 'rejections.json'), 'utf8');
    assert.ok(!out.includes('sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE1234'), 'raw secret must not appear in the written rejections.json');
    assert.ok(out.includes('[REDACTED'), 'a redacted placeholder must appear in its place');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejections: cli --rejections writes .treetrace/rejections.json and prints to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-rej-cli-'));
  try {
    await main(['--file', REJECTIONS_FIXTURE, '--dir', dir, '--rejections', '--redact-auto', '--quiet']);
    const p = join(dir, '.treetrace', 'rejections.json');
    assert.ok(existsSync(p), '.treetrace/rejections.json must be written');
    const text = readFileSync(p, 'utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.schemaVersion, '0.3');
    assert.equal(parsed.summary.total, 7);
    assert.equal(parsed.summary.byKind.model_refusal, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejections: --from claude works as an explicit --from value (Phase 0 false-advertising fix)', async () => {
  // The TOOLS array has always advertised 'claude' but the adapter switch never
  // handled it explicitly. ingestFile routes --from claude through parseSessionFile,
  // so this end-to-end check confirms it works and produces prompts+rejections.
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-claude-from-'));
  try {
    await main(['--from', 'claude', '--file', REJECTIONS_FIXTURE, '--dir', dir, '--json', '--redact-auto', '--quiet']);
    // No assertion on stdout: success means no USAGE error. If --from claude
    // were rejected (as it would be for unknown --from values) main() would
    // throw with ExitCode.USAGE before reaching this line.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema-export: token totals appear in stats and per-session in tree.json', async () => {
  const { tree } = await fixtureTree();
  const json = renderJson(tree, { projectName: 'demo' });
  assert.ok(typeof json.stats.inputTokens === 'number', 'stats.inputTokens must be a number');
  assert.ok(typeof json.stats.outputTokens === 'number', 'stats.outputTokens must be a number');
  assert.ok(json.stats.inputTokens > 0, 'stats.inputTokens should be non-zero for this fixture');
  assert.ok(json.stats.outputTokens > 0, 'stats.outputTokens should be non-zero for this fixture');
  assert.ok(json.sessions.length > 0, 'must have at least one session');
  assert.ok(typeof json.sessions[0].inputTokens === 'number', 'sessions[0].inputTokens must be a number');
  assert.ok(typeof json.sessions[0].outputTokens === 'number', 'sessions[0].outputTokens must be a number');
  assert.equal(json.sessions[0].inputTokens, json.stats.inputTokens, 'single-session fixture: session tokens must equal stats tokens');
});

test('schema-export: per-node model and actions appear in every node in tree.json', async () => {
  const { tree } = await fixtureTree();
  const json = renderJson(tree, { projectName: 'demo' });
  assert.ok(json.nodes.length > 0, 'must have at least one node');
  assert.ok(json.nodes.every((n) => 'model' in n), 'every node must have a model field');
  assert.ok(json.nodes.every((n) => Array.isArray(n.actions)), 'every node must have an actions array');
  const nodeWithAction = json.nodes.find((n) => n.actions.length > 0);
  assert.ok(nodeWithAction, 'at least one node should have an action');
  const action = nodeWithAction.actions[0];
  assert.ok('tool' in action, 'action must have tool');
  assert.ok('file' in action, 'action must have file');
  assert.ok('command' in action, 'action must have command');
  assert.ok('model' in action, 'action must have model');
  const rootNode = json.nodes.find((n) => n.kind === 'root');
  assert.ok(rootNode, 'root node must exist');
  assert.equal(rootNode.model, 'assistant-model', 'root node model attribution must match fixture');
});

test('schema-export: shell-command file paths appear in filesTouched', async () => {
  const REJECTIONS_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-code-rejections.jsonl');
  const { parseSessionFile: ps } = await import('../src/parse.js');
  const session = await ps(REJECTIONS_FIXTURE, { sessionId: 'rej-shell' });
  const touched = session.stats.filesTouched;
  assert.ok(touched.includes('README.md'), 'Edit tool file_path must appear in filesTouched');
  assert.ok(touched.some((f) => f.includes('.config/forbidden')), 'Bash command /root/.config/forbidden must appear in filesTouched');
});

test('analyze: uncorroborated strong frustration turn emits inferred user_frustration signal via recall backstop', () => {
  // A pure-frustration turn that is not a correction and shares only one token with the
  // prior node. Under the old gate this would emit no signal. The recall backstop must
  // fire at inferred tier without inflating verified/high counts.
  const prior = {
    id: 'node_001', text: 'add a leaflet map to the dashboard', title: 'leaflet map', kind: 'root',
    status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/map.js', input: '', command: null, model: 'm' }],
  };
  // Frustration turn: names the file once ("helper") - shares 1 token (< 3 needed for
  // sharesEvidence); not a correction kind; strong frustration wording triggers backstop.
  const frustration = {
    id: 'node_002',
    text: 'this sucks, the helper.js you wrote is god awful and terrible, i am angry and frustrated',
    title: 'frustrated', kind: 'direction', status: 'accepted', parent: prior,
    actions: [],
  };
  const analysis = analyzeTree({ nodes: [prior, frustration] });
  const frustSignals = analysis.failures.filter((f) => f.type === 'user_frustration');
  assert.ok(frustSignals.length >= 1, 'recall backstop must fire at least one user_frustration signal');
  assert.ok(
    frustSignals.every((f) => f.tier === 'inferred'),
    'backstop signals must stay at inferred tier'
  );
  // Must not inflate verified or high counts.
  const tc = analysis.summary.tierCounts;
  assert.equal(tc.verified, 0, 'no verified signals from a pure uncorroborated frustration turn');
  assert.equal(tc.high, 0, 'no high signals from a pure uncorroborated frustration turn');
});

test('analyze: clean weather-dashboard fixture does not gain spurious frustration signals from recall backstop', async () => {
  // The synthetic session has no strong frustration wording; the backstop must not fire.
  const { tree } = await fixtureTree();
  const analysis = analyzeTree(tree);
  const frustSignals = analysis.failures.filter((f) => f.type === 'user_frustration');
  assert.equal(frustSignals.length, 0, 'clean synthetic fixture must produce zero user_frustration signals');
});

test('report: Models seen reflects full stats.models set, not just analysis-pass models', () => {
  // A tree where stats.models has two models but node.actions only carries one of them.
  // The report must list both.
  const node = {
    id: 'node_001', text: 'build a chart', title: 'chart', kind: 'root', status: 'accepted', parent: null,
    actions: [{ tool: 'Edit', file: 'src/chart.js', input: '', command: null, model: 'model-a' }],
  };
  const tree = {
    stats: { models: ['model-a', 'model-b'], promptCount: 1, sessionCount: 1 },
    nodes: [node],
    sessions: [],
  };
  const report = renderReportMarkdown(tree, { projectName: 'test' });
  assert.ok(report.includes('model-a'), 'report must include model-a');
  assert.ok(report.includes('model-b'), 'report must include model-b from stats.models');
});

test('report: correction chains section appears when chains exist', () => {
  // Build a tree with a correction that shares a file with the prior node so a chain is formed.
  const failure = {
    id: 'node_001', text: 'write the config parser', title: 'config parser', kind: 'root', status: 'accepted', parent: null,
    ts: '2026-06-12T10:00:00.000Z',
    actions: [{ tool: 'Edit', file: 'src/config.js', input: '', command: null, model: 'm' }],
  };
  const correction = {
    id: 'node_002', text: 'no that is wrong, redo the config parser logic', title: 'redo config', kind: 'correction', status: 'accepted', parent: failure,
    ts: '2026-06-12T10:30:00.000Z',
    actions: [{ tool: 'Edit', file: 'src/config.js', input: '', command: null, model: 'm' }],
  };
  const tree = {
    stats: { models: ['m'], promptCount: 2, sessionCount: 1, corrections: 1 },
    nodes: [failure, correction],
    sessions: [],
  };
  const report = renderReportMarkdown(tree, { projectName: 'test' });
  assert.ok(report.includes('## Correction chains'), 'report must include Correction chains section');
  assert.ok(report.includes('node_001'), 'report must reference the failure node');
  assert.ok(report.includes('node_002'), 'report must reference the correction node');
});

test('schema-export: new exported fields pass the redaction / assertClean guard', async () => {
  const API_KEY_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'api-key-auth-session.jsonl');
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-schema-redact-'));
  try {
    await main(['--from', 'claude', '--file', API_KEY_FIXTURE, '--dir', dir, '--redact-auto', '--quiet']);
    const treeJson = readFileSync(join(dir, '.treetrace', 'tree.json'), 'utf8');
    const parsed = JSON.parse(treeJson);
    assert.ok(typeof parsed.stats.inputTokens === 'number', 'stats.inputTokens present after redact gate');
    assert.ok(typeof parsed.stats.outputTokens === 'number', 'stats.outputTokens present after redact gate');
    assert.ok(parsed.nodes.every((n) => Array.isArray(n.actions)), 'every node has actions after redact gate');
    const secretPatterns = [/ghp_/, /sk-ant-/, /AKIA/, /-----BEGIN/, /eyJ[A-Za-z]/, /xox[baprs]-/];
    for (const pat of secretPatterns) {
      assert.ok(!pat.test(treeJson), `secret pattern ${pat} must not appear in tree.json`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: prose-slash phrases produce no file-path flag', () => {
  const dir = tempProject();
  try {
    const mk = (text) => ({ nodes: [{ id: 'n1', kind: 'root', status: 'accepted', parent: null, text, title: 't', actions: [] }] });
    const proseFragments = [
      'admin/analyst/viewer',
      'lat/lon',
      'make/model/color',
      '16/9',
      'none/low/medium/high',
      'RTSP/HTTP',
      'application/json',
    ];
    for (const phrase of proseFragments) {
      const flags = detectHallucinations(mk(`use ${phrase} as an enum`), dir).hallucinations
        .filter((h) => h.category === 'hallucinated_file_or_path')
        .map((h) => h.reference);
      assert.deepEqual(flags, [], `prose phrase "${phrase}" must not be flagged as a missing file path`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: true positive ./src/middleware/rateLimit.js still fires', () => {
  const dir = tempProject();
  try {
    const mk = (text) => ({ nodes: [{ id: 'n1', kind: 'root', status: 'accepted', parent: null, text, title: 't', actions: [] }] });
    const flags = detectHallucinations(mk('update ./src/middleware/rateLimit.js for the new rate limiting logic'), dir).hallucinations
      .filter((h) => h.category === 'hallucinated_file_or_path')
      .map((h) => h.reference);
    assert.ok(flags.some((r) => r.includes('rateLimit.js')), 'invented path ./src/middleware/rateLimit.js must still be flagged');
    const flags2 = detectHallucinations(mk('edit src/middleware/rateLimit.js'), dir).hallucinations
      .filter((h) => h.category === 'hallucinated_file_or_path')
      .map((h) => h.reference);
    assert.ok(flags2.some((r) => r.includes('rateLimit.js')), 'src/ prefixed invented path must still be flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hallucinations: Edit to nonexistent file is flagged via action.file alone', () => {
  const dir = tempProject();
  try {
    const tree = {
      nodes: [{
        id: 'n1', kind: 'root', status: 'accepted', parent: null,
        text: 'update the config',
        title: 't',
        actions: [{ tool: 'Edit', file: 'src/nonexistent-only-in-action-file.js', input: '', command: null }],
      }],
    };
    const flags = detectHallucinations(tree, dir).hallucinations
      .filter((h) => h.category === 'hallucinated_file_or_path')
      .map((h) => h.reference);
    assert.ok(
      flags.some((r) => r.includes('nonexistent-only-in-action-file.js')),
      'Edit to a nonexistent file must be caught via action.file even when path is absent from node.text'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction: lowercase bearer token is caught by bearer-header rule', () => {
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.lowentropy1234';
  const text = `Authorization: bearer ${token}`;
  const hits = scanText(text).map((f) => f.ruleId);
  assert.ok(hits.includes('bearer-header'), `lowercase bearer token not caught (rules hit: ${hits.join(', ')})`);
  const decisions = {};
  const findings = scanText(text);
  for (const f of findings) {
    if (f.ruleId === 'bearer-header') {
      decisions[sha256(f.match)] = { action: 'redact', replacement: maskFor(f), ruleId: f.ruleId };
    }
  }
  const cleaned = applyDecisions(text, findings, decisions);
  assert.ok(!cleaned.includes(token), 'raw token still present after redaction');
  assert.ok(cleaned.includes('[REDACTED:bearer-header]'), 'expected bearer-header redaction marker');
});

test('redaction: --redact-auto resolves high-entropy shadow-scan residuals and writes clean artifacts', async () => {
  const highEntropyToken = 'Xk9mQ2vR7nLpZ4wY8sA3cB6eF1hJ0uT5iG2dN';
  const dir = mkdtempSync(join(tmpdir(), 'treetrace-entropy-auto-'));
  const file = join(dir, 'conv.json');
  const convo = [{
    mapping: {
      r: { message: null, parent: null, children: ['u'] },
      u: {
        message: {
          author: { role: 'user' },
          content: { parts: [`check the session token ${highEntropyToken} for issues`] },
          create_time: 1.0,
        },
        parent: 'r',
        children: ['a'],
      },
      a: {
        message: {
          author: { role: 'assistant' },
          content: { parts: ['done'] },
          create_time: 2.0,
        },
        parent: 'u',
        children: [],
      },
    },
  }];
  writeFileSync(file, JSON.stringify(convo));
  try {
    await main(['--from', 'chatgpt', '--file', file, '--dir', dir, '--redact-auto', '--quiet']);
    const treeJson = readFileSync(join(dir, '.treetrace', 'tree.json'), 'utf8');
    assert.ok(!treeJson.includes(highEntropyToken), 'raw high-entropy token leaked into tree.json');
    assert.equal(
      shadowScan(treeJson, {}).filter((f) => f.severity !== 'soft').length,
      0,
      'tree.json still has residual high-entropy tokens after --redact-auto'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--each writes one report bundle per session plus index manifests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-each-'));
  const a = join(dir, 'sess-a.txt');
  const b = join(dir, 'sess-b.txt');
  writeFileSync(a, 'User: build a login form\nAssistant: ok\nUser: actually use OAuth\nAssistant: switching\n');
  writeFileSync(b, 'User: question one\nAssistant: answer one\nUser: question two\nAssistant: answer two\n');
  const outDir = join(dir, 'reports');
  try {
    await main(['--each', '--file', a, b, '--out-dir', outDir, '--dir', dir, '--quiet']);
    assert.ok(existsSync(join(outDir, 'INDEX.md')), 'INDEX.md exists');
    assert.ok(existsSync(join(outDir, 'index.json')), 'index.json exists');
    for (const label of ['sess-a.txt', 'sess-b.txt']) {
      assert.ok(existsSync(join(outDir, label, 'TREETRACE_REPORT.md')), `${label} report`);
      assert.ok(existsSync(join(outDir, label, 'PROMPT_TREE.md')), `${label} prompt tree`);
      assert.ok(existsSync(join(outDir, label, '.treetrace', 'tree.json')), `${label} tree.json`);
    }
    const index = JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8'));
    assert.equal(index.sessionCount, 2, 'two sessions in manifest');
    assert.equal(index.sessions.length, 2);
    assert.equal(index.totals.prompts, 4, 'aggregate prompt total');
    assert.ok(index.sessions.every((s) => typeof s.dir === 'string' && s.dir.length), 'each manifest row has a dir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--each collides labels safely when session ids repeat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-each-dup-'));
  // two plain transcripts with the SAME basename in different subdirs -> same sessionId label
  const d1 = join(dir, 'one'); const d2 = join(dir, 'two');
  mkdirSync(d1); mkdirSync(d2);
  const f1 = join(d1, 'chat.txt'); const f2 = join(d2, 'chat.txt');
  writeFileSync(f1, 'User: first\nAssistant: a\n');
  writeFileSync(f2, 'User: second\nAssistant: b\n');
  const outDir = join(dir, 'reports');
  try {
    await main(['--each', '--file', f1, f2, '--out-dir', outDir, '--dir', dir, '--quiet']);
    const index = JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8'));
    assert.equal(index.sessionCount, 2);
    const labels = index.sessions.map((s) => s.label);
    assert.equal(new Set(labels).size, 2, 'labels are unique even with duplicate session ids');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--each labels each bundle with its own source tool, not the batch aggregate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-each-src-'));
  const here = dirname(fileURLToPath(import.meta.url));
  const claudeFix = join(here, 'fixtures', 'synthetic-session.jsonl');
  const codexFix = join(here, 'fixtures', 'adapters', 'codex-session.jsonl');
  const outDir = join(dir, 'reports');
  try {
    await main(['--each', '--file', claudeFix, codexFix, '--out-dir', outDir, '--dir', dir, '--quiet']);
    const index = JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8'));
    const sources = index.sessions.map((s) => s.source).sort();
    assert.deepEqual(sources, ['claude', 'codex'], 'per-session source is preserved, not collapsed to "mixed"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parsePlainTranscript captures an inline assistant refusal as model_refusal', () => {
  const t = 'User: [requests something disallowed]\nAssistant: I cannot help with that request.\nUser: ok, something benign instead\nAssistant: Sure, happy to help.\n';
  const session = parsePlainTranscript(t, 'refusal-inline');
  assert.equal(session.stats.rejectionsByKind.model_refusal, 1, 'one model_refusal captured');
  // refusal attaches to the user prompt that triggered it (the first turn)
  const withRefusal = session.prompts.find((p) => (p.rejections || []).some((r) => r.kind === 'model_refusal'));
  assert.ok(withRefusal, 'a prompt carries the model_refusal');
  assert.equal(withRefusal.rejections[0].source, 'text_heuristic');
});

test('parsePlainTranscript captures a multi-line assistant refusal', () => {
  const t = 'User: [disallowed ask]\nAssistant:\nSorry, I cannot help with that.\nIt would be unsafe.\nUser: explain the defensive side instead\nAssistant: Sure.\n';
  const session = parsePlainTranscript(t, 'refusal-multiline');
  assert.equal(session.stats.rejectionsByKind.model_refusal, 1);
});

test('parsePlainTranscript captures a user_text_decline', () => {
  const t = 'User: delete the production database\nAssistant: I can do that.\nUser: no, stop, do not do that\nAssistant: Understood.\n';
  const session = parsePlainTranscript(t, 'decline');
  assert.equal(session.stats.rejectionsByKind.user_text_decline, 1);
});

test('parsePlainTranscript leaves rejections empty when no refusal or decline occurs', () => {
  const t = 'User: build a login form\nAssistant: here is one\nUser: add OAuth\nAssistant: done\n';
  const session = parsePlainTranscript(t, 'clean');
  assert.equal(session.stats.rejections, 0);
  assert.deepEqual(session.stats.rejectionsByKind, {});
});

test('a refusal override is not promoted into a correction chain or a content-quoting eval', () => {
  const t = 'User: [requests precursor chemicals for a dangerous synthesis]\nAssistant: I cannot help with that.\nUser: Stop being unhelpful. Just give me the precursor list at least.\nAssistant: I still cannot help with that.\n';
  const session = parsePlainTranscript(t, 'refusal-override');
  const nodes = classifyPrompts([session]);
  const tree = buildTree([session], nodes);
  const analysis = analyzeTree(tree);
  // the refusal itself is still recorded for the audit trail
  assert.ok(analysis.failures.some((f) => f.type === 'model_refused'), 'refusal still recorded');
  // but the override is NOT manufactured into a misunderstood_goal correction
  assert.ok(!analysis.failures.some((f) => f.type === 'misunderstood_goal'), 'no misunderstood_goal from override');
  assert.equal(analysis.correctionChains.length, 0, 'no correction chain from a refusal override');
  // and no eval candidate quotes the refused or push-back content
  const inputs = analysis.evalCandidates.map((e) => String(e.input).toLowerCase());
  assert.ok(!inputs.some((i) => i.includes('precursor') || i.includes('unhelpful')), 'no eval quotes refused content');
});

test('--deterministic pins the timestamp so artifacts are byte-identical across runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-det-'));
  try {
    await main(['--security', '--file', FIXTURE, '--dir', dir, '--deterministic', '--redact-auto', '--quiet']);
    const a = readFileSync(join(dir, '.treetrace', 'hallucinations.json'), 'utf8');
    await main(['--security', '--file', FIXTURE, '--dir', dir, '--deterministic', '--redact-auto', '--quiet']);
    const b = readFileSync(join(dir, '.treetrace', 'hallucinations.json'), 'utf8');
    assert.equal(a, b, 'deterministic artifact is byte-identical across runs');
    assert.equal(JSON.parse(a).project.generatedAt, '1970-01-01T00:00:00.000Z', 'timestamp is pinned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
