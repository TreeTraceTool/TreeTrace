import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Streaming parser for Claude Code session JSONL files.
 *
 * Built against a 579-file / ~195k-line corpus census (format versions
 * 2.1.133-2.1.173). Key realities encoded here:
 *  - Records form a DAG per file; chains pass THROUGH system/attachment
 *    nodes, so all addressable node types must be indexed.
 *  - One API assistant message = N jsonl records sharing message.id, with
 *    usage repeated on every split — merge or token stats inflate 2-4×.
 *  - Compaction restarts the chain (parentUuid:null) but provides
 *    logicalParentUuid to stitch through.
 *  - userType is 'external' on every record including agent-authored ones —
 *    never a human discriminator. Sidechains live in separate files.
 *  - The last `last-prompt` record's leafUuid is the live branch tip.
 *  - Session files reach 200MB+ (multi-MB base64 lines): stream, never buffer.
 */

const DAG_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

export async function parseSessionFile(path, sessionMeta = {}) {
  const session = {
    sessionId: sessionMeta.sessionId || null,
    path,
    title: null,
    customTitle: null,
    version: null,
    cwd: null,
    gitBranch: null,
    firstTs: null,
    lastTs: null,
    prompts: [], // candidate human prompts (full text retained)
    index: new Map(), // uuid -> { parentUuid, type, ts } for all DAG records
    leafUuid: null, // last addressable record seen (fallback branch tip)
    activeLeafUuid: null, // from last `last-prompt` record (authoritative)
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
    isContinuation: false,
    _usageByMsgId: new Map(), // assistant split merge: last record's usage wins
    _pendingInterruption: false,
  };

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // truncated/corrupt line (live files mutate mid-scan)
    }
    try {
      ingestRecord(session, rec);
    } catch {
      continue; // unknown shape — tolerate, never crash
    }
  }
  rl.close();

  // fold merged assistant usage into totals
  for (const usage of session._usageByMsgId.values()) {
    session.stats.inputTokens += usage.input_tokens || 0;
    session.stats.outputTokens += usage.output_tokens || 0;
  }
  session._usageByMsgId = null;

  if (session.customTitle) session.title = session.customTitle;
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
    case 'system':
      indexDagNode(session, rec, {
        // compaction boundary restarts parentUuid; stitch the logical chain
        parentOverride:
          rec.subtype === 'compact_boundary' && rec.logicalParentUuid
            ? rec.logicalParentUuid
            : undefined,
      });
      break;
    case 'attachment':
      indexDagNode(session, rec); // chains pass through attachments
      break;
    case 'summary': // legacy (<2.1.133)
      if (rec.summary && !session.title) session.title = rec.summary;
      break;
    case 'ai-title': // last occurrence wins
      if (rec.aiTitle || rec.title) session.title = rec.aiTitle || rec.title;
      break;
    case 'custom-title': // user-set, beats ai-title
      if (rec.customTitle) session.customTitle = rec.customTitle;
      break;
    case 'last-prompt': // last occurrence's leafUuid = live branch tip
      if (rec.leafUuid) session.activeLeafUuid = rec.leafUuid;
      break;
    default:
      // mode, permission-mode, bridge-session, queue-operation,
      // file-history-snapshot, unknown future types — not lineage material
      break;
  }

  if (!session.sessionId && rec.sessionId) session.sessionId = rec.sessionId;
  if (!session.version && rec.version) session.version = rec.version;
  if (!session.cwd && rec.cwd) session.cwd = rec.cwd;
  if (!session.gitBranch && rec.gitBranch) session.gitBranch = rec.gitBranch;
  if (rec.timestamp && DAG_TYPES.has(rec.type)) {
    if (!session.firstTs) session.firstTs = rec.timestamp;
    session.lastTs = rec.timestamp;
  }
}

function indexDagNode(session, rec, { parentOverride } = {}) {
  if (!rec.uuid) return;
  session.index.set(rec.uuid, {
    parentUuid: parentOverride !== undefined ? parentOverride : rec.parentUuid || null,
    type: rec.type,
    ts: rec.timestamp || null,
  });
  if (!rec.isSidechain) session.leafUuid = rec.uuid;
}

