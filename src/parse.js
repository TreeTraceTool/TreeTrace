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
  /^(?:no(?:pe)?\s*[,.)]?\s+|stop\s*[,.)]?\s+|cancel\s*[,.)]?\s+|don'?t\s+|do not\s+|don'?t do (?:that|this|it)\b|stop (?:that|this|it|doing)\b|scrap (?:that|this|it|the)\b|revert\b|undo\b|roll\s?back\b|rip (?:that|this|it|the)\b|back (?:it|that|this) out\b|take (?:it|that|this) out\b|that'?s not it\b|that is not it\b|not that one\b|not quite\b|scratch that\b|nevermind\b|never mind\b)/i;

// Real declines often open with an interjection ("Whoa, scrap that", "Hold on, revert that").
// Strip these so the decline core is what the start-anchored matcher and the benign guard both see.
const DECLINE_INTERJECTION_RE =
  /^(?:(?:whoa|wait|hold on|hold up|hold the phone|hmm+|ugh+|argh+|actually|no wait|ok wait|wait wait|yikes)[\s,!.:;-]+)+/i;

// Structural decline fallback. The existing USER_TEXT_DECLINE_RE is START-anchored
// and phrase-bound, so fresh-form declines ("yank that file", "stop printing the token",
// "nix the trie", "back it out") that put the reversal verb mid-clause are missed. This
// fallback fires on a clause-leading HARD REVERSAL verb that is either bare (BARE_STOP_RE)
// or governs a back-reference to the immediately-prior assistant turn (a demonstrative, or a
// file/prose token the prior action actually touched, captured in session._priorAssistant).
// The verb list is restricted to hard reversal verbs; "don't" / forward-instruction negation
// ("don't forget tests", "drop the column", "you usually stop the server") is left to the
// existing start-anchored matcher so it does NOT fire here, keeping new false positives at zero.
const IMPERATIVE_REVERSAL_RE =
  /\b(?:stop|undo|revert|yank|rip|kill|scrap|nix|roll\s?back|back(?:\s+(?:it|that|this))?\s+out|take(?:\s+(?:it|that|this))?\s+out)\b/i;
// A bare hard-stop clause ("stop.", "undo that", "revert it", "nix it") with no further object
// needed: the reversal verb alone, optionally with a demonstrative pronoun, IS the decline.
const BARE_STOP_RE =
  /^(?:stop|undo|revert|yank|nix|scrap|rip|kill|roll\s?back)\s*(?:it|that|this|the\b[^.]*)?[.!,;:\s]*$/i;
// Demonstrative / back-reference that anchors the reversal to the prior assistant turn.
const BACKREF_DEMONSTRATIVE_RE = /\b(?:that|this|those|these|it)\b/i;

