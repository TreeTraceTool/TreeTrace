import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { truncate } from './util.js';
import { TreetraceError, ExitCode } from './util.js';

const DAG_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

// --- Rejection / refusal / decline detection (v0.3) ---
// Named, individually-testable regex pieces composed at load time, following the
// v0.7.0 precedent for security intent and risky-command detection. Each class
// maps to one Rejection.kind. Order in TOOL_RESULT_REJECTION_PATTERNS matters:
// the first match wins, so more specific (user_declined_tool) precedes less
// specific (permission_denied, tool_execution_error).

const USER_DECLINED_TOOL_RE =
  /\bthe user (?:doesn'?t|does not|didn'?t|did not) want to proceed with this tool use\b|\bthe user (?:wants?|wanted) (?:you|me|the agent) to\b|\buser (?:rejected|declined|cancelled|canceled) (?:this|the) tool(?: use)?\b|\buser chose to reject\b/i;

const PERMISSION_DENIED_RE =
  /\bpermission denied\b|\boperation not permitted\b|\bEACCES\b|\bEPERM\b|\bcommand not found\b|\bOperation cancelled\b|\baccess is denied\b|\brequires? elevation\b/i;

const REFUSAL_TEXT_RE =
  /\b(?:i (?:can(?:'|no)t|am (?:unable|not able|not permitted) to|won['']?t|cannot|do not|don['']?t (?:think i (?:should|can)|feel comfortable)|'?m not (?:able|allowed|going) to)|(?:sorry|apolog(?:y|ies|ize))[,.]? i (?:can(?:'|no)t|am unable|won['']?t|cannot)|as (?:an? )?(?:ai|language model|assistant)[, ]+(?:i |we )?(?:can(?:'|no)t|cannot|am unable|won['']?t)|i'?m programmed (?:to decline|not to)|against my (?:guidelines|policies|programming))\b/i;

const USER_TEXT_DECLINE_RE =
  /^(?:no(?:pe)?\s*[,.)]?\s+|stop\s*[,.)]?\s+|cancel\s*[,.)]?\s+|don'?t\s+|do not\s+|don'?t do (?:that|this|it)\b|stop (?:that|this|it|doing)\b|not that one\b|scratch that\b|nevermind\b|never mind\b)/i;

// tool_result rejection classifier. Returns { kind, confidence, evidence } or null.
function classifyToolResultRejection(content) {
  const text = typeof content === 'string' ? content : '';
  if (!text) return { kind: 'tool_execution_error', confidence: 0.85, evidence: null };
  if (USER_DECLINED_TOOL_RE.test(text)) {
    return { kind: 'user_declined_tool', confidence: 1.0, evidence: truncate(text, 160) };
  }
  if (PERMISSION_DENIED_RE.test(text)) {
    return { kind: 'permission_denied', confidence: 0.85, evidence: truncate(text, 160) };
  }
  return { kind: 'tool_execution_error', confidence: 0.9, evidence: truncate(text, 160) };
}

function looksLikeRefusal(text) {
  return typeof text === 'string' && text.length <= 4000 && REFUSAL_TEXT_RE.test(text);
}

function looksLikeUserTextDecline(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > 240) return false;
  return USER_TEXT_DECLINE_RE.test(t);
}

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
      rejections: 0,
      rejectionsByKind: Object.create(null),
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
  session.stats.rejectionsByKind = { ...session.stats.rejectionsByKind };
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

// Attach a rejection to the current prompt. If no current prompt exists (e.g.
// a tool-result rejection arrives before any text prompt), synthesize a
// rejection-only prompt so the signal is never lost. O(1) per call.
function attachRejection(session, rejection) {
  if (!rejection || typeof rejection.kind !== 'string') return;
  let prompt = session._currentPrompt;
  if (!prompt) {
    prompt = {
      uuid: null,
      parentUuid: session.leafUuid || null,
      ts: rejection.ts || null,
      text: '',
      hasImage: false,
      hadToolResultContext: true,
      afterInterruption: false,
      actions: [],
      thinking: 0,
      rejections: [],
      isRejectionOnly: true,
    };
    session.prompts.push(prompt);
    session._currentPrompt = prompt;
  }
  if (!Array.isArray(prompt.rejections)) prompt.rejections = [];
  prompt.rejections.push(rejection);
  session.stats.rejections = (session.stats.rejections || 0) + 1;
  session.stats.rejectionsByKind = session.stats.rejectionsByKind || Object.create(null);
  session.stats.rejectionsByKind[rejection.kind] = (session.stats.rejectionsByKind[rejection.kind] || 0) + 1;
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
  const { text, hasImage, hasToolResult, hasOnlyToolResult, toolResults } = flattenUserContent(msg.content);

  // Tool-result-only records were previously dropped silently. Now they are
  // mined for rejections (user-decline, tool error, permission denied) before
  // being skipped as non-prompts. Synthetic-tool-result echoes from the
  // harness carry no is_error and produce no rejection.
  if (hasOnlyToolResult) {
    for (const tr of toolResults) {
      if (tr && tr.isError) {
        const cls = classifyToolResultRejection(tr.content);
        attachRejection(session, {
          kind: cls.kind,
          source: 'tool_result',
          confidence: cls.confidence,
          toolUseId: tr.toolUseId || null,
          tool: null,
          ts: rec.timestamp || null,
          evidence: cls.evidence,
        });
      }
    }
    return;
  }

  // Mixed text + tool_result: still extract any rejection signal from the
  // tool_result blocks before continuing into the text-classification path.
  if (hasToolResult && Array.isArray(toolResults)) {
    for (const tr of toolResults) {
      if (tr && tr.isError) {
        const cls = classifyToolResultRejection(tr.content);
        attachRejection(session, {
          kind: cls.kind,
          source: 'tool_result',
          confidence: cls.confidence,
          toolUseId: tr.toolUseId || null,
          tool: null,
          ts: rec.timestamp || null,
          evidence: cls.evidence,
        });
      }
    }
  }

  let trimmed = (text || '').trim();

  if (/^\[Request interrupted by user/i.test(trimmed)) {
    session.stats.interruptions++;
    session._pendingInterruption = true;
    attachRejection(session, {
      kind: 'user_interrupt',
      source: 'text',
      confidence: 1.0,
      toolUseId: null,
      tool: null,
      ts: rec.timestamp || null,
      evidence: truncate(trimmed, 160) || '[Request interrupted by user]',
    });
    return;
  }

  const classification = classifySpecialUserText(trimmed);
  if (classification === 'meta') {
    const recovered = stripWrapperMeta(trimmed);
    if (!recovered || recovered === trimmed) return;
    trimmed = recovered;
  }
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

  // Text-decline rejection: detect after we know trimmed is non-empty and is a
  // real prompt (not meta/command/compact). The placeholder this pushes doubles
  // as the canonical prompt for this turn (it already carries the rejection),
  // so we return immediately to avoid pushing a second prompt below.
  if (looksLikeUserTextDecline(trimmed)) {
    attachRejectionToText(session, rec, trimmed, 'user_text_decline', 'text', 0.8);
    session._pendingInterruption = false;
    return;
  }

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
    rejections: [],
  };
  session.prompts.push(prompt);
  session._currentPrompt = prompt;
  session._pendingInterruption = false;
}

