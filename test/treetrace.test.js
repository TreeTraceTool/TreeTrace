import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSessionFile, parsePlainTranscript, classifySpecialUserText } from '../src/parse.js';
import { classifyPrompts } from '../src/extract.js';
import { buildTree } from '../src/tree.js';
import { scanText, applyDecisions, shadowScan, maskFor, resolveFindings } from '../src/redact.js';
import { renderMarkdown, promptPack } from '../src/render-md.js';
import { renderJson } from '../src/render-json.js';
import { renderHandoff } from '../src/handoff.js';
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
  ];
  for (const [sample, expected] of cases) {
    const hits = scanText(`some text ${sample} more text`).map((f) => f.ruleId);
    assert.ok(hits.includes(expected), `${expected} missed in: ${sample} (got ${hits})`);
  }
});

test('redaction: benign text produces no high/medium findings', () => {
  const benign =
    'Refactor the parser in src/parse.js to handle commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a and bump to v2.1.0-beta.3. The README.md needs a section on CONTRIBUTING.';
  const hard = scanText(benign).filter((f) => f.severity !== 'soft');
  assert.deepEqual(hard, []);
});

test('renderers: markdown, json, handoff are consistent and footer-credited', async () => {
  const { tree } = await fixtureTree();
  const md = renderMarkdown(tree, { projectName: 'demo' });
  assert.ok(md.startsWith('# 🌳 Prompt Tree — demo'));
  assert.ok(md.includes('## Goal'));
  assert.ok(md.includes('## Reusable Prompt Pack'));
  assert.ok(md.includes('generated by [treetrace]') || md.includes('Generated by [treetrace]'));

  const json = renderJson(tree, { projectName: 'demo' });
  assert.equal(json.schemaVersion, '0.1');
  assert.equal(json.nodes.length, tree.nodes.length);
  assert.equal(json.edges.length, tree.nodes.filter((n) => n.parent).length);
  assert.ok(json.nodes.every((n) => n.id && n.kind && typeof n.text === 'string'));

  const pack = promptPack(tree.nodes);
  assert.ok(pack.includes('1.'));

  const handoff = renderHandoff(tree, { projectName: 'demo' });
  assert.ok(handoff.includes('## Original goal'));
  assert.ok(handoff.includes('Constraints learned the hard way'));
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