// Benign openers that share a decline prefix but are agreement / instruction / meta-complaint,
// NOT a decline of the agent's action. Precision guard for looksLikeUserTextDecline.
//   "No problem, go ahead"  "Don't forget to add tests"  "Stop being unhelpful"
const BENIGN_DECLINE_OPENER_RE =
  /^(?:no\s+(?:problem|worries|worry|rush|need|thanks|biggie|prob(?:lem)?s?|issue)\b|nope?\s+(?:problem|worries)\b|don'?t\s+(?:forget|hesitate|worry|bother|stop)\b|stop\s+(?:being|saying|telling|apologi[sz]|with the|the apolog))/i;

// "I won't touch/change/expose X" etc. is agreement to a constraint, not a refusal.
const COMPLIANT_WONT_RE =
  /\bi\s+(?:won['']?t|will not|promise not to)\s+(?:touch|change|modify|alter|edit|delete|remove|drop|break|add|introduce|expose|leak|hardcode|hard-code|commit|push|overwrite|override|re-?add|reintroduce)\b/i;
// Strong refusal stems that should override the compliance guard (a real refusal can also say "won't").
const HARD_REFUSAL_RE =
  /\bi\s+can(?:'|no)?t\b|\b(?:am|'?m)\s+(?:unable|not able|not permitted|not allowed)\b|\bagainst my (?:guidelines|policies|programming)\b|\bas an? (?:ai|language model|assistant)\b/i;

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

export function looksLikeRefusal(text) {
  if (typeof text !== 'string' || text.length > 4000) return false;
  // "I won't touch the table" = compliance, not refusal, unless a hard refusal stem is also present.
  if (COMPLIANT_WONT_RE.test(text) && !HARD_REFUSAL_RE.test(text)) return false;
  return REFUSAL_TEXT_RE.test(text);
}

// Novel-form unwillingness clauses that REFUSAL_TEXT_RE (a keyword list keyed on
// "I can't / I'm unable / against my guidelines") does not match, but which are real refusals
// when carried on an action-empty turn: "I'm going to decline this one", "I'd rather not",
// "that's not something I'll do / can help with", "I'm not comfortable building that",
// "that crosses a line I won't cross", "I'm not willing to". These phrasings are invariant
// markers of a stated unwillingness. On their own they are too loose to fire a rejection (a turn
// could say "I'd rather not duplicate that helper" and then DO the work), so this matcher is used
// ONLY behind the action-empty structural gate, never as a standalone keyword arm.
const NOVEL_REFUSAL_RE =
  /\bi(?:'|’)?m\s+going\s+to\s+decline\b|\bi(?:'|’)?ll\s+decline\b|\bi\s+decline\s+(?:this|that|to)\b|\bi(?:'|’)?d\s+rather\s+not\b|\bi(?:'|’)?m\s+not\s+(?:comfortable|willing|going)\s+to?\b|\bthat(?:'|’)?s\s+not\s+something\s+i(?:'|’)?(?:ll|m)?\s*(?:can|will|would|want|going)\b|\bnot\s+something\s+i\s+can\s+help\s+with\b|\bcrosses\s+a\s+line\s+i\s+won(?:'|’)?t\s+cross\b|\bi(?:'|’)?m\s+not\s+going\s+to\s+(?:do|build|implement|write|add)\b/i;

// Structural refusal recognizer for the inability/unwillingness clause, broadened to the
// novel forms above. Same compliance guard as looksLikeRefusal (a self-imposed "I won't touch X"
// constraint is not a refusal). Confined to the action-empty arm by its only caller.
function looksLikeRefusalStructural(text) {
  if (typeof text !== 'string' || text.length > 4000) return false;
  if (COMPLIANT_WONT_RE.test(text) && !HARD_REFUSAL_RE.test(text)) return false;
  return REFUSAL_TEXT_RE.test(text) || NOVEL_REFUSAL_RE.test(text);
}

function looksLikeUserTextDecline(text) {
  let t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > 240) return false;
  t = t.replace(DECLINE_INTERJECTION_RE, '').trim();
  if (BENIGN_DECLINE_OPENER_RE.test(t)) return false;
  return USER_TEXT_DECLINE_RE.test(t);
}

// Structural decline classifier used as a fallback to the start-anchored matcher.
// Fires when a clause carries a hard reversal verb that is either bare (BARE_STOP) or governs a
// back-reference to the immediately-prior assistant turn (demonstrative, or a file/prose token
// the prior action touched). `priorAssistant` is the session._priorAssistant snapshot.
// Shared precision anchor. A clause back-references the immediately-prior assistant action
// when it carries a demonstrative (that/this/it) OR a file/prose token that action actually
// touched (session._priorAssistant snapshot). Extracted from looksLikeStructuralDecline so the
// destructive-attribution arm reuses the exact same anchor (no looser tie is introduced).
function backRefsPriorAssistant(clause, priorAssistant) {
  if (BACKREF_DEMONSTRATIVE_RE.test(clause)) return true;
  if (priorAssistant && priorAssistant.tokens && priorAssistant.tokens.size) {
    const low = clause.toLowerCase();
    for (const tok of priorAssistant.tokens) {
      if (tok.length >= 4 && low.includes(tok)) return true;
    }
  }
  return false;
}

// Destructive ATTRIBUTION to the agent: "you blew away / nuked / wiped / truncated /
// dropped / deleted / ripped out <X>". This is a decline-by-complaint: the user states the agent
// destroyed something and (implicitly or explicitly) wants it stopped/reversed. Gated on a
// back-reference to the prior assistant action so it never fires on a user narrating their own
// mishap ("I dropped the table"). The second-person "you" / agent-token anchor is what holds
// precision.
const DESTRUCTIVE_ATTR_RE =
  /\byou\b[^.!?;]{0,40}\b(?:blew\s+away|blow\s+away|nuked?|wiped?|truncated?|dropped?|deleted?|destroyed?|clobbered?|ripped?\s+(?:out|away))\b|\b(?:that|this|the)\b[^.!?;]{0,30}\b(?:drop[\s-]?and[\s-]?recreate[d]?|blew\s+away|truncated?|wiped?)\b/i;
