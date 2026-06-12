# Adapter fixture provenance

Each fixture below reproduces the real on-disk or export schema of the tool it
represents. Where the structure came from a real session or a real published
sample, the message text has been replaced with neutral placeholder content so
no private conversation is republished. The field shapes, key names, value
types, and nesting are kept exactly as the real format.

## codex-session.jsonl
- Format: Codex CLI rollout JSONL (`~/.codex/sessions/.../rollout-*.jsonl`).
- Source: a real Codex CLI session captured locally (cli_version 0.139.0).
- Scrubbing: message text, cwd, instructions, and turn context replaced with
  neutral placeholders. Event/record schema (`session_meta`, `turn_context`,
  `response_item` messages, `function_call`, `token_count`) is unchanged.
- Status: VERIFIED against the original real session.

## gemini-session.json
- Format: gemini-cli ChatRecordingService session JSON.
- Source: google-gemini/gemini-cli, memory-tests/large-chat-session.json
  (https://github.com/google-gemini/gemini-cli), Apache-2.0.
- Scrubbing: a short slice of the real file with message `content`, `thoughts`,
  and `toolCalls` text replaced with neutral placeholders. The `sessionId`,
  `projectHash`, `messages[].type`, `content`, `tokens`, `model`, and
  `toolCalls` shapes are unchanged.
- Status: VERIFIED. The full real file parses through the adapter (51 user
  prompts, 1334 model turns, model gemini-3-flash-preview).

## chatgpt-conversations.json
- Format: ChatGPT/OpenAI account export `conversations.json` (array of
  conversations, each with a `mapping` of node id to message node).
- Source: sanand0/openai-conversations, samples/seoul-weather-early-october.json
  (https://github.com/sanand0/openai-conversations), MIT.
- Scrubbing: real export structure kept (`mapping`, `author.role`,
  `content.content_type`, `content.parts`, `parent`, `children`,
  `create_time`); all message text and tool output replaced with placeholders;
  heavy per-node metadata trimmed to `model_slug` only.
- Status: VERIFIED. The original sample parses through the adapter.

## copilot-chatsession.json
- Format: VS Code GitHub Copilot Chat session JSON (version 3, `requests[]`).
- Source: Timcooking/VSCode-Copilot-Chat-Viewer, demo-chat.json
  (https://github.com/Timcooking/VSCode-Copilot-Chat-Viewer), MIT.
- Scrubbing: real `requesterUsername`, `responderUsername`, `requests[].message`
  (`text` + `parts`), and `response[].value` shapes kept; text replaced with
  neutral placeholders.
- Status: VERIFIED against the published demo session.

## cursor-export.json
- Format: Cursor exported-chat JSON, matching the cursor-history exporter's
  single-session JSON (`id`, `title`, `messages[].role/content/model/toolCalls`).
- Source: schema from S2thend/cursor-history src/core/types.ts and
  src/cli/formatters/json.ts (https://github.com/S2thend/cursor-history), MIT.
  Cursor stores chat in state.vscdb (SQLite); the adapter ingests the exported
  JSON because TreeTrace ships with zero runtime dependencies and cannot open
  SQLite. This fixture mirrors that exporter's output.
- Status: VERIFIED against the exporter's documented schema (no SQLite needed).

## grok-session.json
- Format: Grok CLI exported conversation JSON
  (`timestamp`, `model`, `messageCount`, `conversation[].role/content`), the
  xAI OpenAI-compatible message shape.
- Source: schema from lalomorales22/grok-4-cli lib/export.js `exportToJSON`
  (https://github.com/lalomorales22/grok-4-cli). The primary superagent-ai
  grok-cli stores history in SQLite (no JSON on disk), so this adapter targets
  the exported-JSON shape.
- Status: EXPERIMENTAL. Built to the exporter's documented JSON shape; not yet
  validated against a captured real Grok session on this machine.
