import { newSession, finalizeSession, pushTurn, addAction, looksSynthetic } from './shared.js';

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

function ingestResponse(session, response, model) {
  if (!Array.isArray(response)) return;
  for (const item of response) {
    if (!item || (item.kind !== 'toolInvocation' && item.kind !== 'toolInvocationSerialized')) continue;
    session.stats.toolUses++;
    const tsd = item.toolSpecificData || {};
    const uri = tsd.uri;
    const file =
      uri && typeof uri === 'object' ? uri.path || uri.fsPath || null : typeof uri === 'string' ? uri : null;
    const command =
      typeof tsd.command === 'string' ? tsd.command : typeof tsd.commandLine === 'string' ? tsd.commandLine : null;
    if (file) session.stats.filesTouched.add(file);
    addAction(session, {
      tool: item.toolId || (item.prepareToolInvocation && item.prepareToolInvocation.toolName) || null,
      file: file || null,
      command,
      model: model || null,
    });
  }
}

export function parseCopilot(parsed, path, sessionId) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.requests)) {
    return finalizeSession(newSession(path, sessionId));
  }
  const session = newSession(path, parsed.sessionId || sessionId);
  let turn = 0;
  for (const req of parsed.requests) {
    if (!req) continue;
    session.stats.assistantLines++;
    const modelId = (req.result && req.result.metadata && req.result.metadata.modelId) || null;
    if (modelId) session.stats.models.add(modelId);
    const text = userText(req.message);
    if (!looksSynthetic(text)) {
      const ts = req.timestamp ? new Date(req.timestamp).toISOString() : null;
      pushTurn(session, ++turn, text, ts);
    }
    ingestResponse(session, req.response, modelId);
  }
  return finalizeSession(session);
}
