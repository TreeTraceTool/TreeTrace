import { newSession, finalizeSession, pushTurn, flattenParts, looksSynthetic } from './shared.js';

function messageText(content) {
  if (typeof content === 'string') return content;
  return flattenParts(content);
}

function grokMessages(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.conversation)) return parsed.conversation;
  if (parsed && Array.isArray(parsed.messages)) return parsed.messages;
  return null;
}

export function detectGrok(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const messages = grokMessages(parsed);
  if (!Array.isArray(messages) || !messages.length) return false;
  return messages.every((m) => m && typeof m === 'object' && 'role' in m && 'content' in m);
}

export function parseGrok(parsed, path, sessionId) {
  const messages = grokMessages(parsed) || [];
  const session = newSession(path, (parsed && parsed.sessionId) || sessionId);
  if (parsed && parsed.model) session.stats.models.add(parsed.model);
  let turn = 0;
  for (const msg of messages) {
    if (!msg) continue;
    const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : null;
    if (msg.role === 'user') {
      const text = messageText(msg.content);
      if (looksSynthetic(text)) continue;
      pushTurn(session, ++turn, text, ts);
    } else if (msg.role === 'assistant') {
      session.stats.assistantLines++;
      if (Array.isArray(msg.tool_calls)) session.stats.toolUses += msg.tool_calls.length;
    } else if (msg.role === 'tool') {
      session.stats.toolUses++;
    }
  }
  return finalizeSession(session);
}
