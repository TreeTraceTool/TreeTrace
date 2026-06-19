import { newSession, finalizeSession, pushTurn, flattenParts, looksSynthetic, noteAssistantRefusal } from './shared.js';

function conversationList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.conversations)) return parsed.conversations;
  if (parsed && parsed.mapping && typeof parsed.mapping === 'object') return [parsed];
  return [];
}

export function detectChatGPT(parsed) {
  const list = conversationList(parsed);
  if (!list.length) return false;
  const first = list[0];
  return Boolean(first && first.mapping && typeof first.mapping === 'object');
}

export function parseChatGPT(parsed, path) {
  const conversations = conversationList(parsed);
  const sessions = [];
  for (let i = 0; i < conversations.length; i++) {
    const convo = conversations[i];
    if (!convo || !convo.mapping) continue;
    const session = sessionFromConversation(convo, path, i);
    if (session.prompts.length) sessions.push(session);
  }
  return sessions;
}

function sessionFromConversation(convo, path, index) {
  const id = convo.conversation_id || convo.id || `chatgpt-${index + 1}`;
  const session = newSession(path, id);
  if (convo.title) session.title = convo.title;

  const ordered = orderNodes(convo.mapping);
  let turn = 0;
  for (const node of ordered) {
    const msg = node.message;
    if (!msg || !msg.author) continue;
    const role = msg.author.role;
    const text = flattenParts(msg.content && msg.content.parts);
    const ts = msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null;

    if (role === 'user') {
      if (looksSynthetic(text)) continue;
      pushTurn(session, ++turn, text, ts);
    } else if (role === 'assistant') {
      session.stats.assistantLines++;
      if (msg.metadata && msg.metadata.model_slug) session.stats.models.add(msg.metadata.model_slug);
      noteAssistantRefusal(session, text);
    } else if (role === 'tool') {
      session.stats.toolUses++;
    }
  }
  return finalizeSession(session);
}

function orderNodes(mapping) {
  const nodes = Object.values(mapping).filter((n) => n && n.message);
  const withTime = nodes.filter((n) => typeof n.message.create_time === 'number');
  if (withTime.length === nodes.length && nodes.length) {
    return nodes.slice().sort((a, b) => a.message.create_time - b.message.create_time);
  }
  return walkFromRoot(mapping);
}

function walkFromRoot(mapping) {
  let rootId = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (node && (node.parent === null || node.parent === undefined)) {
      rootId = id;
      break;
    }
  }
  const out = [];
  const seen = new Set();
  let cur = rootId;
  while (cur && mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    out.push(mapping[cur]);
    const children = mapping[cur].children || [];
    cur = children.length ? children[children.length - 1] : null;
  }
  return out;
}
