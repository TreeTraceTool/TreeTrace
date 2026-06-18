import { basename } from 'node:path';
import { detectCodex, parseCodex } from './codex.js';
import { detectGemini, detectGeminiJson, parseGemini, parseGeminiJson } from './gemini.js';
import { detectChatGPT, parseChatGPT } from './chatgpt.js';
import { detectCopilot, parseCopilot } from './copilot.js';
import { detectGrok, parseGrok } from './grok.js';
import { detectCursor, parseCursor } from './cursor.js';
import { TreetraceError, ExitCode } from '../util.js';

export const TOOLS = ['claude', 'codex', 'chatgpt', 'gemini', 'copilot', 'grok', 'cursor', 'transcript'];

function tryParseJson(text) {
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function adaptFrom(tool, text, path) {
  const id = basename(path).replace(/\.(jsonl?|txt|md)$/i, '');
  const json = tryParseJson(text);
  switch (tool) {
    case 'codex':
      return [parseCodex(text, path, id)];
    case 'gemini':
      return json ? [parseGeminiJson(json, path, id)] : [parseGemini(text, path, id)];
    case 'chatgpt':
      return parseChatGPT(json, path);
    case 'copilot':
      return [parseCopilot(json, path, id)];
    case 'grok':
      return [parseGrok(json, path, id)];
    case 'cursor':
      return [parseCursor(json, path, id)];
    default:
      throw new TreetraceError(`unknown --from tool "${tool}" (expected one of: ${TOOLS.join(', ')})`, ExitCode.USAGE);
  }
}

export function autoAdapt(text, path) {
  const id = basename(path).replace(/\.(jsonl?|txt|md)$/i, '');
  const json = tryParseJson(text);

  if (json !== null) {
    if (detectChatGPT(json)) return { tool: 'chatgpt', sessions: parseChatGPT(json, path) };
    if (detectCopilot(json)) return { tool: 'copilot', sessions: [parseCopilot(json, path, id)] };
    if (detectGeminiJson(json)) return { tool: 'gemini', sessions: [parseGeminiJson(json, path, id)] };
    if (detectCursor(json)) return { tool: 'cursor', sessions: [parseCursor(json, path, id)] };
    if (detectGrok(json)) return { tool: 'grok', sessions: [parseGrok(json, path, id)] };
    return null;
  }

  if (detectCodex(text)) return { tool: 'codex', sessions: [parseCodex(text, path, id)] };
  if (detectGemini(text)) return { tool: 'gemini', sessions: [parseGemini(text, path, id)] };
  return null;
}
