import { truncate } from './util.js';

const KIND = {
  ROOT: 'root',
  DIRECTION: 'direction',
  CORRECTION: 'correction',
  SCOPE: 'scope-change',
  CHECKPOINT: 'checkpoint',
  QUESTION: 'question',
};

const CORRECTION_STRONG_OPENERS =
  /^(no[,.\s]|no$|not |don'?t |stop\b|wrong\b|undo\b|revert\b|nope\b|that'?s (not|wrong)|why did you)/i;
const CORRECTION_ANYWHERE =
  /(didn'?t work|doesn'?t work|not working|still (failing|broken|wrong|not)|that broke|you (missed|forgot|skipped|ignored)|redo (this|that|it)|go back|that'?s incorrect|not what i (asked|meant|wanted)|undo (this|that)|roll(?: |-)?back)/i;

const CORRECTION_SOFT_OPENERS = /^(wait\b|actually[,\s]|hold on\b|hmm[,\s]|instead[,\s])/i;

const SCOPE_ANYWHERE =
  /(also (add|build|make|create|include)|now (add|build|make|let'?s)|new (feature|requirement|idea)|let'?s also|switch to|pivot|change of plans|from now on|going forward|next phase|instead of .{3,40}(do|use|build|make)|scrap (that|this)|forget (that|this)|rather than)/i;

const CHECKPOINT_ANYWHERE =
  /^(commit|push|publish|ship|deploy|release)\b|(write (up|a) (summary|report|readme)|summari[sz]e (what|the|this)|status update|where are we|what'?s (left|remaining|the status)|wrap (this |it )?up|document (what|this|the)|hand ?off|save (your |our )?progress)/i;

const QUESTION_ONLY =
  /^(what|how|why|where|when|which|who|is|are|can|could|should|would|will|do|does|did)\b[^]*\?\s*$/i;

const CONTINUATION_RE =
  /^(y|yes|yep|yeah|ok|okay|k|sure|continue|cont|go|go ahead|do it|proceed|next|sounds good|looks good|lgtm|perfect|nice|good|great|approved?|yes please|please do|carry on|keep going|resume|finish|all good|that works|works|👍|do that)[.! ]*$/i;

const SELECTION_RE = /^(?:option\s+)?([0-9]{1,2}|[a-d])[.)! ]*$/i;

const IGNORE_RE = /\bignore this\b/i;

const MAX_NUDGE_WORDS = 4;

export function classifyPrompts(sessions) {
  const nodes = [];
  let rootAssigned = false;

  for (const session of sessions) {
    let prevNode = null;
    for (const prompt of session.prompts) {
      const text = prompt.text;
      const words = text.split(/\s+/).filter(Boolean);

      if (prevNode && isDupOf(prevNode.text, text)) {
        if (text.length > prevNode.text.length) {
          prevNode.text = text;
          prevNode.title = makeTitle(text);
          prevNode.kind = prevNode.kind === KIND.ROOT ? KIND.ROOT : classifyOne(text, prompt, true);
          prevNode.chars = text.length;
        }
        mergeActions(prevNode, prompt);
        continue;
      }

      if (prevNode && isRerunOf(prevNode.text, text)) {
        prevNode.reruns = (prevNode.reruns || 0) + 1;
        prevNode.text = text;
        prevNode.title = makeTitle(text);
        mergeActions(prevNode, prompt);
        continue;
      }

      if (
        prevNode &&
        words.length <= MAX_NUDGE_WORDS &&
        CONTINUATION_RE.test(text)
      ) {
        prevNode.nudges++;
        mergeActions(prevNode, prompt);
        continue;
      }

      if (words.length <= 6 && IGNORE_RE.test(text)) continue;

      const selection = rootAssigned && SELECTION_RE.exec(text);
      const node = selection ? {
        id: null,
        uuid: prompt.uuid,
        parentUuid: prompt.parentUuid,
        sessionId: session.sessionId,
        ts: prompt.ts,
        text,
        title: `Chose option ${selection[1].toUpperCase()} from the proposed menu`,
        kind: KIND.DIRECTION,
        status: 'accepted',
        nudges: 0,
        afterInterruption: prompt.afterInterruption,
        actions: prompt.actions || [],
        thinking: prompt.thinking || 0,
        chars: text.length,
      } : {
        id: null,
        uuid: prompt.uuid,
        parentUuid: prompt.parentUuid,
        sessionId: session.sessionId,
        ts: prompt.ts,
        text,
        title: makeTitle(text),
        kind: classifyOne(text, prompt, rootAssigned),
        status: 'accepted',
        nudges: 0,
        afterInterruption: prompt.afterInterruption,
        actions: prompt.actions || [],
        thinking: prompt.thinking || 0,
        chars: text.length,
      };
      if (node.kind === KIND.ROOT) rootAssigned = true;
      nodes.push(node);
      prevNode = node;
    }
  }
  return nodes;
}

function isDupOf(a, b) {
  const na = a.replace(/\s+/g, ' ').trim();
  const nb = b.replace(/\s+/g, ' ').trim();
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length < 24) return false;

  return long.startsWith(short.slice(0, short.length - 4));
}

function isRerunOf(a, b) {
  const na = a.replace(/\s+/g, ' ').trim();
  const nb = b.replace(/\s+/g, ' ').trim();
  if (na.length < 40 || nb.length < 40) return false;
  if (na.slice(0, 24) !== nb.slice(0, 24)) return false;

  if (na.startsWith('/') && na.slice(0, 32) === nb.slice(0, 32)) return true;
  const limit = Math.min(na.length, nb.length);
  let common = 0;
  while (common < limit && na[common] === nb[common]) common++;
  return common / limit >= 0.5;
}

function classifyOne(text, prompt, rootAssigned) {
  if (!rootAssigned) return KIND.ROOT;
  if (CORRECTION_STRONG_OPENERS.test(text) || CORRECTION_ANYWHERE.test(text)) return KIND.CORRECTION;
  if (SCOPE_ANYWHERE.test(text)) return KIND.SCOPE;
  if (CHECKPOINT_ANYWHERE.test(text)) return KIND.CHECKPOINT;
  if (CORRECTION_SOFT_OPENERS.test(text)) return KIND.CORRECTION;
  if (QUESTION_ONLY.test(text) && text.length < 250) return KIND.QUESTION;
  return KIND.DIRECTION;
}

export function makeTitle(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || text;
  const sentence = firstLine.split(/(?<=[.!?])\s+/)[0] || firstLine;
  return truncate(sentence, 96);
}

function mergeActions(node, prompt) {
  node.actions = node.actions || [];
  if (prompt.actions && prompt.actions.length) node.actions.push(...prompt.actions);
  if (prompt.thinking) node.thinking = (node.thinking || 0) + prompt.thinking;
}

export { KIND };