// Variant of attachRejection that links the rejection to the prompt we are
// about to create. We push a placeholder _currentPrompt first so attachRejection
// finds it, then fill in the real fields.
function attachRejectionToText(session, rec, text, kind, source, confidence) {
  const placeholder = {
    uuid: rec.uuid || null,
    parentUuid: rec.parentUuid || null,
    ts: rec.timestamp || null,
    text,
    hasImage: false,
    hadToolResultContext: false,
    afterInterruption: Boolean(session._pendingInterruption),
    actions: [],
    thinking: 0,
    rejections: [],
  };
  session.prompts.push(placeholder);
  session._currentPrompt = placeholder;
  attachRejection(session, {
    kind,
    source,
    confidence,
    toolUseId: null,
    tool: null,
    ts: rec.timestamp || null,
    evidence: truncate(text, 160),
  });
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
  let refusedByText = false;
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text') {
      // Refusal heuristic on assistant text. Lower confidence than stop_reason
      // because phrasing overlap with normal hedging is possible.
      if (!refusedByText && looksLikeRefusal(block.text)) {
        refusedByText = true;
        attachRejection(session, {
          kind: 'model_refusal',
          source: 'text_heuristic',
          confidence: 0.7,
          toolUseId: null,
          tool: null,
          ts: rec.timestamp || null,
          evidence: truncate(typeof block.text === 'string' ? block.text : '', 160),
        });
      }
    } else if (block.type === 'tool_use') {
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

  // API-level refusal signal. Higher confidence than the text heuristic because
  // it is the provider's structured verdict, not a phrase match. If both fire,
  // both rejections are kept; downstream de-duplication collapses them by kind.
  if (msg.stop_reason === 'refusal') {
    attachRejection(session, {
      kind: 'model_refusal',
      source: 'stop_reason',
      confidence: 0.95,
      toolUseId: null,
      tool: null,
      ts: rec.timestamp || null,
      evidence: null,
    });
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
    return { text: content, hasImage: false, hasToolResult: false, hasOnlyToolResult: false, toolResults: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', hasImage: false, hasToolResult: false, hasOnlyToolResult: false, toolResults: [] };
  }
  let text = '';
  const toolResults = [];
  let others = 0;
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += (text ? '\n' : '') + block.text;
      others++;
    } else if (block.type === 'tool_result') {
      // Coerce tool_result content into a flat string. Claude Code shapes it
      // either as a string or as an array of {type:"text", text} blocks.
      const raw = block.content;
      let blockText = '';
      if (typeof raw === 'string') blockText = raw;
      else if (Array.isArray(raw)) {
        for (const part of raw) {
          if (part && typeof part === 'object' && typeof part.text === 'string') {
            blockText += (blockText ? '\n' : '') + part.text;
          } else if (typeof part === 'string') {
            blockText += (blockText ? '\n' : '') + part;
          }
        }
      }
      toolResults.push({
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
        isError: block.is_error === true,
        content: blockText,
        contentType: typeof raw === 'string' ? 'string' : Array.isArray(raw) ? 'array' : 'other',
      });
    } else if (block.type === 'image') {
      images++;
    } else {
      others++;
    }
  }
  return {
    text,
    hasImage: images > 0,
    hasToolResult: toolResults.length > 0,
    hasOnlyToolResult: toolResults.length > 0 && others === 0 && images === 0,
    toolResults,
  };
}

const COMPACT_CONTINUATION_RE =
  /^this session is being continued from a previous conversation/i;

function stripWrapperMeta(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<system-reminder>[\s\S]*$/i, '')
    .replace(/<task-notification>[\s\S]*$/i, '')
    .trim();
}

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
    throw new TreetraceError(
      'could not find user/assistant turn markers in the transcript. ' +
        'Expected lines like "User:", "## User", "Human:", "Assistant:" separating turns.',
      ExitCode.NO_DATA
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
    prompts: prompts.map((p) => ({ ...p, text: p.text.trim(), actions: [], thinking: 0, rejections: [] })),
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
      rejections: 0,
      rejectionsByKind: {},
    },
    isContinuation: false,
  };
}