// A destructive-attribution complaint is a DECLINE only when it ALSO carries a forward redirect of
// the agent's APPROACH ("make it non-destructive / additive", "stop dropping", "do X instead").
// A bare "you deleted X, please restore it" is a destructive-then-recover EVENT (handled as
// abandoned_path), not a decline of an approach -- requiring this redirect cue keeps a pure
// restore request from minting a spurious user_text_decline while still firing on a real redirect.
const DESTRUCTIVE_REDIRECT_CUE_RE =
  /\bnon[\s-]?destructive\b|\badditive\b|\binstead\b|\bstop\b|\bdon'?t\b[^.!?;]{0,30}\b(?:drop|truncate|wipe|recreate|delete|blow)\b|\bnever\b[^.!?;]{0,30}\b(?:drop|truncate|wipe|recreate|delete)\b|\bmake\b[^.!?;]{0,30}\b(?:migration|change|it)\b[^.!?;]{0,20}\b(?:additive|non[\s-]?destructive|safe)\b/i;

function looksLikeStructuralDecline(text, priorAssistant) {
  let t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > 240) return false;
  t = t.replace(DECLINE_INTERJECTION_RE, '').trim();
  if (BENIGN_DECLINE_OPENER_RE.test(t)) return false;
  // Scan ALL clauses for a clause-leading reversal verb, not just the first. A decline can
  // bury the reversal in a later clause ("This is a cannon for a fly. ... Rip the plugin registry
  // and middleware out ..."): the first clause is a metaphor, the reversal lives in clause 3. Each
  // candidate clause still requires the reversal verb to LEAD its clause (after at most a short
  // connective) and to be either bare or back-referenced, so precision is unchanged.
  const clauses = t.split(/[.!?;\n]/);
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const m = clause.match(IMPERATIVE_REVERSAL_RE);
    if (!m) continue;
    // The reversal verb must lead its clause (be at or near the start, after at most a short
    // connective like "no," / "ok,"). This keeps "you usually stop the server" from matching.
    const idx = clause.toLowerCase().indexOf(m[0].toLowerCase());
    const lead = clause.slice(0, idx).replace(/[,\s]+$/, '').trim();
    if (lead && !/^(?:no|nope|ok|okay|please|hey|and|so|then|wait|hold on|also)\b[\s,]*$/i.test(lead)) {
      continue;
    }
    // BARE_STOP: the reversal verb (optionally + demonstrative) stands alone -> decline.
    if (BARE_STOP_RE.test(clause)) return true;
    // Otherwise require a back-reference to the prior assistant action.
    if (backRefsPriorAssistant(clause.slice(idx), priorAssistant)) return true;
  }
  // Destructive-attribution arm: "you blew away X ... make the migration non-destructive",
  // gated on a back-reference to the prior assistant action (so a self-narrated mishap never fires)
  // AND a forward redirect cue (so a pure restore request stays an abandoned_path event, not a
  // decline).
  if (
    DESTRUCTIVE_ATTR_RE.test(t) &&
    DESTRUCTIVE_REDIRECT_CUE_RE.test(t) &&
    backRefsPriorAssistant(t, priorAssistant)
  ) {
    return true;
  }
  return false;
}

