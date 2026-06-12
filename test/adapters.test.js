import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { adaptFrom, autoAdapt, TOOLS } from '../src/adapters/index.js';
import { classifyPrompts } from '../src/extract.js';
import { buildTree } from '../src/tree.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'adapters');
const fx = (name) => join(DIR, name);
const read = (name) => readFileSync(fx(name), 'utf8');

function pipeline(sessions) {
  const nodes = classifyPrompts(sessions);
  return { nodes, tree: buildTree(sessions, nodes) };
}

test('codex: parses real rollout JSONL into human prompts', () => {
  const sessions = adaptFrom('codex', read('codex-session.jsonl'), fx('codex-session.jsonl'));
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.prompts.length, 3);
  assert.ok(s.prompts.every((p) => !p.text.startsWith('<environment_context>')));
  assert.ok(s.prompts[0].text.includes('/version subcommand'));
  assert.equal(s.stats.assistantLines, 3);
  assert.ok(s.stats.toolUses >= 1);
  assert.equal(s.stats.inputTokens, 5200);
  const { tree } = pipeline(sessions);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.stats.promptCount, 3);
});

test('codex: auto-detected from JSONL shape', () => {
  const detected = autoAdapt(read('codex-session.jsonl'), fx('codex-session.jsonl'));
  assert.ok(detected);
  assert.equal(detected.tool, 'codex');
  assert.equal(detected.sessions[0].prompts.length, 3);
});

test('chatgpt: parses export mapping, walks user turns, detects model', () => {
  const sessions = adaptFrom('chatgpt', read('chatgpt-conversations.json'), fx('chatgpt-conversations.json'));
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.prompts.length, 1);
  assert.equal(s.title, 'Debounce a search input in React');
  assert.ok(s.stats.models.includes('gpt-4o'));
  assert.ok(s.stats.assistantLines >= 1);
  assert.ok(s.stats.toolUses >= 1);
});

test('chatgpt: auto-detected from mapping shape', () => {
  const detected = autoAdapt(read('chatgpt-conversations.json'), fx('chatgpt-conversations.json'));
  assert.ok(detected);
  assert.equal(detected.tool, 'chatgpt');
});

test('gemini: parses ChatRecordingService session, tools and tokens', () => {
  const sessions = adaptFrom('gemini', read('gemini-session.json'), fx('gemini-session.json'));
  const s = sessions[0];
  assert.equal(s.prompts.length, 3);
  assert.ok(s.prompts[0].text.includes('health-check'));
  assert.equal(s.stats.assistantLines, 3);
  assert.ok(s.stats.toolUses >= 1);
  assert.ok(s.stats.filesTouched.includes('src/server/health.ts'));
  assert.ok(s.stats.models.includes('gemini-3-flash-preview'));
});

test('gemini: auto-detected from session JSON', () => {
  const detected = autoAdapt(read('gemini-session.json'), fx('gemini-session.json'));
  assert.ok(detected);
  assert.equal(detected.tool, 'gemini');
  assert.equal(detected.sessions[0].prompts.length, 3);
});

test('copilot: parses requests[] into prompts, counts tool invocations', () => {
  const sessions = adaptFrom('copilot', read('copilot-chatsession.json'), fx('copilot-chatsession.json'));
  const s = sessions[0];
  assert.equal(s.prompts.length, 5);
  assert.ok(s.prompts[0].text.toLowerCase().includes('html'));
  assert.equal(s.stats.assistantLines, 5);
});

test('copilot: auto-detected from requesterUsername/requests', () => {
  const detected = autoAdapt(read('copilot-chatsession.json'), fx('copilot-chatsession.json'));
  assert.ok(detected);
  assert.equal(detected.tool, 'copilot');
});

test('cursor: parses exported session messages, model and files', () => {
  const sessions = adaptFrom('cursor', read('cursor-export.json'), fx('cursor-export.json'));
  const s = sessions[0];
  assert.equal(s.prompts.length, 3);
  assert.equal(s.title, 'Add pagination to the users table');
  assert.ok(s.stats.models.includes('claude-3.5-sonnet'));
  assert.ok(s.stats.toolUses >= 1);
  assert.ok(s.stats.filesTouched.some((f) => f.endsWith('Users.tsx')));
});

test('cursor: auto-detected from exported session shape', () => {
  const detected = autoAdapt(read('cursor-export.json'), fx('cursor-export.json'));
  assert.ok(detected);
  assert.equal(detected.tool, 'cursor');
});

test('grok: parses conversation[] role/content into prompts', () => {
  const sessions = adaptFrom('grok', read('grok-session.json'), fx('grok-session.json'));
  const s = sessions[0];
  assert.equal(s.prompts.length, 3);
  assert.ok(s.prompts[0].text.includes('Fibonacci'));
  assert.ok(s.stats.models.includes('grok-4'));
  assert.equal(s.stats.assistantLines, 2);
});

test('grok: auto-detected from conversation messages', () => {
  const detected = autoAdapt(read('grok-session.json'), fx('grok-session.json'));
  assert.ok(detected);
  assert.equal(detected.tool, 'grok');
});

test('adapter output flows through the full classify/tree pipeline', () => {
  for (const name of ['codex-session.jsonl', 'gemini-session.json', 'cursor-export.json', 'grok-session.json']) {
    const text = read(name);
    const detected = autoAdapt(text, fx(name));
    assert.ok(detected, `no detection for ${name}`);
    const { tree } = pipeline(detected.sessions);
    assert.ok(tree.nodes.length >= 1, `no nodes for ${name}`);
    assert.equal(tree.nodes[0].kind, 'root', `first node not root for ${name}`);
    assert.ok(tree.roots.length >= 1);
  }
});

test('adaptFrom rejects an unknown tool name', () => {
  assert.throws(() => adaptFrom('notatool', '{}', 'x.json'), /unknown/);
  assert.ok(TOOLS.includes('codex') && TOOLS.includes('cursor'));
});
