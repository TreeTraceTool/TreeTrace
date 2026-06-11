import { truncate } from './util.js';

/**
 * Classify candidate human prompts into lineage roles and fold noise.
 *
 * Deterministic by design: the same transcript always produces the same tree.
 * An optional --llm pass (the user's own model) may later retitle nodes, but
 * classification never depends on it.
 */

const KIND = {
  ROOT: 'root',
  DIRECTION: 'direction',
  CORRECTION: 'correction',
  SCOPE: 'scope-change',
  CHECKPOINT: 'checkpoint',
  QUESTION: 'question',
};

// Strong correction signals: explicit negation/undo — these outrank scope.
const CORRECTION_STRONG_OPENERS =
  /^(no[,.\s]|no$|not |don'?t |stop\b|wrong\b|undo\b|revert\b|nope\b|that'?s (not|wrong)|why did you)/i;
const CORRECTION_ANYWHERE =
  /(didn'?t work|doesn'?t work|not working|still (failing|broken|wrong|not)|that broke|you (missed|forgot|skipped|ignored)|redo (this|that|it)|go back|that'?s incorrect|not what i (asked|meant|wanted)|undo (this|that)|roll(?: |-)?back)/i;
// Soft correction signals: conversational pivots — only count when nothing
// stronger (like an additive scope change) explains the message.
const CORRECTION_SOFT_OPENERS = /^(wait\b|actually[,\s]|hold on\b|hmm[,\s]|instead[,\s])/i;

const SCOPE_ANYWHERE =
  /(also (add|build|make|create|include)|now (add|build|make|let'?s)|new (feature|requirement|idea)|let'?s also|switch to|pivot|change of plans|from now on|going forward|next phase|instead of .{3,40}(do|use|build|make)|scrap (that|this)|forget (that|this)|rather than)/i;

const CHECKPOINT_ANYWHERE =
  /^(commit|push|publish|ship|deploy|release)\b|(write (up|a) (summary|report|readme)|summari[sz]e (what|the|this)|status update|where are we|what'?s (left|remaining|the status)|wrap (this |it )?up|document (what|this|the)|hand ?off|save (your |our )?progress)/i;

const QUESTION_ONLY =
  /^(what|how|why|where|when|which|who|is|are|can|could|should|would|will|do|does|did)\b[^]*\?\s*$/i;

// Short acknowledgements that nudge the agent along but carry no direction.
const CONTINUATION_RE =
  /^(y|yes|yep|yeah|ok|okay|k|sure|continue|cont|go|go ahead|do it|proceed|next|sounds good|looks good|lgtm|perfect|nice|good|great|approved?|yes please|please do|carry on|keep going|resume|finish|all good|that works|works|👍|do that|option \w|\d)[.! ]*$/i;

const MAX_NUDGE_WORDS = 4;

export function classifyPrompts(sessions) {
  const nodes = [];
  let rootAssigned = false;

  for (const session of sessions) {
    let prevNode = null;
    for (const prompt of session.prompts) {
      const text = prompt.text;
      const words = text.split(/\s+/).filter(Boolean);

      // The same human message can appear twice in a transcript (queued
      // resend, bridge echo, draft-then-full edit). Collapse consecutive
      // duplicates, including prefix-duplicates — keep the longer text.
      if (prevNode && isDupOf(prevNode.text, text)) {
        if (text.length > prevNode.text.length) {
          prevNode.text = text;
          prevNode.title = makeTitle(text);
          prevNode.kind = prevNode.kind === KIND.ROOT ? KIND.ROOT : classifyOne(text, prompt, true);
          prevNode.chars = text.length;
        }
        continue;
      }

      // Fold pure nudges into the previous node instead of creating noise nodes.
      if (
        prevNode &&
        words.length <= MAX_NUDGE_WORDS &&
        CONTINUATION_RE.test(text)
      ) {
        prevNode.nudges++;
        continue;
      }

      const node = {
        id: null, // assigned by tree builder
        uuid: prompt.uuid,
        parentUuid: prompt.parentUuid,
        sessionId: session.sessionId,
        ts: prompt.ts,
        text,
        title: makeTitle(text),
        kind: classifyOne(text, prompt, rootAssigned),
        status: 'accepted', // tree builder may demote to abandoned
        nudges: 0,
        afterInterruption: prompt.afterInterruption,
        chars: text.length,
      };
      if (node.kind === KIND.ROOT) rootAssigned = true;
      nodes.push(node);
      prevNode = node;
    }
  }
  return nodes;
}

// Two consecutive messages are duplicates if one is (nearly) a prefix of the
// other after whitespace normalization — covers truncated draft echoes.
function isDupOf(a, b) {
  const na = a.replace(/\s+/g, ' ').trim();
  const nb = b.replace(/\s+/g, ' ').trim();
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length < 24) return false; // too short to call a prefix-dup safely
  // tolerate a few trailing chars of divergence (cut-off mid-word)
  return long.startsWith(short.slice(0, short.length - 4));
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

// First sentence-ish fragment, cleaned, for node titles.
export function makeTitle(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || text;
  const sentence = firstLine.split(/(?<=[.!?])\s+/)[0] || firstLine;
  return truncate(sentence, 96);
}

export { KIND };
