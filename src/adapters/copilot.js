import { newSession, finalizeSession, pushTurn, looksSynthetic } from './shared.js';

export function detectCopilot(parsed) {
  return Boolean(
    parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.requests) &&
      (parsed.responderUsername || parsed.requesterUsername || parsed.version !== undefined)
  );
}

function userText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('\n');
  }
  return '';
}

function countResponse(session, response) {
  if (!Array.isArray(response)) return;
  for (const item of response) {
    if (item && (item.kind === 'toolInvocation' || item.kind === 'toolInvocationSerialized')) {
      session.stats.toolUses++;
    }
  }
}

export function parseCopilot(parsed, path, sessionId) {
  const session = newSession(path, parsed.sessionId || sessionId);
  let turn = 0;
  for (const req of parsed.requests) {
    if (!req) continue;
    session.stats.assistantLines++;
    countResponse(session, req.response);
    if (req.result && req.result.metadata && req.result.metadata.modelId) {
      session.stats.models.add(req.result.metadata.modelId);
    }
    const text = userText(req.message);
    if (looksSynthetic(text)) continue;
    const ts = req.timestamp ? new Date(req.timestamp).toISOString() : null;
    pushTurn(session, ++turn, text, ts);
  }
  return finalizeSession(session);
}
