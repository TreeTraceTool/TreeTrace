import { truncate } from '../util.js';
import { looksLikeRefusal } from '../parse.js';

export function emptyStats() {
  return {
    userLines: 0,
    assistantLines: 0,
    toolUses: 0,
    models: new Set(),
    filesTouched: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    interruptions: 0,
    rejections: 0,
    rejectionsByKind: Object.create(null),
  };
}

export function newSession(path, sessionId) {
  return {
    sessionId: sessionId || null,
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
    stats: emptyStats(),
    isContinuation: false,
  };
}

export function finalizeSession(session) {
  session.stats.models = [...session.stats.models];
  session.stats.filesTouched = [...session.stats.filesTouched];
  session.stats.rejectionsByKind = { ...session.stats.rejectionsByKind };
  if (session.customTitle) session.title = session.customTitle;
  return session;
}

export function noteTimestamp(session, ts) {
  if (!ts) return;
  if (!session.firstTs) session.firstTs = ts;
  session.lastTs = ts;
}

export function pushTurn(session, idx, text, ts, { hasImage = false, hadToolResultContext = false } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed && !hasImage) return null;
  const uuid = `${session.sessionId || 'turn'}-u${idx}`;
  const parentUuid = session._lastUserUuid || null;
  session.index.set(uuid, { parentUuid, type: 'user', ts: ts || null });
  session.leafUuid = uuid;
  session._lastUserUuid = uuid;
  session.stats.userLines++;
  const prompt = {
    uuid,
    parentUuid,
    ts: ts || null,
    text: trimmed || '[image-only prompt: screenshot/annotated feedback]',
    hasImage,
    hadToolResultContext,
    afterInterruption: false,
    actions: [],
    thinking: 0,
    rejections: [],
  };
  session.prompts.push(prompt);
  session._currentPrompt = prompt;
  noteTimestamp(session, ts);
  return uuid;
}

export function addAction(session, action) {
  if (session._currentPrompt && action) session._currentPrompt.actions.push(action);
}

export function addThinking(session, n = 1) {
  if (session._currentPrompt) session._currentPrompt.thinking += n;
}

// Adapter-side helper mirroring addAction/addThinking. Adapters that read from
// sources which surface tool errors or permission denials (Codex rollouts,
// Cursor toolCalls[].error, Gemini finishReason:SAFETY, etc.) can call this so
// their rejections flow through the same schema path as native Claude Code.
export function addRejection(session, rejection) {
  if (!session._currentPrompt || !rejection || typeof rejection.kind !== 'string') return;
  if (!Array.isArray(session._currentPrompt.rejections)) session._currentPrompt.rejections = [];
  session._currentPrompt.rejections.push(rejection);
  session.stats.rejections = (session.stats.rejections || 0) + 1;
  session.stats.rejectionsByKind = session.stats.rejectionsByKind || Object.create(null);
  session.stats.rejectionsByKind[rejection.kind] = (session.stats.rejectionsByKind[rejection.kind] || 0) + 1;
}

// Scan assistant turn text for a refusal and, if found, record a model_refusal
// against the user prompt that triggered it (the current prompt). Mirrors the
// native Claude-path text heuristic (source 'text_heuristic', confidence 0.7)
// so structured-export adapters capture refusals instead of dropping them.
export function noteAssistantRefusal(session, text) {
  if (!session || !session._currentPrompt) return;
  if (!looksLikeRefusal(text)) return;
  addRejection(session, {
    kind: 'model_refusal',
    source: 'text_heuristic',
    confidence: 0.7,
    toolUseId: null,
    tool: null,
    ts: null,
    evidence: truncate(typeof text === 'string' ? text : '', 160),
  });
}

export function flattenParts(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) {
    if (parts && typeof parts === 'object' && typeof parts.text === 'string') return parts.text;
    return '';
  }
  const out = [];
  for (const part of parts) {
    if (typeof part === 'string') out.push(part);
    else if (part && typeof part === 'object' && typeof part.text === 'string') out.push(part.text);
  }
  return out.join('\n');
}

export function looksSynthetic(text) {
  const t = (text || '').trimStart();
  if (!t) return true;
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('<collaboration_mode>') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<system-reminder>')
  );
}

export function readJson(text) {
  return JSON.parse(text);
}

export function readJsonl(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charCodeAt(0) !== 123) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return records;
}