// Structural UPSTREAM-CORRECTION classifier. A fresh-form redirect ("you solved the
// wrong problem, I cared about latency not throughput", "I wanted a wrench, not a workshop. Rip
// the plugin registry out") never trips the start-anchored decline matcher NOR the bare/hard-stop
// structural-decline path, so the whole failure/chain/lesson pipeline stays dark for it. This
// fires user_text_decline when a user turn STRUCTURALLY contradicts the immediately-prior
// assistant action: (a) it names/overlaps a DISTINCTIVE token that action just touched AND (b) it
// carries a contrast/negation/reversal cue (a negated restatement "X, not Y" / a goal-mismatch
// frame "you ... the wrong" / a reversal verb governing the prior token). This is the same
// back-reference anchoring already proven in looksLikeStructuralDecline, lifted so it drives the
// analysis loop for ALL fresh-form redirects, not just bare hard-stops.
//
// Generic narration filler ("with", "goal", "approach", "under", "back", "just", "into") is not a
// distinctive back-reference; overlapping on it alone would let a contrast cue elsewhere in the
// turn manufacture a redirect, so it is excluded from the anchor set.
const STRUCT_REDIRECT_STOPTOKENS = new Set([
  'with', 'into', 'just', 'back', 'goal', 'under', 'over', 'this', 'that', 'these', 'those',
  'then', 'than', 'them', 'they', 'your', 'have', 'will', 'from', 'about', 'across', 'after',
  'approach', 'instead', 'reverting', 'switching', 'collapsing', 'understood', 'reorienting',
  'misread', 'deleting', 'returning', 'added', 'done', 'made', 'built', 'rebuilt', 'using',
  'thanks', 'later', 'minimize', 'maximize', 'target', 'budget', 'local', 'bench',
]);
// Negated restatement: a contrastive "X, not Y" or "I wanted/cared/asked/meant ... not".
const NEGATED_RESTATEMENT_RE =
  /,\s*not\b|\b(?:wanted|want|cared|care|asked|meant|need|needed|expected|after)\b[^.]{0,40}\bnot\b|\bnot\b[^.]{0,30}\b(?:but|instead)\b/i;
// Self-anchoring goal-mismatch frame: "you solved/built/chose ... wrong". The second-person agent
// reference ("YOU solved") IS the back-reference to the prior assistant action, so this form does
// not additionally require a shared token; it unambiguously corrects what the agent just did.
const GOAL_MISMATCH_SELF_RE =
  /\byou\s+(?:solved|built|did|made|gave|chose|used|wrote|created|went|took|picked|implemented|optimi[sz]ed|focused|targeted)\b[^.]{0,40}\bwrong\b/i;
// Weaker goal-mismatch frame: "the wrong <noun>" / "wrong direction". Still requires a back-ref token.
const GOAL_MISMATCH_RE =
  /\bwrong\s+(?:problem|thing|goal|approach|direction|track|path|idea|feature|task|tool|one|axis|shape)\b/i;
// Hard reversal verb governing a back-reference. Bare form restricted to UNAMBIGUOUS reversal verbs
// (nix/scrap/revert/undo/yank); rip/tear/strip/pull/gut only count in the "X out" particle form,
// because bare "tear it apart", "kill the process", "gut feeling" are not reliably reversals.
const STRUCT_REVERSAL_RE =
  /\b(?:nix|scrap|revert|undo|yank)\b|\b(?:rip|tear|take|strip|pull|gut)\b[^.]{0,30}\bout\b/i;
// Permissive framing: "feel free to", "go ahead and", "you can", "if you (want|like)" turns a
// reversal verb into a granted suggestion, not a decline of what the agent did. Guards out
// "feel free to tear it apart and rebuild it" (a refactor invitation, not a correction).
const PERMISSIVE_FRAMING_RE =
  /\b(?:feel free to|go ahead and|go ahead|you (?:can|could|may|might)|if you (?:want|like|prefer)|whenever you|happy for you to|fine to)\b/i;
// Scope-affirmation framing: "I just/only want X", "to be clear ... that's all", "keep it to X".
// The user is CONFIRMING the current direction with a clarifying boundary on what NOT to add next,
// not reversing a completed action. "I just want stacked bars, not a whole new chart kind on top.
// That's all." is a scope clarification, not a redirect of what the agent already did.
const SCOPE_AFFIRMATION_RE =
  /\bi (?:just|only) (?:want|need|wanted|needed)\b|\bthat'?s all\b|\bjust (?:want|keep) (?:it|that)\b/i;

function looksLikeStructuralRedirect(text, priorAssistant) {
  let t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > 600) return false;
  if (!priorAssistant || !priorAssistant.tokens || !priorAssistant.tokens.size) return false;
  t = t.replace(DECLINE_INTERJECTION_RE, '').trim();
  if (BENIGN_DECLINE_OPENER_RE.test(t)) return false;
  if (PERMISSIVE_FRAMING_RE.test(t) || SCOPE_AFFIRMATION_RE.test(t)) return false;
  // A self-anchoring "you <verb> ... wrong" frame already back-references the prior assistant
  // action via the second person, so it satisfies BOTH the contrast cue and the back-reference.
  if (GOAL_MISMATCH_SELF_RE.test(t)) return true;
  // (b) contrast/negation/reversal cue must be present somewhere in the turn.
  const hasCue =
    NEGATED_RESTATEMENT_RE.test(t) || GOAL_MISMATCH_RE.test(t) || STRUCT_REVERSAL_RE.test(t);
  if (!hasCue) return false;
  // (a) the turn must name/overlap a DISTINCTIVE token the prior assistant action just touched.
  const low = t.toLowerCase();
  for (const tok of priorAssistant.tokens) {
    if (tok.length < 4 || STRUCT_REDIRECT_STOPTOKENS.has(tok)) continue;
    if (new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low)) return true;
  }
  return false;
}

