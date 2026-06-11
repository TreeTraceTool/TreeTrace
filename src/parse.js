import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Streaming parser for Claude Code session JSONL files.
 *
 * Design constraints:
 *  - Session files reach 200MB+; never buffer the whole file.
 *  - Keep a light index (uuid/parent/type/ts) for every conversation record so
 *    branch topology can be reconstructed, but keep full text only for
 *    candidate human prompts and small metadata records.
 *  - Tolerate unknown record types and malformed lines: skip, never throw.
 */

const TURN_TYPES = new Set(['user', 'assistant']);

export async function parseSessionFile(path, sessionMeta = {}) {
  const session = {
    sessionId: sessionMeta.sessionId || null,
    path,
    title: null,
    version: null,
    cwd: null,
    gitBranch: null,
    firstTs: null,
    lastTs: null,
    prompts: [], // candidate human prompts (full text retained)
    index: new Map(), // uuid -> { parentUuid, type, ts } for all turn records
    leafUuid: null, // last turn uuid seen (chronological)
    stats: {
      userLines: 0,
      assistantLines: 0,
      toolUses: 0,
      models: new Set(),
      filesTouched: new Set(),
      inputTokens: 0,
      outputTokens: 0,
      interruptions: 0,
    },
    isContinuation: false, // continued from a compacted previous session
    continuationOf: null,
  };

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // truncated/corrupt line
    }
    ingestRecord(session, rec);
  }
  rl.close();

  session.stats.models = [...session.stats.models];
  session.stats.filesTouched = [...session.stats.filesTouched];
  return session;
}

function ingestRecord(session, rec) {
  switch (rec.type) {
    case 'user':
      ingestUser(session, rec);
      break;
    case 'assistant':
      ingestAssistant(session, rec);
      break;
    case 'summary':
      // {type:"summary", summary, leafUuid} — Claude Code's own session title
      if (rec.summary && !session.title) session.title = rec.summary;
      break;
    case 'ai-title':
      if ((rec.title || rec.aiTitle) && !session.title)
        session.title = rec.title || rec.aiTitle;
      break;
    default:
      // mode, permission-mode, bridge-session, last-prompt, queue-operation,
      // file-history-snapshot, attachment, system, ... — not lineage material
      break;
  }

  if (!session.sessionId && rec.sessionId) session.sessionId = rec.sessionId;
  if (!session.version && rec.version) session.version = rec.version;
  if (!session.cwd && rec.cwd) session.cwd = rec.cwd;
  if (!session.gitBranch && rec.gitBranch) session.gitBranch = rec.gitBranch;
  if (rec.timestamp && TURN_TYPES.has(rec.type)) {
    if (!session.firstTs) session.firstTs = rec.timestamp;
    session.lastTs = rec.timestamp;
  }
}

function indexTurn(session, rec) {
  if (!rec.uuid) return;
  session.index.set(rec.uuid, {
    parentUuid: rec.parentUuid || null,
    type: rec.type,
    ts: rec.timestamp || null,
  });
  if (!rec.isSidechain) session.leafUuid = rec.uuid;
}

function ingestUser(session, rec) {
  if (rec.isSidechain) return; // subagent traffic, not human
  indexTurn(session, rec);
  session.stats.userLines++;

  const msg = rec.message || {};
  const { text, hasToolResult, hasOnlyToolResult } = flattenUserContent(msg.content);

  if (hasOnlyToolResult) return; // tool output echoed back as a user turn

  const trimmed = (text || '').trim();
  if (!trimmed) return;

  if (/^\[Request interrupted by user/i.test(trimmed)) {
    session.stats.interruptions++;
    session._pendingInterruption = true;
    return;
  }

  // Slash command + local command wrappers, hook noise, harness reminders.
  const classification = classifySpecialUserText(trimmed);
  if (classification === 'command') return;
  if (classification === 'meta' || rec.isMeta) return;
  if (classification === 'compact-continuation') {
    session.isContinuation = true;
    return;
  }

  session.prompts.push({
    uuid: rec.uuid || null,
    parentUuid: rec.parentUuid || null,
    ts: rec.timestamp || null,
    text: trimmed,
    userType: rec.userType || null,
    hadToolResultContext: hasToolResult,
    afterInterruption: Boolean(session._pendingInterruption),
  });
  session._pendingInterruption = false;
}

function ingestAssistant(session, rec) {
  if (rec.isSidechain) return;
  indexTurn(session, rec);
  session.stats.assistantLines++;

  const msg = rec.message || {};
  if (msg.model) session.stats.models.add(msg.model);
  if (msg.usage) {
    session.stats.inputTokens += msg.usage.input_tokens || 0;
    session.stats.outputTokens += msg.usage.output_tokens || 0;
  }
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const block of content) {
    if (block && block.type === 'tool_use') {
      session.stats.toolUses++;
      const input = block.input || {};
      const file = input.file_path || input.notebook_path || null;
      if (typeof file === 'string') session.stats.filesTouched.add(file);
    }
  }
}