function ingestUser(session, rec) {
  // Sidechain traffic is agent-authored even when it mimics human voice.
  // (Sidechains live in separate files; belt-and-suspenders for inline ones.)
  if (rec.isSidechain || rec.agentId) return;
  indexDagNode(session, rec);
  session.stats.userLines++;

  // Tool plumbing: results echo back as user records (~90% of user lines),
  // marked by toolUseResult / sourceToolAssistantUUID even for string content.
  if (rec.toolUseResult !== undefined || rec.sourceToolAssistantUUID !== undefined) return;

  if (rec.isMeta) return; // caveats, skill-body injections
  if (rec.isCompactSummary) {
    session.isContinuation = true;
    return;
  }
  if (rec.promptSource === 'system' || rec.promptSource === 'sdk') return;
  if (rec.origin && rec.origin.kind === 'task-notification') return;

  const msg = rec.message || {};
  const { text, hasImage, hasToolResult, hasOnlyToolResult } = flattenUserContent(msg.content);
  if (hasOnlyToolResult) return;

  let trimmed = (text || '').trim();

  if (/^\[Request interrupted by user/i.test(trimmed)) {
    session.stats.interruptions++;
    session._pendingInterruption = true;
    return;
  }

  const classification = classifySpecialUserText(trimmed);
  if (classification === 'meta') return;
  if (classification === 'compact-continuation') {
    session.isContinuation = true;
    return;
  }
  if (classification === 'command') {
    // Slash-command wrappers are noise — unless the human packed real intent
    // into the args (e.g. `/loop <multi-line work focus>`).
    const invocation = extractCommandInvocation(trimmed);
    if (!invocation) return;
    trimmed = invocation;
  }

  // Image-only records are often screenshot feedback — meaningful, keep.
  if (!trimmed && hasImage) trimmed = '[image-only prompt: screenshot/annotated feedback]';
  if (!trimmed) return;

  session.prompts.push({
    uuid: rec.uuid || null,
    parentUuid: rec.parentUuid || null,
    ts: rec.timestamp || null,
    text: trimmed,
    hasImage,
    hadToolResultContext: hasToolResult,
    afterInterruption: Boolean(session._pendingInterruption),
  });
  session._pendingInterruption = false;
}

function ingestAssistant(session, rec) {
  if (rec.isSidechain || rec.agentId) return;
  indexDagNode(session, rec);
  session.stats.assistantLines++;

  const msg = rec.message || {};
  const synthetic = msg.model === '<synthetic>' || rec.isApiErrorMessage;

  if (msg.model && !synthetic) session.stats.models.add(msg.model);
  // One API message = N split records sharing message.id, usage repeated on
  // each (main sessions) or present only on the last (subagent files):
  // keep the latest non-empty usage per id, sum after parsing.
  if (msg.usage && !synthetic && (msg.usage.input_tokens || msg.usage.output_tokens)) {
    session._usageByMsgId.set(msg.id || rec.uuid, msg.usage);
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
    return { text: content, hasImage: false, hasToolResult: false, hasOnlyToolResult: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', hasImage: false, hasToolResult: false, hasOnlyToolResult: false };
  }
  let text = '';
  let toolResults = 0;
  let others = 0;
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += (text ? '\n' : '') + block.text;
      others++;
    } else if (block.type === 'tool_result') {
      toolResults++;
    } else if (block.type === 'image') {
      images++;
    } else {
      others++; // documents, future block types
    }
  }
  return {
    text,
    hasImage: images > 0,
    hasToolResult: toolResults > 0,
    hasOnlyToolResult: toolResults > 0 && others === 0 && images === 0,
  };
}

const COMPACT_CONTINUATION_RE =
  /^this session is being continued from a previous conversation/i;

export function classifySpecialUserText(text) {
  if (COMPACT_CONTINUATION_RE.test(text)) return 'compact-continuation';
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

// `/loop de-swamp & polish ...` — wrapper noise, but non-empty <command-args>
// is the human's actual instruction. Returns reconstructed text or null.
export function extractCommandInvocation(text) {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim();
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  if (!args) return null;
  return `${name || '(command)'} ${args}`;
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
    prompts: prompts.map((p) => ({ ...p, text: p.text.trim() })),
    index: new Map(),
    leafUuid: null,
    activeLeafUuid: null,
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
  };
}