// A structural redirect that is ALSO a genuine DECLINE of the agent's action: it carries a
// hard reversal verb governing a back-referenced token (rip/nix/scrap/revert + the touched
// surface). This is the subset that should additionally mint a user_text_decline rejection; a pure
// goal-mismatch ("you solved the wrong problem") is a misunderstood-goal correction, NOT a decline,
// so it flips the kind but does not fabricate a rejection (keeps zero new rejection FPs on those).
function structuralRedirectIsDecline(text, priorAssistant) {
  let t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > 600) return false;
  if (!priorAssistant || !priorAssistant.tokens || !priorAssistant.tokens.size) return false;
  t = t.replace(DECLINE_INTERJECTION_RE, '').trim();
  if (BENIGN_DECLINE_OPENER_RE.test(t)) return false;
  if (PERMISSIVE_FRAMING_RE.test(t)) return false;
  if (!STRUCT_REVERSAL_RE.test(t)) return false;
  const low = t.toLowerCase();
  for (const tok of priorAssistant.tokens) {
    if (tok.length < 4 || STRUCT_REDIRECT_STOPTOKENS.has(tok)) continue;
    if (new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low)) return true;
  }
  return false;
}

// A goal-mismatch redirect frame. A strong frame asserts the agent solved the wrong thing
// ("that's not what I asked (for)", "the whole point is X", "what I actually/really wanted"),
// the user is reorienting back to the ORIGINAL goal, not declining a side-detail. This is the
// distinct signature of a misunderstood-goal correction; on its own it is too generic to mint a
// decline (false on "that's not what I expected to see in the logs"), so it is gated on the turn
// ALSO restating a distinctive ROOT-GOAL token snapshotted from the first user prompt.
const GOAL_MISMATCH_FRAME_RE =
  /\bthat'?s not what i (?:asked|wanted|meant|said|requested)\b|\bthe whole point (?:is|was|of)\b|\bwhat i (?:actually|really) (?:wanted|asked|meant|need(?:ed)?)\b|\bmissed the (?:point|goal)\b|\bnot what i'?m after\b/i;
// Generic words that are not distinctive enough to anchor a root-goal restatement. The root goal
// is the FIRST user prompt; we keep only its distinctive content tokens (>=4 chars, not filler).
const ROOT_GOAL_STOPTOKENS = new Set([
  'support', 'update', 'updates', 'feature', 'features', 'system', 'systems', 'please', 'should',
  'would', 'could', 'about', 'these', 'those', 'their', 'there', 'which', 'while', 'where', 'thing',
  'things', 'something', 'devices', 'device', 'images', 'image', 'field', 'pull', 'make', 'build',
  'built', 'using', 'with', 'from', 'into', 'over', 'they', 'them', 'this', 'that', 'have', 'need',
  'needs', 'want', 'wants', 'when', 'then', 'than', 'your', 'each', 'able', 'code', 'work', 'works',
]);
// Extract distinctive root-goal tokens from the first user prompt: whole words >=4 chars (lowered)
// plus distinctive hyphenated / dotted compounds ("over-the-air", "firmware/ota.c"). The compounds
// matter because a restatement frequently echoes the exact hyphenated phrase ("over-the-air").
function extractRootGoalTokens(text) {
  const out = new Set();
  const low = String(text || '').toLowerCase();
  for (const w of low.match(/[a-z][a-z0-9_-]{3,}/g) || []) {
    if (w.length >= 4 && !ROOT_GOAL_STOPTOKENS.has(w)) out.add(w);
  }
  // Distinctive multi-word hyphenated phrases (e.g. over-the-air) as a single token.
  for (const phrase of low.match(/[a-z]{2,}(?:-[a-z]{2,}){1,}/g) || []) {
    if (phrase.length >= 6) out.add(phrase);
  }
  return out;
}
// The redirect turn is a goal-mismatch decline when it carries a strong goal-mismatch frame
// AND restates a distinctive token from the session root goal (first user prompt). Returns true
// only when both hold; this rides the existing structural-redirect/decline OR-gate as a NEW arm
// and never rewrites looksLikeStructuralDecline.
function looksLikeGoalMismatchRedirect(text, rootGoalTokens) {
  let t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > 600) return false;
  if (!rootGoalTokens || !rootGoalTokens.size) return false;
  if (!GOAL_MISMATCH_FRAME_RE.test(t)) return false;
  const low = t.toLowerCase();
  for (const tok of rootGoalTokens) {
    if (tok.length < 4) continue;
    if (new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low)) return true;
  }
  return false;
}

