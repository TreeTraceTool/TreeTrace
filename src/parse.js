import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

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
    prompts: [],
    index: new Map(),
    leafUuid: null,
    activeLeafUuid: null,
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
    _usageByMsgId: new Map(),
    _pendingInterruption: false,
    _currentPrompt: null,
  };

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line || line.charCodeAt(0) !== 123 ) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      ingestRecord(session, rec);
    } catch {
      continue;
    }
  }
  rl.close();

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

        parentOverride:
          rec.subtype === 'compact_boundary' && rec.logicalParentUuid
            ? rec.logicalParentUuid
            : undefined,
      });
      break;
    case 'attachment':
      indexDagNode(session, rec);
      break;
    case 'summary':
      if (rec.summary && !session.title) session.title = rec.summary;
      break;
    case 'ai-title':
      if (rec.aiTitle || rec.title) session.title = rec.aiTitle || rec.title;
      break;
    case 'custom-title':
      if (rec.customTitle) session.customTitle = rec.customTitle;
      break;
    case 'last-prompt':
      if (rec.leafUuid) session.activeLeafUuid = rec.leafUuid;
      break;
    default:

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

  if (rec.isSidechain || rec.agentId) return;
  indexDagNode(session, rec);
  session.stats.userLines++;

  if (rec.toolUseResult !== undefined || rec.sourceToolAssistantUUID !== undefined) return;

  if (rec.isMeta) return;
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

    const invocation = extractCommandInvocation(trimmed);
    if (!invocation) return;
    trimmed = invocation;
  }

  if (!trimmed && hasImage) trimmed = '[image-only prompt: screenshot/annotated feedback]';
  if (!trimmed) return;

  const prompt = {
    uuid: rec.uuid || null,
    parentUuid: rec.parentUuid || null,
    ts: rec.timestamp || null,
    text: trimmed,
    hasImage,
    hadToolResultContext: hasToolResult,
    afterInterruption: Boolean(session._pendingInterruption),
    actions: [],
    thinking: 0,
  };
  session.prompts.push(prompt);
  session._currentPrompt = prompt;
  session._pendingInterruption = false;
}

function ingestAssistant(session, rec) {
  if (rec.isSidechain || rec.agentId) return;
  indexDagNode(session, rec);
  session.stats.assistantLines++;

  const msg = rec.message || {};
  const synthetic = msg.model === '<synthetic>' || rec.isApiErrorMessage;

  if (msg.model && !synthetic) session.stats.models.add(msg.model);

  if (msg.usage && !synthetic && (msg.usage.input_tokens || msg.usage.output_tokens)) {
    session._usageByMsgId.set(msg.id || rec.uuid, msg.usage);
  }

  const current = session._currentPrompt;
  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'tool_use') {
      session.stats.toolUses++;
      const input = block.input || {};
      const file = input.file_path || input.notebook_path || null;
      if (typeof file === 'string') session.stats.filesTouched.add(file);
      if (current) {
        current.actions.push({
          tool: block.name || null,
          file: typeof file === 'string' ? file : null,
          command: block.name === 'Bash' && typeof input.command === 'string' ? input.command : null,
          input: summarizeToolInput(block.name, input),
          model: synthetic ? null : msg.model || null,
        });
      }
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      if (current) current.thinking++;
    }
  }
}

const INPUT_CAP = 300;

function summarizeToolInput(tool, input) {
  if (!input || typeof input !== 'object') return null;
  let raw;
  switch (tool) {
    case 'Bash':
      raw = typeof input.command === 'string' ? input.command : compactJson(input);
      break;
    case 'Edit':
      raw = typeof input.new_string === 'string' ? input.new_string : compactJson(input);
      break;
    case 'Write':
      raw = typeof input.content === 'string' ? input.content : compactJson(input);
      break;
    case 'WebFetch':
      raw = [input.url, input.prompt].filter((v) => typeof v === 'string').join(' ') || compactJson(input);
      break;
    default:
      raw = compactJson(input);
  }
  if (!raw) return null;
  raw = raw.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  return raw.length > INPUT_CAP ? `${raw.slice(0, INPUT_CAP)}...` : raw;
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
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
      others++;
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

export function extractCommandInvocation(text) {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim();
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  if (!args) return null;
  return `${name || '(command)'} ${args}`;
}

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
    prompts: prompts.map((p) => ({ ...p, text: p.text.trim(), actions: [], thinking: 0 })),
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
