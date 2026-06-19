import { newSession, finalizeSession, pushTurn, addAction, looksSynthetic, noteAssistantRefusal } from './shared.js';

function parseCursorParams(tfd) {
  const raw = tfd && (tfd.params || tfd.rawArgs);
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function cursorToolFile(tfd) {
  const p = parseCursorParams(tfd);
  return (p && (p.file_path || p.path || p.target_file || p.relativePath)) || null;
}

function cursorToolCommand(tfd) {
  const p = parseCursorParams(tfd);
  return p && typeof p.command === 'string' ? p.command : null;
}

function isUserBubble(bubble) {
  if (bubble.type === 1 || bubble.type === 'user') return true;
  if (bubble.type === 2 || bubble.type === 'ai' || bubble.type === 'assistant') return false;
  if (typeof bubble.role === 'string') return bubble.role === 'user';
  return false;
}

function bubbleText(bubble) {
  if (typeof bubble.text === 'string') return bubble.text;
  if (typeof bubble.content === 'string') return bubble.content;
  if (typeof bubble.richText === 'string') return bubble.richText;
  return '';
}

function collectBubbles(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.bubbles)) return parsed.bubbles;
  if (Array.isArray(parsed.tabs)) {
    const out = [];
    for (const tab of parsed.tabs) {
      if (tab && Array.isArray(tab.bubbles)) out.push(...tab.bubbles);
      else if (tab && Array.isArray(tab.messages)) out.push(...tab.messages);
    }
    return out;
  }
  if (Array.isArray(parsed.conversation)) return parsed.conversation;
  if (Array.isArray(parsed.messages)) return parsed.messages;
  return null;
}

function isExportedSession(parsed) {
  return Boolean(
    parsed &&
      !Array.isArray(parsed) &&
      Array.isArray(parsed.messages) &&
      parsed.messages.some((m) => m && typeof m.role === 'string' && 'content' in m)
  );
}

function parseExportedSession(parsed, path, sessionId) {
  const session = newSession(path, parsed.id || parsed.sessionId || sessionId);
  if (parsed.title) session.title = parsed.title;
  let turn = 0;
  for (const msg of parsed.messages) {
    if (!msg) continue;
    const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : null;
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (looksSynthetic(text)) continue;
      pushTurn(session, ++turn, text, ts);
    } else if (msg.role === 'assistant') {
      session.stats.assistantLines++;
      if (msg.model) session.stats.models.add(msg.model);
      if (typeof msg.content === 'string') noteAssistantRefusal(session, msg.content);
      if (Array.isArray(msg.toolCalls)) {
        for (const call of msg.toolCalls) {
          session.stats.toolUses++;
          const file = call && (call.filePath || (call.args && (call.args.file_path || call.args.path)));
          if (typeof file === 'string') session.stats.filesTouched.add(file);
          addAction(session, {
            tool: (call && call.name) || null,
            file: typeof file === 'string' ? file : null,
            command: call && call.args && typeof call.args.command === 'string' ? call.args.command : null,
            model: msg.model || null,
          });
        }
      }
    }
  }
  return finalizeSession(session);
}

function promptList(parsed) {
  if (Array.isArray(parsed.prompts)) return parsed.prompts;
  if (parsed['aiService.prompts'] && Array.isArray(parsed['aiService.prompts'])) {
    return parsed['aiService.prompts'];
  }
  return null;
}

export function detectCursor(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.cursorExport || parsed._tool === 'cursor') return true;
  if (isExportedSession(parsed) && (parsed.workspaceId !== undefined || parsed.index !== undefined || parsed.activeBranchBubbleIds !== undefined)) {
    return true;
  }
  if (Array.isArray(parsed.tabs)) return true;
  if (promptList(parsed)) return true;
  const bubbles = collectBubbles(parsed);
  if (Array.isArray(bubbles) && bubbles.length) {
    return bubbles.some((b) => b && (b.bubbleId !== undefined || b.type === 1 || b.type === 2 || b.type === 'ai'));
  }
  return false;
}

export function parseCursor(parsed, path, sessionId) {
  if (!parsed || typeof parsed !== 'object') {
    return finalizeSession(newSession(path, sessionId));
  }
  const session = newSession(path, (parsed && parsed.composerId) || (parsed && parsed.sessionId) || sessionId);
  if (parsed && parsed.title) session.title = parsed.title;
  let turn = 0;

  if (isExportedSession(parsed)) {
    return parseExportedSession(parsed, path, sessionId);
  }

  const prompts = promptList(parsed);
  if (prompts) {
    for (const p of prompts) {
      const text = typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : '';
      if (looksSynthetic(text)) continue;
      pushTurn(session, ++turn, text, null);
    }
    return finalizeSession(session);
  }

  const bubbles = collectBubbles(parsed) || [];
  for (const bubble of bubbles) {
    if (!bubble) continue;
    if (isUserBubble(bubble)) {
      const text = bubbleText(bubble);
      if (looksSynthetic(text)) continue;
      const ts = bubble.createdAt ? new Date(bubble.createdAt).toISOString() : null;
      pushTurn(session, ++turn, text, ts);
    } else {
      session.stats.assistantLines++;
      noteAssistantRefusal(session, bubbleText(bubble));
      if (bubble.toolFormerData) {
        session.stats.toolUses++;
        const tfd = bubble.toolFormerData;
        const file = cursorToolFile(tfd);
        if (typeof file === 'string') session.stats.filesTouched.add(file);
        addAction(session, {
          tool: tfd.name || null,
          file: file || null,
          command: cursorToolCommand(tfd),
          model: bubble.model || null,
        });
      }
    }
  }
  return finalizeSession(session);
}