// Tokens (file basenames + narration words) the immediately-prior assistant turn touched,
// used by looksLikeStructuralDecline to anchor a reversal verb to a concrete prior action.
function buildPriorAssistantSnapshot(files, narration) {
  const tokens = new Set();
  for (const f of files) {
    const base = String(f).split(/[\\/]/).pop();
    if (base && base.length >= 4) tokens.add(base.toLowerCase());
    for (const seg of String(f).toLowerCase().split(/[\\/.+_-]+/)) {
      if (seg.length >= 4) tokens.add(seg);
    }
  }
  for (const w of String(narration || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []) {
    tokens.add(w);
  }
  return { tokens };
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
    _priorAssistant: null,
    _rootGoalTokens: null,
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

  // Snapshot root-goal tokens from the FIRST real user prompt of the session. Later
  // goal-mismatch redirects ("that's not what I asked ... the whole point is OTA, over-the-air")
  // are anchored against these to mint a structural decline.
  if (session._rootGoalTokens === null && !session.isContinuation) {
    session._rootGoalTokens = extractRootGoalTokens(trimmed);
  }

  // Text-decline rejection: detect after we know trimmed is non-empty and is a
  // real prompt (not meta/command/compact). The placeholder this pushes doubles
  // as the canonical prompt for this turn (it already carries the rejection),
  // so we return immediately to avoid pushing a second prompt below.
  // A goal-mismatch redirect that restates a distinctive root-goal token is a structural
  // redirect (rides the SAME OR-gate as the prior-action-anchored redirect path).
  const isGoalMismatchRedirect = looksLikeGoalMismatchRedirect(trimmed, session._rootGoalTokens);
  // A structural decline (hard-reversal back-ref / destructive-attribution arm) is
  // a structural redirect by construction; flag it so the downstream lesson damp can withhold the
  // generic "do not retry a declined action" boilerplate on these dense decline turns (the chain
  // carries the real remedy). This mirrors the goal-mismatch flagging.
  const isStructDecline = looksLikeStructuralDecline(trimmed, session._priorAssistant);
  const isStructRedirect =
    looksLikeStructuralRedirect(trimmed, session._priorAssistant) ||
    isGoalMismatchRedirect ||
    isStructDecline;
  if (
    looksLikeUserTextDecline(trimmed) ||
    isStructDecline ||
    structuralRedirectIsDecline(trimmed, session._priorAssistant) ||
    isGoalMismatchRedirect
  ) {
    // Tag the decline placeholder as a structural redirect when it back-references the prior
    // assistant action, so the kind gate routes it to correction (the analysis-loop driver), not
    // just rejection minting. Plain start-anchored declines without a back-ref are left untagged.
    attachRejectionToText(session, rec, trimmed, 'user_text_decline', 'text', 0.8, isStructRedirect);
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
    // Does this turn STRUCTURALLY contradict the immediately-prior assistant action
    // (back-reference to a token it touched + a contrast/negation/reversal cue)? Snapshotted
    // here because session._priorAssistant is mutated by each later assistant turn; the kind
    // gate (extract.js classifyOne) reads this to route fresh-form redirects to kind:correction.
    structuralRedirect: looksLikeStructuralRedirect(trimmed, session._priorAssistant),
    // Snapshot the immediately-prior assistant token set so inferSignals can back-reference
    // a removal imperative ("rip the registry out") to a component the prior turn actually added.
    _priorTokens: session._priorAssistant,
  };
  session.prompts.push(prompt);
  session._currentPrompt = prompt;
  session._pendingInterruption = false;
}

// Variant of attachRejection that links the rejection to the prompt we are
// about to create. We push a placeholder _currentPrompt first so attachRejection
// finds it, then fill in the real fields.
function attachRejectionToText(session, rec, text, kind, source, confidence, structuralRedirect = false) {
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
    structuralRedirect,
    _priorTokens: session._priorAssistant,
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
  // Assistant text blocks were dropped entirely. Join them so the agent's own
  // narration ("I'll log the full Authorization header with the bearer token") is carried
  // onto each action as a.narration and scanned by the credential-mishandling detector.
  // Also feed this narration + touched files into the prior-assistant snapshot.
  let narration = '';
  const touchedFiles = new Set();
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      narration += (narration ? ' ' : '') + block.text;
    }
  }
  // The text-heuristic refusal arm is now STRUCTURAL: a real refusal is "stated inability
  // + no work done on the same turn". We must know whether this assistant message produced any
  // tool_use before deciding, so capture the first inability clause here and defer the firing
  // until after the content loop (when toolUsesThisTurn is known). The action-empty gate is the
  // precision anchor: a hedge-then-comply turn voices an inability phrase but still
  // emits tool_use, so it no longer mints a false model_refusal.
  let refusalClause = null;
  let toolUsesThisTurn = 0;
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text') {
      // Capture the first inability/unwillingness clause (keyword OR novel form). The
      // novel-form broadening is safe here because the firing below is gated on action-empty.
      if (refusalClause === null && looksLikeRefusalStructural(block.text)) {
        refusalClause = typeof block.text === 'string' ? block.text : '';
      }
    } else if (block.type === 'tool_use') {
      toolUsesThisTurn++;
      session.stats.toolUses++;
      const input = block.input || {};
      const file = input.file_path || input.notebook_path || null;
      if (typeof file === 'string') {
        session.stats.filesTouched.add(file);
        touchedFiles.add(file);
      }
      if (block.name === 'Bash' && typeof input.command === 'string') {
        for (const p of shellFilePaths(input.command)) {
          session.stats.filesTouched.add(p);
          touchedFiles.add(p);
        }
      }
      if (current) {
        current.actions.push({
          tool: block.name || null,
          file: typeof file === 'string' ? file : null,
          command: block.name === 'Bash' && typeof input.command === 'string' ? input.command : null,
          input: summarizeToolInput(block.name, input),
          // The assistant's own narration for this turn, scanned with the action
          // body for sentence-scoped credential-noun + sink-verb co-occurrence.
          narration: narration || null,
          model: synthetic ? null : msg.model || null,
        });
      }
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      if (current) current.thinking++;
    }
  }

  // Deferred structural text-heuristic refusal arm. A real refusal is invariant across
  // phrasing -> "stated inability + no work done on the same turn". Fire model_refusal from the
  // inability clause ONLY when this assistant message is action-empty (toolUsesThisTurn === 0, no
  // tool action / file edit on the turn carrying the clause). The action-empty gate is the
  // precision anchor: a hedge-then-comply turn ("I'm not sure I can, but here goes")
  // voices an inability phrase yet still emits tool_use, so it no longer mints a false model_refusal.
  // The object-governance helper (refusalGovernsRequest) is available as a secondary tightener but
  // is NOT applied as a hard gate here: requests are often anaphoric ("tell me what would have
  // happened"), so a token-overlap requirement would drop true refusals; the action-empty gate
  // alone is the precision-clean structural invariant.
  // The text_heuristic arm is ALSO suppressed when this same message already carries the provider's
  // stop_reason:refusal verdict: the renderer emits every node.rejection un-deduped, so a node with
  // both arms would mint two model_refusal signals for one refusal -> a duplicate FP. The
  // higher-confidence stop_reason arm below is kept; the text arm stands down to one-per-node.
  if (refusalClause !== null && toolUsesThisTurn === 0 && msg.stop_reason !== 'refusal') {
    attachRejection(session, {
      kind: 'model_refusal',
      source: 'text_heuristic',
      confidence: 0.7,
      toolUseId: null,
      tool: null,
      ts: rec.timestamp || null,
      evidence: truncate(refusalClause, 160),
    });
  }

  // API-level refusal signal. Higher confidence than the text heuristic because
  // it is the provider's structured verdict, not a phrase match.
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

  // Snapshot the touched files + narration tokens so the next user turn's
  // structural-decline check can anchor a reversal verb to this concrete prior action.
  if (touchedFiles.size || narration) {
    session._priorAssistant = buildPriorAssistantSnapshot(touchedFiles, narration);
  }
}

