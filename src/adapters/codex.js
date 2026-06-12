import {
  newSession,
  finalizeSession,
  pushTurn,
  flattenParts,
  looksSynthetic,
  readJsonl,
} from './shared.js';

export function detectCodex(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charCodeAt(0) !== 123) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec.type === 'session_meta' && rec.payload && rec.payload.originator) return true;
      if (rec.type === 'response_item' || rec.type === 'turn_context') return true;
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

export function parseCodex(text, path, sessionId) {
  const session = newSession(path, sessionId);
  const records = readJsonl(text);
  let turn = 0;

  for (const rec of records) {
    const ts = rec.timestamp || null;
    const payload = rec.payload || {};

    if (rec.type === 'session_meta') {
      if (payload.id && !session.sessionId) session.sessionId = payload.id;
      if (payload.cwd) session.cwd = payload.cwd;
      if (payload.cli_version) session.version = payload.cli_version;
      if (payload.git && payload.git.branch) session.gitBranch = payload.git.branch;
      continue;
    }

    if (rec.type === 'response_item' && payload.type === 'message') {
      if (payload.role === 'user') {
        const body = flattenParts(payload.content);
        if (looksSynthetic(body)) continue;
        pushTurn(session, ++turn, body, ts);
      } else if (payload.role === 'assistant') {
        session.stats.assistantLines++;
      }
      continue;
    }

    if (rec.type === 'response_item' && payload.type === 'function_call') {
      session.stats.toolUses++;
      const file = filePathFromArgs(payload.arguments);
      if (file) session.stats.filesTouched.add(file);
      continue;
    }

    if (rec.type === 'event_msg' && payload.type === 'token_count') {
      const usage = payload.info && payload.info.total_token_usage;
      if (usage) {
        session.stats.inputTokens = usage.input_tokens || session.stats.inputTokens;
        session.stats.outputTokens = usage.output_tokens || session.stats.outputTokens;
      }
      continue;
    }

    if (rec.type === 'turn_context' && payload.model) {
      session.stats.models.add(payload.model);
    }
  }

  return finalizeSession(session);
}

function filePathFromArgs(args) {
  if (!args || typeof args !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  return parsed.path || parsed.file_path || parsed.filePath || null;
}