function flattenUserContent(content) {
  if (typeof content === 'string') {
    return { text: content, hasToolResult: false, hasOnlyToolResult: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', hasToolResult: false, hasOnlyToolResult: false };
  }
  let text = '';
  let toolResults = 0;
  let others = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += (text ? '\n' : '') + block.text;
      others++;
    } else if (block.type === 'tool_result') {
      toolResults++;
    } else {
      others++; // images, documents — count as non-tool content
    }
  }
  return {
    text,
    hasToolResult: toolResults > 0,
    hasOnlyToolResult: toolResults > 0 && others === 0,
  };
}

const COMPACT_CONTINUATION_RE =
  /^this session is being continued from a previous conversation/i;

export function classifySpecialUserText(text) {
  if (COMPACT_CONTINUATION_RE.test(text)) return 'compact-continuation';
  // /slash-command invocations and their stdout get wrapped in pseudo-XML
  if (
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<bash-input>') ||
    text.startsWith('<bash-stdout>') ||
    text.startsWith('<bash-stderr>')
  ) {
    return 'command';
  }
  if (
    text.startsWith('<system-reminder>') ||
    text.startsWith('<task-notification>') ||
    text.startsWith('<local-command-caveat>') ||
    text.startsWith('Caveat: The messages below')
  ) {
    return 'meta';
  }
  return 'prompt';
}

/**
 * Fallback importer: plain text / markdown transcripts (pasted exports from
 * ChatGPT, Claude.ai, etc.). Recognizes common turn markers; returns a
 * session-shaped object with prompts only.
 */
export function parsePlainTranscript(text, label = 'pasted-transcript') {
  const lines = text.split(/\r?\n/);
  const markers =
    /^(?:#{1,4}\s*)?(?:\*\*)?(user|human|me|you|prompt)(?:\*\*)?\s*[:—-]?\s*$|^(?:#{1,4}\s*)?(?:\*\*)?(user|human|me|prompt)(?:\*\*)?\s*[:—]\s*(.+)$/i;
  const assistantMarkers =
    /^(?:#{1,4}\s*)?(?:\*\*)?(assistant|ai|chatgpt|claude|gpt|gemini|model|response)(?:\*\*)?\s*[:—-]?\s*/i;

  const prompts = [];
  let current = null;
  let sawMarkers = false;

  for (const line of lines) {
    const userMatch = line.match(markers);
    if (userMatch) {
      sawMarkers = true;
      if (current && current.text.trim()) prompts.push(current);
      current = { text: userMatch[3] ? `${userMatch[3]}\n` : '', uuid: null, parentUuid: null, ts: null };
      continue;
    }
    if (assistantMarkers.test(line)) {
      sawMarkers = true;
      if (current && current.text.trim()) prompts.push(current);
      current = null;
      continue;
    }
    if (current) current.text += `${line}\n`;
  }
  if (current && current.text.trim()) prompts.push(current);

  if (!sawMarkers) {
    throw new Error(
      'could not find user/assistant turn markers in the transcript. ' +
        'Expected lines like "User:", "## User", "Human:", "Assistant:" separating turns.'
    );
  }

  return {
    sessionId: label,
    path: label,
    title: null,
    version: null,
    cwd: null,
    gitBranch: null,
    firstTs: null,
    lastTs: null,
    prompts: prompts.map((p) => ({ ...p, text: p.text.trim(), userType: 'external' })),
    index: new Map(),
    leafUuid: null,
    stats: {
      userLines: prompts.length,
      assistantLines: 0,
      toolUses: 0,
      models: [],
      filesTouched: [],
      inputTokens: 0,
      outputTokens: 0,
      interruptions: 0,
    },
    isContinuation: false,
    continuationOf: null,
  };
}