// Absolute and relative file-path tokens from a shell command string.
// Matches /abs/path and ./rel/path patterns that contain at least one
// path separator. Excludes flag-only strings like "--output" and environment
// substitutions like $VAR or ${VAR}. Returns a deduplicated array.
const SHELL_PATH_RE = /(?:^|(?<=\s|[=,;|&`()]))(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|(\.{0,2}\/[^\s'"\\,;|&`()\[\]{}<>$!?*#]+))/g;

function shellFilePaths(cmd) {
  if (typeof cmd !== 'string' || !cmd) return [];
  const seen = new Set();
  const out = [];
  for (const m of cmd.matchAll(SHELL_PATH_RE)) {
    const tok = m[2];
    if (!tok) continue;
    const cleaned = tok.replace(/['">]+$/, '');
    if (!cleaned || cleaned.endsWith('/') || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
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
  let current = null; // user prompt being accumulated
  let assistantBuf = null; // assistant turn text being accumulated, or null when not in an assistant turn
  let sawMarkers = false;
  let assistantLines = 0;
  let rejectionCount = 0;
  const rejectionsByKind = Object.create(null);

  const record = (target, rejection) => {
    if (!target) return;
    if (!Array.isArray(target.rejections)) target.rejections = [];
    target.rejections.push(rejection);
    rejectionCount++;
    rejectionsByKind[rejection.kind] = (rejectionsByKind[rejection.kind] || 0) + 1;
  };

  // An assistant turn just ended. If it reads as a refusal, attach a
  // model_refusal to the user prompt that triggered it (the last one pushed).
  // Mirrors the Claude-path text heuristic (source 'text_heuristic', confidence
  // 0.7) so the plain-transcript fallback produces the same audit signal a
  // structured session would, instead of silently dropping refusals.
  const flushAssistant = () => {
    if (assistantBuf == null) return;
    const atext = assistantBuf.trim();
    if (atext) {
      assistantLines++;
      if (looksLikeRefusal(atext)) {
        record(prompts[prompts.length - 1], {
          kind: 'model_refusal',
          source: 'text_heuristic',
          confidence: 0.7,
          toolUseId: null,
          tool: null,
          ts: null,
          evidence: truncate(atext, 160),
        });
      }
    }
    assistantBuf = null;
  };

  // A user turn just ended. Push it, and if the text itself is a decline
  // ("no, stop", "don't do that"), attach a user_text_decline rejection,
  // matching ingestUser (source 'text', confidence 0.8).
  const flushUser = () => {
    if (current && current.text.trim()) {
      const utext = current.text.trim();
      if (looksLikeUserTextDecline(utext)) {
        record(current, {
          kind: 'user_text_decline',
          source: 'text',
          confidence: 0.8,
          toolUseId: null,
          tool: null,
          ts: null,
          evidence: truncate(utext, 160),
        });
      }
      prompts.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const userMatch = line.match(markers);
    if (userMatch) {
      sawMarkers = true;
      flushAssistant();
      flushUser();
      current = { text: userMatch[3] ? `${userMatch[3]}\n` : '', uuid: null, parentUuid: null, ts: null, rejections: [] };
      continue;
    }
    const assistantMatch = line.match(assistantMarkers);
    if (assistantMatch) {
      sawMarkers = true;
      flushAssistant();
      flushUser();
      // Capture any text on the same line as the marker (e.g. "Assistant: I can't help"),
      // which is the common single-line shape in pasted chat exports.
      const inline = line.slice(assistantMatch[0].length);
      assistantBuf = inline ? `${inline}\n` : '';
      continue;
    }
    if (current) current.text += `${line}\n`;
    else if (assistantBuf != null) assistantBuf += `${line}\n`;
  }
  flushAssistant();
  flushUser();

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
    prompts: prompts.map((p) => ({ ...p, text: p.text.trim(), actions: [], thinking: 0, rejections: p.rejections || [] })),
    index: new Map(),
    leafUuid: null,
    activeLeafUuid: null,
    stats: {
      userLines: prompts.length,
      assistantLines,
      toolUses: 0,
      models: [],
      filesTouched: [],
      inputTokens: 0,
      outputTokens: 0,
      interruptions: 0,
      rejections: rejectionCount,
      rejectionsByKind: { ...rejectionsByKind },
    },
    isContinuation: false,
  };
}
