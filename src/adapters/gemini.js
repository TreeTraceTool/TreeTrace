import {
  newSession,
  finalizeSession,
  pushTurn,
  addAction,
  addThinking,
  flattenParts,
  looksSynthetic,
  readJsonl,
} from './shared.js';

function partsToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const part of content) {
      if (typeof part === 'string') out.push(part);
      else if (part && typeof part.text === 'string') out.push(part.text);
    }
    return out.join('\n');
  }
  return flattenParts(content);
}

function ingestRecord(session, rec, counters) {
  const type = rec.type || rec.role;
  const ts = rec.timestamp || null;
  if (type === 'user') {
    const text = partsToText(rec.content);
    if (looksSynthetic(text)) return;
    pushTurn(session, ++counters.turn, text, ts);
  } else if (type === 'gemini' || type === 'model' || type === 'assistant') {
    session.stats.assistantLines++;
    if (rec.model) session.stats.models.add(rec.model);
    if (Array.isArray(rec.toolCalls)) {
      for (const call of rec.toolCalls) {
        session.stats.toolUses++;
        const file = call && call.args && (call.args.file_path || call.args.path || call.args.absolute_path);
        if (typeof file === 'string') session.stats.filesTouched.add(file);
        addAction(session, {
          tool: (call && call.name) || null,
          file: typeof file === 'string' ? file : null,
          command: call && call.args && typeof call.args.command === 'string' ? call.args.command : null,
          model: rec.model || null,
        });
      }
    }
    if (Array.isArray(rec.thoughts) && rec.thoughts.length) addThinking(session, rec.thoughts.length);
    if (rec.tokens) {
      session.stats.inputTokens += rec.tokens.prompt || rec.tokens.input || 0;
      session.stats.outputTokens += rec.tokens.candidate || rec.tokens.output || 0;
    }
  }
}

export function detectGemini(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charCodeAt(0) !== 123) continue;
    try {
      const rec = JSON.parse(trimmed);
      if ((rec.type === 'user' || rec.type === 'gemini') && 'content' in rec) return true;
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

export function detectGeminiJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!Array.isArray(parsed.messages)) return false;
  return parsed.messages.some((m) => m && (m.type === 'gemini' || m.type === 'user') && 'content' in m);
}

export function parseGemini(text, path, sessionId) {
  const session = newSession(path, sessionId);
  const counters = { turn: 0 };
  for (const rec of readJsonl(text)) ingestRecord(session, rec, counters);
  return finalizeSession(session);
}

export function parseGeminiJson(parsed, path, sessionId) {
  const session = newSession(path, parsed.sessionId || sessionId);
  if (parsed.model) session.stats.models.add(parsed.model);
  const counters = { turn: 0 };
  for (const rec of parsed.messages) ingestRecord(session, rec, counters);
  return finalizeSession(session);
}
