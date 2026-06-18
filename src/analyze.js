import { truncate, escapeMd } from './util.js';
import { SCHEMA_VERSION } from './config.js';

const FAILURE_TYPES = new Set([
  'ignored_constraint',
  'misunderstood_goal',
  'scope_drift',
  'wrong_tool_choice',
  'hallucinated_file_or_api',
  'repeated_failed_fix',
  'overbuilt_solution',
  'underbuilt_solution',
  'security_or_privacy_risk',
  'dependency_or_environment_mismatch',
  'format_violation',
  'user_frustration',
  'abandoned_path',
  // v0.3 rejection-derived failure types
  'user_rejected_action',
  'tool_execution_failed',
  'model_refused',
  'permission_denied',
]);

// Maps a Rejection.kind (v0.3) to a failure type. user_* rejections all funnel
// into user_rejected_action because they are variants of the same human-steering
// event: the agent proposed or did something and the human stopped it.
const REJECTION_KIND_TO_FAILURE_TYPE = {
  user_declined_tool: 'user_rejected_action',
  user_interrupt: 'user_rejected_action',
  user_text_decline: 'user_rejected_action',
  tool_execution_error: 'tool_execution_failed',
  permission_denied: 'permission_denied',
  model_refusal: 'model_refused',
};

// tier from a rejection confidence. Matches the security-signal banding.
function tierForRejection(confidence) {
  if (confidence >= 0.95) return 'verified';
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.65) return 'confirmed';
  return 'inferred';
}

const CORRECTION_HINT =
  /\b(no|stop|scrap|not that|you forgot|you ignored|that's wrong|that is wrong|i said|instead|redo|re do|go back|wrong|doesn'?t work|didn'?t work|still (failing|broken|wrong|bad)|not what i (asked|wanted|meant))\b/i;
const FRUSTRATION_HINT =
  /\b(sucks|awful|god awful|what the heck|wtf|mad|angry|frustrat|not suffic|i don'?t trust|terrible|bad)\b/i;
const PRIVACY_HINT = /\b(secret|token|api key|apikey|password|redact|privacy|private|local-first|telemetry|upload|cloud)\b/i;
const composeOr = (parts) => new RegExp(parts.map((p) => `(?:${p.re.source})`).join('|'), 'i');

export const SECURITY_INTENT_PARTS = [
  { name: 'credential_lifecycle', re: /\b(?:updated?|rotat(?:e|ed|ing)|regenerat(?:e|ed)|new|replaced?|revoked?)\b[^.]{0,40}\b(?:pat|personal access token|api[- ]?key|access token|secret|credential)s?\b/i },
  { name: 'pat_lifecycle', re: /\bpat\b[^.]{0,30}\b(?:updated?|rotat|regenerat|revoked?)/i },
  { name: 'email_change', re: /\b(?:make|change|set|update|use)\b[^.]{0,30}\bemail\b(?=[^.]*@|[^.]*\bcontact\b|[^.]*\bpublic\b)/i },
  { name: 'do_not_expose', re: /\b(?:don'?t|do not|never)\b[^.]{0,20}\b(?:expose|leak)\b/i },
  { name: 'expose_us', re: /\bexpose us\b/i },
  { name: 'leak_list', re: /\bleak (?:anything|audit|nothing|secrets?|creds?)\b/i },
  { name: 'audit_repos', re: /\b(?:full )?audit\b[^.]{0,40}\b(?:repo|repos|repositor|organization|git commit|commit history)\b/i },
  { name: 'commit_history_audit', re: /\bcommit history\b[^.]{0,30}\b(?:audit|expose|leak|clean)\b/i },
  { name: 'relicensing', re: /\b(?:re-?licens(?:e|ing)|licens(?:e|ing) (?:adjustment|change)|chang(?:e|ing)[^.]{0,15}licens)\b/i },
  { name: 'disable_tests', re: /\b(?:disabl|skip|remov|delet)\w*\b[^.]{0,15}\btests?\b/i },
  { name: 'access_control_change', re: /\b(?:change|modify|update|add|tighten|loosen|fix)\b[^.]{0,20}\b(?:access control|permissions?|rbac|auth flow)\b/i },
];
const SECURITY_INTENT_RE = composeOr(SECURITY_INTENT_PARTS);
const SCOPE_DRIFT_HINT = /\b(don'?t add|do not add|not a web app|keep it local|too much|overbuilt|scope drift|stay focused|same format|keep .* cli|zero-config cli)\b/i;
const TOOL_HINT = /\b(wrong tool|wrong library|use .* instead|don'?t use|dependency|package|environment|node version|python version|missing module)\b/i;
const HALLUCINATION_HINT = /\b(hallucinat|doesn'?t exist|does not exist|no such file|fake file|fake api|made up)\b/i;
const REPEATED_FIX_HINT = /\b(still failing|still broken|again|same error|didn'?t fix|doesn'?t fix|keeps? failing)\b/i;
const UNDERBUILT_HINT = /\b(underbuilt|missing|not enough|too bare|incomplete|you skipped|you missed)\b/i;
const FORMAT_HINT = /\b(format|json|markdown|schema|same structure|exact output|invalid)\b/i;

const WORDING_SCAN_MAX_CHARS = 1200;
const SIGNAL_PRIORITY = [
  'ignored_constraint',
  'hallucinated_file_or_api',
  'wrong_tool_choice',
  'repeated_failed_fix',
  'scope_drift',
  'overbuilt_solution',
  'underbuilt_solution',
  'dependency_or_environment_mismatch',
  'format_violation',
  'user_frustration',
  'misunderstood_goal',
];
const STOPWORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'you', 'your', 'are', 'was', 'has', 'have',
  'not', 'but', 'can', 'all', 'any', 'our', 'out', 'now', 'too', 'also', 'please', 'lol',
  'from', 'into', 'just', 'like', 'more', 'some', 'than', 'then', 'them', 'they', 'what',
  'when', 'where', 'which', 'will', 'about', 'agent', 'make', 'made', 'show', 'look',
]);

const PROCESS_LABEL_CAP = 2;
const CONSTRAINT_PER_NODE_CAP = 3;
const CONSTRAINT_LIST_CAP = 10;
const CONSTRAINT_CLAUSE_MAX = 160;
const CONSTRAINT_DIRECTIVE_RE =
  /\b(?:no|don'?t|do not|never|must(?: not)?|always|only|make sure|ensure|avoid|keep it|keep the|stay|don'?t add|do not add|no longer|stop|without|not a|never use|never add)\b/i;
const CONSTRAINT_DESCRIPTIVE_RE =
  /\b(?:i (?:don'?t|do not|can'?t|cannot)\b[^.]*\b(?:see|know|understand|think|see)|do you|does this|is this|why (?:do|does|is|are)|what (?:url|do|is|are)|how (?:do|does|can)|can you|could you|would (?:fable|it)|i (?:like|agree|see|don'?t see)\b)/i;
const CONSTRAINT_NAMED = [
  { re: /\b(?:no|don'?t add|do not add|without|never add)\b[^.]{0,20}\b(?:in[\s-]?line)\s+(?:code\s+)?comments?\b/i, label: 'No inline code comments in shipped code' },
  { re: /\b(?:no|without|avoid)\b[^.]{0,30}\bem[\s-]?dash/i, label: 'No em dashes' },
  { re: /\bem[\s-]?dash(?:es)?\b[^.]{0,30}\b(?:no|avoid|never|remove|don'?t)\b/i, label: 'No em dashes' },
  { re: /\b(?:keep|stays?|still says?|must be|use)\b[^.]{0,20}\bapache\b/i, label: 'License must stay Apache' },
  { re: /\bapache\b[^.]{0,20}\b(?:licens|2\.0)\b/i, label: 'License must stay Apache' },
  { re: /\b(?:zero|no)[\s-]?(?:new\s+)?dependenc(?:y|ies)\b/i, label: 'Zero dependencies' },
  { re: /\b(?:local[\s-]?(?:first|only)|no\s+(?:network|telemetry|uploads?|cloud))\b/i, label: 'Local-only, no network or telemetry' },
  { re: /\b(?:don'?t|do not|never)\b[^.]{0,30}\b(?:expose|leak)\b/i, label: 'Do not expose or leak secrets' },
  { re: /\bnarrow(?:ing)?\b[^.]{0,30}\bnot\b[^.]{0,20}\b(?:adding|features?)\b/i, label: 'Narrow the product, do not add features' },
  { re: /\b(?:no\s+ai|ai[\s-]?(?:generated|authored|written|tell))\b/i, label: 'No AI-authorship tells' },
];

const DESTRUCTIVE_RE =
  /\b(?:messed up|screwed up|broke|broken|deleted|wiped|nuked|lost|gone|overwrote|overwritten|corrupted|trashed|removed by accident|accidentally (?:deleted|removed|overwrote|ran))\b/i;
const RECOVERY_RE =
  /\b(?:bring it back|bring them back|restore|recover|undo|revert|roll(?: |-)?back|get it back|put it back|can you (?:fix|recover|restore)|recreate)\b/i;
const APOLOGY_RE = /\b(?:i'?m sorry|im sorry|sorry|my bad|my fault|oops|whoops)\b/i;
const REMEDIATION_RE = new RegExp(`${DESTRUCTIVE_RE.source}|${RECOVERY_RE.source}`, 'i');

const SECURITY_FILE_RE = /(?:^|[\\/])(?:\.env[^\\/]*|[^\\/]*(?:auth|session|middleware|login|signin|signup|permission|rbac|access[-_]?control|secur|crypto|jwt|oauth|passwd|password|secret|credential|token)[^\\/]*)$/i;
const SECURITY_FILE_EXCLUDE_RE = /(?:^|[\\/])(?:[^\\/]*tokens?\.[a-z]+|tokenizer[^\\/]*|[^\\/]*[-_.]?token(?:izer|s)?\.(?:tsx?|jsx?|css|scss|json|svg)|semantic[-_]?tokens?[^\\/]*|design[-_]?tokens?[^\\/]*)$/i;
export const RISKY_CMD_PARTS = [
  { name: 'rm_rf_combined', re: /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*(?:rf|fr)[a-zA-Z]*\b/i },
  { name: 'rm_r_then_f', re: /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*\b/i },
  { name: 'rm_f_then_r', re: /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\b/i },
  { name: 'chmod_world_writable', re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*0?777\b/i },
  { name: 'curl_pipe_shell', re: /(?:curl|wget)[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\b/i },
  { name: 'shell_process_substitution', re: /\b(?:sh|bash|zsh|dash|ksh)\s+<\(\s*(?:curl|wget)\b/i },
  { name: 'no_verify', re: /--no-verify\b/i },
  { name: 'force', re: /--force(?![\w-])/i },
  { name: 'drop_table', re: /\bDROP\s+TABLE\b/i },
  { name: 'drop_schema', re: /\bDROP\s+SCHEMA\b/i },
  { name: 'truncate', re: /\bTRUNCATE\s+(?:TABLE\s+)?[\w."`]+/i },
];
const RISKY_CMD_RE = composeOr(RISKY_CMD_PARTS);
const SECRET_CONTENT_RE = /(?:\bsource\s+[^\n]*\.env\b|(?:^|[;&|]|\s)\.\s+[^\n]*\.env\b|\.env\.(?:secrets|local|prod|production)\b|\bexport\s+[A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|API_KEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY)\b|\b(?:wrangler|doppler|vault)\b|\bgh\s+auth\b|\baws\s+configure\b|\bgcloud\s+auth\b|\bkubectl\s+config\s+set-credentials\b)/i;
const ACCESS_CONTROL_CONTENT_RE = /\b(?:grant\s+(?:select|insert|update|delete|all)\b|setfacl|chmod\s+[0-7]{3,4}\b)/i;
const ACCESS_CONTROL_WEAK_RE = /\b(?:rbac|access[-_]?control)\b/i;

function isCredentialFile(file) {
  if (!file || !SECURITY_FILE_RE.test(file)) return false;
  if (SECURITY_FILE_EXCLUDE_RE.test(file)) return false;
  return true;
}

const SECURITY_SURFACE_RULES = [
  { surface: 'auth', re: /(?:^|[\\/])[^\\/]*(?:auth|login|signin|signup|session|oauth|jwt|sso|saml)[^\\/]*$/i },
  { surface: 'secrets', re: /(?:^|[\\/])(?:\.env[^\\/]*|[^\\/]*(?:secret|credential|password|passwd|apikey|api[-_]key|token)[^\\/]*)$/i },
  { surface: 'access-control', re: /(?:^|[\\/])[^\\/]*(?:rbac|permission|access[-_]?control|policy|policies|guard|middleware)[^\\/]*$/i },
  { surface: 'crypto', re: /(?:^|[\\/])[^\\/]*(?:crypto|cipher|encrypt|decrypt|hash|hmac|signature|signing)[^\\/]*$/i },
  { surface: 'dependency-config', re: /(?:^|[\\/])(?:package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile)$/i },
  { surface: 'ci', re: /(?:^|[\\/])(?:\.github[\\/]workflows[\\/][^\\/]+|\.gitlab-ci\.yml|\.circleci[\\/][^\\/]+|azure-pipelines\.yml|Jenkinsfile)$/i },
  { surface: 'deployment', re: /(?:^|[\\/])(?:Dockerfile|docker-compose[^\\/]*\.ya?ml|[^\\/]*\.(?:tf|tfvars)|wrangler\.toml|vercel\.json|netlify\.toml|fly\.toml|[^\\/]*deploy[^\\/]*)$/i },
  { surface: 'tests', re: /(?:^|[\\/])[^\\/]*(?:\.(?:test|spec)\.[a-z0-9]+|_test\.[a-z0-9]+|test_[^\\/]+)$|(?:^|[\\/])(?:tests?|__tests__|spec)[\\/]/i },
];
const TEST_SKIP_API_RE =
  /\b(?:test|it|describe|context|suite|t)\.(?:skip|only|todo)\b|\bx(?:it|describe|test|context)\s*\(|\bf(?:it|describe)\s*\(|@(?:Disabled|Ignore|Skip)\b|\bpytest\.mark\.skip\w*|\b(?:skip|disabl\w*|remov\w*|delet\w*|drop)\b[^.\n]{0,24}\b(?:e2e|integration|unit|smoke|auth)?\s*(?:tests?|specs?|suite)\b|\b(?:tests?|specs?|suite)\b[^.\n]{0,24}\b(?:disabl|skip|remov|delet|comment(?:ed)? out|turn(?:ed)? off)\w*|--no-tests?\b|--skip-tests?\b/i;
const TEST_SKIP_RE =
  /\b(?:disabl|skip|remov|delet|comment(?:ed)? out|drop|turn(?:ed)? off|x?(?:it|describe)\.skip|--no-tests?|--skip-tests?)\w*\b[^.\n]{0,24}\btests?\b|\btests?\b[^.\n]{0,24}\b(?:disabl|skip|remov|delet|comment(?:ed)? out|turn(?:ed)? off)\w*/i;

// P6: strong human security-correction phrasing. Used as a corroborating co-signal and as
// the inferred-tier recall backstop (must never mint a strong/verified label by itself).
const SECURITY_CORRECTION_RE =
  /\b(?:don'?t|do not|never)\b[^.]{0,30}\b(?:leak|expose|commit|hardcode|hard[- ]?code|push|publish)\b[^.]{0,30}\b(?:secret|secrets|token|tokens|key|keys|credential|credentials|password|passwords|env|api)\b|\b(?:rotate|revoke|regenerate|invalidate)\b[^.]{0,25}\b(?:that|the|this|those|your|my)?\s*(?:secret|token|key|credential|password|pat|api[- ]?key|access token)\b|\bthat'?s? (?:a|the|my|our) (?:secret|credential|api[- ]?key|token|password)\b|\b(?:revert|undo|roll ?back)\b[^.]{0,25}\b(?:the|that|those)?\s*(?:auth|security|permission|access[- ]?control|rbac|credential)\b|\b(?:you|it)\b[^.]{0,20}\b(?:leaked|exposed|hardcoded|hard[- ]?coded|committed)\b[^.]{0,25}\b(?:secret|token|key|credential|password|env)\b/i;

function hasSecurityCorrection(text) {
  return typeof text === 'string' && text.length <= 4000 && SECURITY_CORRECTION_RE.test(text);
}

export function classifySecuritySurface(file) {
  if (!file) return null;
  for (const rule of SECURITY_SURFACE_RULES) {
    if (rule.re.test(file)) return rule.surface;
  }
  return null;
}

export function isRiskyCommand(command) {
  return typeof command === 'string' && RISKY_CMD_RE.test(command);
}

export function mentionsTestSkip(text) {
  return (
    typeof text === 'string' &&
    text.length <= 4000 &&
    (TEST_SKIP_RE.test(text) || TEST_SKIP_API_RE.test(text))
  );
}

// P3: return ALL matching kinds per action instead of first-match-wins, so a node that
// is both a credential leak and a disabled-test (etc.) surfaces every class. Each kind
// carries its own strong/weak flag and the body that triggered it (for the audit trail).
// `weak` marks a lone keyword (bare rbac/access-control) that needs a co-signal (P4).
function securityActions(node) {
  const out = [];
  for (const a of node.actions || []) {
    const body = `${a.command || ''} ${a.input || ''}`;
    const kinds = [];
    if (SECRET_CONTENT_RE.test(body)) kinds.push({ kind: 'credential', strong: true });
    if (a.file && isCredentialFile(a.file)) kinds.push({ kind: 'file', strong: true });
    if (ACCESS_CONTROL_CONTENT_RE.test(body)) kinds.push({ kind: 'access-control', strong: true });
    if (a.command && RISKY_CMD_RE.test(a.command)) kinds.push({ kind: 'risky-command', strong: false });
    // Weak keyword: only counts when no strong access-control content already fired on this action.
    if (ACCESS_CONTROL_WEAK_RE.test(body) && !kinds.some((k) => k.kind === 'access-control')) {
      kinds.push({ kind: 'access-control', strong: false, weak: true });
    }
    for (const k of kinds) out.push({ action: a, ...k });
  }
  return out;
}

// Anchor confidences kept stable so existing tiers/numbers do not regress:
//   one strong signal  -> verified / 0.95 (unchanged anchor the suite asserts on)
//   weak-only + cosignal-> high / 0.84
//   inferred backstops  -> 0.62-0.70
const SECURITY_STRONG_BASE = 0.95;
const SECURITY_WEAK_BASE = 0.84;

// P1: derive a security signal's confidence and tier from how many INDEPENDENT signals
// corroborate it, instead of a constant two-bucket value. Each contributing signal is
// listed in the evidence text (with node ids upstream) so the verdict stays auditable.
// P4: a lone weak keyword (bare rbac/access-control) scores low and lands `inferred`
// unless a real co-signal (credential content, security surface file, or human security
// correction) is present.
function scoreSecurity({ secActs, surface, humanCorrection }) {
  const signals = [];
  const strongActs = secActs.filter((s) => s.strong);
  const weakActs = secActs.filter((s) => !s.strong);
  const hasStrong = strongActs.length > 0;
  const hasWeakKeywordOnly = !hasStrong && secActs.some((s) => s.weak);

  if (strongActs.some((s) => s.kind === 'credential')) signals.push('strong credential content');
  if (strongActs.some((s) => s.kind === 'file')) signals.push('credential filename');
  if (strongActs.some((s) => s.kind === 'access-control')) signals.push('access-control command');
  if (weakActs.some((s) => s.kind === 'risky-command')) signals.push('risky command');
  if (weakActs.some((s) => s.weak)) signals.push('access-control keyword');
  if (surface) signals.push(`security surface (${surface})`);
  if (humanCorrection) signals.push('human security correction');

  // Independent corroboration count beyond the primary signal nudges confidence within band.
  const corroboration = Math.max(0, signals.length - 1);

  let tier;
  let base;
  if (hasStrong) {
    tier = 'verified';
    base = SECURITY_STRONG_BASE;
  } else if (hasWeakKeywordOnly) {
    // P4 co-signal gate: a bare keyword with a real co-signal earns `high`; alone it stays `inferred`.
    const cosignal = Boolean(surface) || humanCorrection || weakActs.some((s) => s.kind === 'risky-command');
    if (cosignal) {
      tier = 'high';
      base = SECURITY_WEAK_BASE;
    } else {
      tier = 'inferred';
      base = 0.62;
    }
  } else {
    // risky-command (no keyword) or surface-only corroboration
    tier = 'high';
    base = SECURITY_WEAK_BASE;
  }

  // Within-band lift from extra corroboration, clamped to the band ceiling so the
  // verified anchor (0.95) and existing assertions never move.
  const ceiling = tier === 'verified' ? 0.95 : tier === 'high' ? 0.9 : 0.7;
  const confidence = Math.min(ceiling, Math.round((base + 0.02 * corroboration) * 100) / 100);
  return { tier, confidence, signals };
}

function fileHint(node) {
  for (const a of node.actions || []) {
    if (a.file) return a.file;
  }
  const text = String(node.text || '');
  const m = text.match(/\b([\w./\\-]+\.[a-z0-9]{1,5})\b/i) || text.match(/\b([A-Za-z]:[\\/][^\s"']+)/);
  return m ? m[1] : null;
}

function badPathEpisode(node) {
  const text = String(node.text || '');
  if (text.length > WORDING_SCAN_MAX_CHARS) return null;
  const destructive = DESTRUCTIVE_RE.test(text);
  const recovery = RECOVERY_RE.test(text);
  if (!destructive && !recovery) return null;
  if (!destructive && recovery && !APOLOGY_RE.test(text)) return null;
  const target = fileHint(node);
  const where = target ? `\`${truncate(String(target), 70)}\`` : 'a file';
  const tail = recovery
    ? ' and had to be recovered; guard against destructive file operations.'
    : ' was reported as lost or broken; guard against destructive file operations.';
  return {
    confidence: destructive && recovery ? 0.9 : 0.75,
    tier: destructive && recovery ? 'verified' : 'high',
    summary: `${where} was deleted or damaged${tail}`,
  };
}

export function analyzeTree(tree) {
  if (tree.analysis) return tree.analysis;
  _tokenCache = new WeakMap();
  const modelsSeen = new Set();
  let thinkingBlocks = 0;
  for (const node of tree.nodes) {
    node.failureSignals = [];
    node.evalCandidate = false;
    node.lessonIds = [];
    node.model = (node.actions || []).map((a) => a.model).find(Boolean) || null;
    for (const a of node.actions || []) if (a.model) modelsSeen.add(a.model);
    thinkingBlocks += node.thinking || 0;
  }

  const failures = [];
  const correctionChains = [];
  const lessons = [];
  const evalCandidates = [];

  const pad = (n) => String(n).padStart(3, '0');
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const failureByKey = new Map();
  const lessonByType = new Map();
  const evalByType = new Map();

  const linkChain = (type, confidence, failureNode, correctionNode, resolvedNode, summary) => {
    if (!correctionNode || correctionNode.id === failureNode.id) return;
    if (!afterFailure(correctionNode, failureNode)) return;
    const resolved = resolvedNode && afterFailure(resolvedNode, failureNode) ? resolvedNode : null;
    if (correctionChains.some((c) => c.failureNodeId === failureNode.id && c.correctionNodeId === correctionNode.id)) {
      return;
    }
    correctionChains.push({
      id: `chain_${pad(correctionChains.length + 1)}`,
      failureNodeId: failureNode.id,
      correctionNodeId: correctionNode.id,
      resolvedNodeId: resolved?.id || null,
      failureType: type,
      confidence: confidenceLabel(confidence),
      summary,
    });
  };

  const addFailure = ({ type, confidence, tier = 'inferred', failureNode, correctionNode, resolvedNode, evidence, summary }) => {
    if (!FAILURE_TYPES.has(type) || !failureNode) return null;
    if (correctionNode && correctionNode.id === failureNode.id) correctionNode = null;
    if (correctionNode && !afterFailure(correctionNode, failureNode)) correctionNode = null;
    if (resolvedNode && !afterFailure(resolvedNode, failureNode)) resolvedNode = null;
    const model = failureNode.model || null;

    const ids = uniq([failureNode.id, correctionNode?.id, resolvedNode?.id]);
    const key = `${type}:${failureNode.id}`;
    const existing = failureByKey.get(key);
    if (existing) {
      if (confidence > existing.confidence) existing.confidence = confidence;
      if (tierRank(tier) > tierRank(existing.tier)) existing.tier = tier;
      const lr = lessonByType.get(type);
      if (lr) lr.nodeIds = uniq([...lr.nodeIds, failureNode.id]);
      const er = evalByType.get(evalTypeFor(type));
      if (er) er.sourceNodeIds = uniq([...er.sourceNodeIds, ...ids]);
      if (correctionNode && !existing.correctedByNodeId) existing.correctedByNodeId = correctionNode.id;
      linkChain(type, confidence, failureNode, correctionNode, resolvedNode, summary);
      return existing;
    }

    const lesson = lessonFor(type, { evidence, summary });
    let lessonRec = lessonByType.get(type);
    if (!lessonRec) {
      lessonRec = { id: `lesson_${pad(lessons.length + 1)}`, title: lesson.title, nodeIds: [failureNode.id], text: lesson.text };
      lessons.push(lessonRec);
      lessonByType.set(type, lessonRec);
    } else {
      lessonRec.nodeIds = uniq([...lessonRec.nodeIds, failureNode.id]);
    }

    const evalType = evalTypeFor(type);
    let evalRec = evalByType.get(evalType);
    if (!evalRec) {
      evalRec = {
        id: `eval_${pad(evalCandidates.length + 1)}`,
        source: 'treetrace',
        type: evalType,
        task: evalTaskFor(type),
        context: summary,
        input: correctionNode
          ? `Honor this correction and keep building: "${quote(correctionNode.text)}"`
          : `Honor this stated requirement and keep building: "${quote(failureNode.text)}"`,
        expected_behavior: expectedBehaviorFor(type),
        failure_mode: failureModeFor(type),
        sourceNodeIds: ids,
      };
      evalCandidates.push(evalRec);
      evalByType.set(evalType, evalRec);
    } else {
      evalRec.sourceNodeIds = uniq([...evalRec.sourceNodeIds, ...ids]);
    }

    failureNode.failureSignals.push({
      type,
      tier,
      confidence,
      model,
      evidence,
      resolvedBy: correctionNode?.id || resolvedNode?.id || null,
    });
    failureNode.evalCandidate = true;
    failureNode.lessonIds.push(lessonRec.id);

    const failure = {
      id: `failure_${pad(failures.length + 1)}`,
      type,
      tier,
      confidence,
      model,
      firstSeenNodeId: failureNode.id,
      correctedByNodeId: correctionNode?.id || null,
      summary,
      evidence,
      lesson: lesson.text,
      evalCandidate: true,
    };
    failures.push(failure);
    failureByKey.set(key, failure);
    linkChain(type, confidence, failureNode, correctionNode, resolvedNode, summary);
    return failure;
  };

  const securityNodeIds = new Set();
  tree.nodes.forEach((node, index) => {
    // v0.3: rejection surfacing pass. Each captured rejection becomes a failure
    // signal of the mapped type. Rejection failures do not call
    // nearestCorrectionAfter / nearestAcceptedAfter (each O(N), which would
    // regress the v0.7.0 O(N) assembly guarantee on rejection-heavy sessions):
    // a rejection IS the failure event, and its resolution is implicit in the
    // next accepted turn rather than something we need to chase. Single pass,
    // O(N) over nodes times O(R) over rejections per node, where R is bounded
    // by the number of tool blocks per turn. Identical failure type on the same
    // node merges into the existing record via addFailure's dedup-by-key path.
    if (Array.isArray(node.rejections) && node.rejections.length) {
      for (const r of node.rejections) {
        const type = REJECTION_KIND_TO_FAILURE_TYPE[r.kind];
        if (!type) continue;
        const tier = tierForRejection(r.confidence || 0);
        const ev = r.evidence
          ? `${r.kind} (${r.source || 'tool_result'}): "${quote(r.evidence)}"`
          : `${r.kind} (${r.source || 'stop_reason'})`;
        addFailure({
          type,
          confidence: r.confidence || 0.7,
          tier,
          failureNode: node,
          correctionNode: null,
          resolvedNode: null,
          evidence: ev,
          summary: summarizeRejection(r, node),
        });
      }
    }

    const secActs = securityActions(node);
    if (secActs.length) {
      // P1: corroborating co-signals -- surface class on a touched file, and a human
      // security correction that points back at this node -- feed the derived score.
      const surface = uniq((node.actions || []).map((a) => classifySecuritySurface(a.file))).filter(Boolean)[0] || null;
      const humanCorrection =
        node.kind !== 'correction' ? Boolean(nearestSecurityCorrection(tree.nodes, node)) : false;
      const { tier, confidence, signals } = scoreSecurity({ secActs, surface, humanCorrection });
      const targets = uniq(secActs.map((s) => s.action.file || s.action.command || s.action.input)).slice(0, 3);
      const kinds = uniq(secActs.map((s) => s.kind)); // P3: every matching class, not first-match-wins
      addFailure({
        type: 'security_or_privacy_risk',
        confidence,
        tier,
        failureNode: node,
        correctionNode: node.kind === 'correction' ? null : nearestCorrectionAfter(tree.nodes, node),
        resolvedNode: nearestAcceptedAfter(tree.nodes, node, null),
        evidence: `Agent action touched ${kinds.join(', ')} [signals: ${signals.join('; ')}]: ${targets.map((t) => `"${truncate(String(t), 80)}"`).join(', ')}`,
        summary: `An agent action touched auth, secrets, or access control near "${truncate(node.title, 90)}".`,
      });
      securityNodeIds.add(node.id);
    } else if (node.text.length <= 1200 && SECURITY_INTENT_RE.test(node.text)) {
      addFailure({
        type: 'security_or_privacy_risk',
        confidence: 0.7,
        tier: 'inferred',
        failureNode: node,
        correctionNode: null,
        resolvedNode: nearestAcceptedAfter(tree.nodes, node, null),
        evidence: `User stated a security-sensitive intent: "${quote(node.text)}"`,
        summary: `A security-sensitive intent was stated near "${truncate(node.title, 90)}".`,
      });
      securityNodeIds.add(node.id);
    }

    // P6: human-correction security-recall backstop. A human turn with a strong security
    // correction ("don't leak that", "rotate that key", "revert the auth change") whose
    // corrected (prior) node carried NO security label catches a real security event whose
    // action phrasing missed the keyword list. Strictly `inferred` and human-grounded -- it
    // never fabricates a strong/verified label.
    if (hasSecurityCorrection(node.text)) {
      const prior = nearestFailureTarget(node, tree.nodes);
      const anchor = prior ? prior.target : null;
      if (anchor && !securityNodeIds.has(anchor.id) && anchor.id !== node.id) {
        addFailure({
          type: 'security_or_privacy_risk',
          confidence: 0.62,
          tier: 'inferred',
          failureNode: anchor,
          correctionNode: node,
          resolvedNode: nearestAcceptedAfter(tree.nodes, anchor, node),
          evidence: `Human flagged a security concern about a prior action with no security label [signal: human security correction]: "${quote(node.text)}"`,
          summary: `A human security correction was raised near "${truncate(anchor.title, 90)}" with no matching action-level signal.`,
        });
        securityNodeIds.add(anchor.id);
      }
    }

    if (node.status === 'abandoned') {
      addFailure({
        type: 'abandoned_path',
        confidence: 0.9,
        tier: 'verified',
        failureNode: node,
        resolvedNode: nearestAcceptedAfter(tree.nodes, node, null),
        evidence: `Branch abandoned after prompt: "${quote(node.text)}"`,
        summary: `A side path was abandoned: ${truncate(node.title, 120)}`,
      });
      return;
    }

    const destructive = badPathEpisode(node);
    if (destructive) {
      addFailure({
        type: 'abandoned_path',
        confidence: destructive.confidence,
        tier: destructive.tier,
        failureNode: node,
        resolvedNode: nearestAcceptedAfter(tree.nodes, node, null),
        evidence: `User reported a destructive event: "${quote(node.text)}"`,
        summary: destructive.summary,
      });
    }

    const shouldAnalyze =
      node.kind === 'correction' ||
      CORRECTION_HINT.test(node.text) ||
      FRUSTRATION_HINT.test(node.text) ||
      PRIVACY_HINT.test(node.text);
    if (!shouldAnalyze) return;

    const signals = inferSignals(node);
    if (!signals.length) return;

    const prior = nearestFailureTarget(node, tree.nodes);
    const priorNode = prior ? prior.target : null;
    const corroborated = node.kind === 'correction' || (priorNode && sharesEvidence(priorNode, node));

    let failureNode;
    let correctionNode;
    let linkage;
    if (priorNode && corroborated) {
      failureNode = priorNode;
      correctionNode = node;
      linkage = prior.linkage;
    } else if (node.kind === 'correction') {
      failureNode = node;
      correctionNode = null;
      linkage = 'positional';
    } else {
      return;
    }

    const resolvedNode = nearestAcceptedAfter(tree.nodes, failureNode, correctionNode);

    for (const signal of signals) {
      const tier = correctionNode ? 'confirmed' : 'inferred';
      let confidence =
        tier === 'confirmed' ? Math.max(signal.confidence, 0.82) : Math.min(signal.confidence, 0.7);
      if (linkage === 'positional') confidence = Math.min(confidence, 0.68);
      addFailure({
        type: signal.type,
        confidence,
        tier: linkage === 'positional' ? 'inferred' : tier,
        failureNode,
        correctionNode,
        resolvedNode,
        evidence: `User said: "${quote(node.text)}"`,
        summary: summarizeFailure(signal.type, failureNode, correctionNode),
      });
    }
  });

  const topFailureTypes = countTypes(failures);
  tree.analysis = {
    schemaVersion: SCHEMA_VERSION,
    summary: {
      totalFailureSignals: failures.length,
      topFailureTypes,
      tierCounts: countTiers(failures),
      models: [...modelsSeen],
      thinkingBlocks,
      correctionChains: correctionChains.length,
      evalCandidates: evalCandidates.length,
      lessons: lessons.length,
    },
    failures,
    correctionChains,
    lessons,
    evalCandidates,
  };
  return tree.analysis;
}

export function renderFailuresJson(tree, opts = {}) {
  const analysis = analyzeTree(tree);
  return {
    schemaVersion: SCHEMA_VERSION,
    project: projectBlock(opts),
    summary: analysis.summary,
    failures: analysis.failures,
    correctionChains: analysis.correctionChains,
  };
}

// v0.3: flattened rejection view for --rejections CLI flag and MCP tool. Walks
// nodes once (O(N) over nodes times O(R) over rejections per node) and joins
// each rejection back to its source node id so consumers can locate it in the
// tree. The failure-signal view in renderFailuresJson already includes the
// derived failures; this view is the raw rejection ledger.
export function renderRejectionsJson(tree, opts = {}) {
  analyzeTree(tree);
  const out = [];
  const byKind = Object.create(null);
  for (const node of tree.nodes) {
    if (!Array.isArray(node.rejections) || !node.rejections.length) continue;
    for (const r of node.rejections) {
      out.push({
        nodeId: node.id,
        kind: r.kind,
        source: r.source || null,
        confidence: r.confidence,
        toolUseId: r.toolUseId || null,
        tool: r.tool || null,
        ts: r.ts || node.ts || null,
        evidence: r.evidence || null,
      });
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    }
  }
  out.sort((a, b) => {
    const ta = a.ts ? Date.parse(a.ts) : NaN;
    const tb = b.ts ? Date.parse(b.ts) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return (a.nodeId || '').localeCompare(b.nodeId || '');
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    project: projectBlock(opts),
    summary: {
      total: out.length,
      byKind: { ...byKind },
    },
    rejections: out,
  };
}

export function renderLessonsMarkdown(tree, opts = {}) {
  const analysis = analyzeTree(tree);
  const lines = ['# Lessons', ''];
  if (!analysis.lessons.length) {
    lines.push('No high-confidence failure lessons were detected in this session.');
    lines.push('');
    return lines.join('\n');
  }
  analysis.lessons.forEach((lesson) => {
    const ids = lesson.nodeIds;
    const shown = ids.slice(0, 8).join(', ');
    const overflow = ids.length > 8 ? `, +${ids.length - 8} more` : '';
    lines.push(`- **${escapeMd(lesson.title)}.** ${escapeMd(compactLessonText(lesson.text))} [${shown}${overflow}]`);
  });
  lines.push('');
  return lines.join('\n');
}

export function renderEvalsJsonl(tree) {
  const analysis = analyzeTree(tree);
  return analysis.evalCandidates.map((e) => JSON.stringify(e)).join('\n') + (analysis.evalCandidates.length ? '\n' : '');
}

export function renderMemoryMarkdown(tree, opts = {}) {
  const analysis = analyzeTree(tree);
  const projectName = opts.projectName || 'this project';
  const nodes = tree.nodes || [];
  const live = (n) => n.status !== 'abandoned';
  const lines = [`Project: ${escapeMd(projectName)}`, ''];

  const constraints = extractConstraints(nodes);
  if (constraints.length) {
    lines.push('## Constraints');
    for (const label of constraints) lines.push(`- ${escapeMd(truncate(label, 140))}`);
    lines.push('');
  }

  if (analysis.lessons.length) {
    lines.push('## Lessons');
    for (const lesson of analysis.lessons.slice(0, 8)) {
      const ids = lesson.nodeIds || [];
      const shown = ids.slice(0, 8).join(', ');
      const overflow = ids.length > 8 ? `, +${ids.length - 8} more` : '';
      const nodeIds = shown ? ` [${shown}${overflow}]` : '';
      lines.push(`- ${escapeMd(lesson.title)}: ${escapeMd(compactLessonText(lesson.text))}${nodeIds}`);
    }
    lines.push('');
  }

  const badPaths = analysis.failures.filter((f) => f.type === 'abandoned_path').slice(0, 6);
  if (badPaths.length) {
    lines.push('## Bad paths');
    for (const failure of badPaths) lines.push(`- ${escapeMd(failure.summary)}`);
    lines.push('');
  }

  const security = analysis.failures
    .filter((f) => f.type === 'security_or_privacy_risk')
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))
    .slice(0, 8);
  if (security.length) {
    lines.push('## Security');
    for (const f of security) {
      const tag = f.tier === 'inferred' ? 'stated intent' : f.tier;
      const nodeId = f.firstSeenNodeId ? ` [${f.firstSeenNodeId}]` : '';
      lines.push(`- (${tag})${nodeId} ${escapeMd(truncate(compactEvidenceText(f.evidence), 200))}`);
    }
    lines.push('');
  }

  lines.push('## Next');
  const strategic = nodes.filter(
    (n) =>
      live(n) &&
      (n.kind === 'root' || n.kind === 'direction' || n.kind === 'scope-change') &&
      isStrategicDirection(n)
  );
  const latest = latestByTime(strategic);
  if (latest) {
    lines.push(`- Continue: ${escapeMd(truncate(latest.title, 140))}`);
  } else {
    lines.push(`- No open forward direction was stated; resume the goal of ${escapeMd(projectName)} and confirm scope with the user.`);
  }
  const openCorrections = nodes
    .filter((n) => live(n) && n.kind === 'correction' && isStrategicDirection(n))
    .slice(-3);
  for (const n of openCorrections) lines.push(`- Constraint: ${escapeMd(truncate(n.title, 120))}`);
  lines.push('');

  return lines.join('\n');
}

function compactLessonText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const evidenceAt = normalized.indexOf('Specifically:');
  return evidenceAt === -1 ? normalized : normalized.slice(evidenceAt + 'Specifically:'.length).trim();
}

function compactEvidenceText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const quoted = normalized.match(/"[^"]+"/);
  return quoted ? quoted[0] : normalized;
}

export function latestByTime(nodes) {
  if (!nodes || !nodes.length) return null;
  const timed = nodes.filter((n) => tsOf(n) !== null);
  if (timed.length) {
    return timed.reduce((best, n) => (tsOf(n) >= tsOf(best) ? n : best), timed[0]);
  }
  return nodes[nodes.length - 1];
}

export function isStrategicDirection(node) {
  const text = String(node.text || '').trim();
  if (!text) return false;
  if (REMEDIATION_RE.test(text) || APOLOGY_RE.test(text)) return false;
  const stripped = text.replace(/[\s.!?]+$/g, '');
  if (stripped.length < 12) return false;
  if (/^(?:yes|yep|yeah|ok|okay|sure|nice|perfect|great|good|lgtm|thanks?|cool|agreed?)\b/i.test(stripped)) {
    if (stripped.length < 40) return false;
  }
  if (/\?\s*$/.test(text) && text.length < 80) return false;
  return true;
}

function constraintClauses(text) {
  return String(text || '')
    .split(/(?:[.!?\n]+|\s*;\s*|\s+-\s+|,\s+(?=(?:no|don'?t|do not|never|must|always|only|keep|ensure|make sure|avoid|stay)\b))/i)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function constraintPhrase(clause) {
  let phrase = clause;
  const cue = phrase.search(
    /\b(?:no|don'?t|do not|never|must(?: not)?|always|only|make sure|ensure|avoid|keep it|keep the|stay|without)\b/i
  );
  if (cue > 0) phrase = phrase.slice(cue);
  phrase = phrase.replace(/^(?:and|also|but|so|then|please|okay|ok|yes|lol)\b[\s,]*/i, '').trim();
  phrase = phrase.replace(/[\s,;:.!?-]+$/g, '').trim();
  if (phrase.length > CONSTRAINT_CLAUSE_MAX) phrase = truncate(phrase, CONSTRAINT_CLAUSE_MAX);
  return phrase;
}

function constraintKey(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

function extractConstraintsFromNode(node) {
  const text = node.text || '';
  if (!text) return [];
  const found = [];
  const seenLocal = new Set();
  const push = (label, weight) => {
    const key = constraintKey(label);
    if (!key || seenLocal.has(key)) return;
    seenLocal.add(key);
    found.push({ label, key, weight });
  };

  for (const named of CONSTRAINT_NAMED) {
    if (named.re.test(text)) push(named.label, 3);
  }

  for (const clause of constraintClauses(text)) {
    if (found.length >= CONSTRAINT_PER_NODE_CAP) break;
    if (clause.length < 6 || clause.length > 220) continue;
    if (!CONSTRAINT_DIRECTIVE_RE.test(clause)) continue;
    if (CONSTRAINT_DESCRIPTIVE_RE.test(clause)) continue;
    if (/\?\s*$/.test(clause)) continue;
    if (CONSTRAINT_NAMED.some((n) => n.re.test(clause))) continue;
    const phrase = constraintPhrase(clause);
    if (phrase.length < 6) continue;
    push(phrase.charAt(0).toUpperCase() + phrase.slice(1), 1);
  }

  return found.slice(0, CONSTRAINT_PER_NODE_CAP);
}

function extractConstraints(nodes) {
  const byKey = new Map();
  nodes.forEach((node, order) => {
    if (node.status === 'abandoned') return;
    for (const c of extractConstraintsFromNode(node)) {
      const existing = byKey.get(c.key);
      if (existing) {
        existing.count += 1;
        existing.weight = Math.max(existing.weight, c.weight);
        if (order >= existing.order) {
          existing.order = order;
          if (c.weight >= existing.bestWeight) {
            existing.label = c.label;
            existing.bestWeight = c.weight;
          }
        }
      } else {
        byKey.set(c.key, { label: c.label, count: 1, weight: c.weight, bestWeight: c.weight, order });
      }
    }
  });
  return [...byKey.values()]
    .sort((a, b) => b.weight - a.weight || b.count - a.count || b.order - a.order)
    .slice(0, CONSTRAINT_LIST_CAP)
    .map((c) => c.label);
}

function inferSignals(node) {
  const text = node.text || '';
  if (node.kind !== 'correction' && text.length > WORDING_SCAN_MAX_CHARS) {
    return [];
  }
  const matched = new Map();
  const consider = (type, confidence) => {
    const prev = matched.get(type);
    if (prev === undefined || confidence > prev) matched.set(type, confidence);
  };

  if (SCOPE_DRIFT_HINT.test(text)) consider('scope_drift', 0.82);
  if (/\b(i said|you forgot|you ignored|not what i (asked|wanted|meant)|asked for)\b/i.test(text)) {
    consider('ignored_constraint', 0.84);
  }
  if (TOOL_HINT.test(text)) consider('dependency_or_environment_mismatch', 0.72);
  if (/\bwrong tool|wrong library|use .* instead\b/i.test(text)) consider('wrong_tool_choice', 0.78);
  if (HALLUCINATION_HINT.test(text)) consider('hallucinated_file_or_api', 0.82);
  if (REPEATED_FIX_HINT.test(text)) consider('repeated_failed_fix', 0.8);
  if (/\btoo much|overbuilt|scrap .* web app|too heavy\b/i.test(text)) consider('overbuilt_solution', 0.78);
  if (UNDERBUILT_HINT.test(text)) consider('underbuilt_solution', 0.76);
  if (FORMAT_HINT.test(text)) consider('format_violation', 0.68);
  if (FRUSTRATION_HINT.test(text)) consider('user_frustration', 0.72);
  if (!matched.size && node.kind === 'correction') consider('misunderstood_goal', 0.62);

  if (!matched.size) return [];
  // P3: return all matching process kinds in priority order (capped) instead of
  // first-match-wins, so a node that is e.g. both scope_drift and ignored_constraint
  // surfaces both. misunderstood_goal is a fallback-only label and never co-emits.
  const out = [];
  for (const type of SIGNAL_PRIORITY) {
    if (type === 'misunderstood_goal') continue;
    if (matched.has(type)) out.push({ type, confidence: matched.get(type) });
  }
  if (!out.length && matched.has('misunderstood_goal')) {
    return [{ type: 'misunderstood_goal', confidence: matched.get('misunderstood_goal') }];
  }
  return out.slice(0, PROCESS_LABEL_CAP);
}

function tsOf(node) {
  const t = node && node.ts ? new Date(node.ts).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

// Ingestion ordinal: node ids are assigned in stream order as `node_NNN` (src/tree.js),
// so the numeric suffix is a stable parse-time ordinal. This is the causality tiebreak
// used when timestamps are missing, instead of optimistically returning true (STRUCT-1).
function ordinalOf(node) {
  if (!node) return null;
  if (Number.isFinite(node._ord)) return node._ord;
  const m = /(\d+)\s*$/.exec(String(node.id || ''));
  return m ? Number(m[1]) : null;
}

// P2: when timestamps are present, enforce ts ordering. When either timestamp is
// missing, fall back to ingestion-ordinal ordering rather than returning true, so
// timestamp-less adapters still get a real causal ordering and a corrector can never
// be linked to a failure it preceded in the stream.
function afterFailure(candidate, failureNode) {
  const ct = tsOf(candidate);
  const ft = tsOf(failureNode);
  if (ct !== null && ft !== null) return ct >= ft;
  const co = ordinalOf(candidate);
  const fo = ordinalOf(failureNode);
  if (co !== null && fo !== null) return co >= fo;
  // No timestamp and no ordinal on either side: cannot establish ordering -> fail closed.
  return false;
}

function actionFiles(node) {
  return new Set((node.actions || []).map((a) => a.file).filter(Boolean));
}

function sharedFiles(a, b) {
  const fa = actionFiles(a);
  if (!fa.size) return false;
  for (const f of actionFiles(b)) if (fa.has(f)) return true;
  return false;
}

let _tokenCache = new WeakMap();
function tokenSet(node) {
  if (!node) return new Set();
  const cached = _tokenCache.get(node);
  if (cached) return cached;
  const out = new Set();
  const harvest = (s) => {
    for (const raw of String(s || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []) {
      if (!STOPWORDS.has(raw)) out.add(raw);
    }
  };
  harvest(node.text);
  // Include path tokens from this node's action files so a correction that names the
  // touched surface ("the auth flow") ties back to an edit of `src/auth/session.ts`.
  // This strengthens semantic linkage (STRUCT-3) without temporal guessing.
  for (const a of node.actions || []) {
    if (a.file) harvest(String(a.file).replace(/[\\/.+_-]+/g, ' '));
  }
  _tokenCache.set(node, out);
  return out;
}

function tokenOverlap(a, b) {
  const ta = tokenSet(a);
  if (!ta.size) return 0;
  const tb = tokenSet(b);
  let hits = 0;
  for (const t of tb) if (ta.has(t)) hits++;
  return hits;
}

// Distinctive surface tokens: a single shared one between a security-file edit and a
// correction is a strong semantic tie (e.g. an `auth/session.ts` edit + "fix the auth flow"),
// where generic token overlap >= 3 would miss the link.
const SURFACE_TOKENS = new Set([
  'auth', 'session', 'login', 'signin', 'signup', 'oauth', 'jwt', 'sso', 'saml',
  'secret', 'secrets', 'credential', 'credentials', 'password', 'token', 'apikey',
  'rbac', 'permission', 'permissions', 'middleware', 'crypto', 'encrypt', 'decrypt',
]);

function sharedSurfaceToken(a, b) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  for (const t of ta) if (SURFACE_TOKENS.has(t) && tb.has(t)) return true;
  return false;
}

function sharesEvidence(failureNode, candidate) {
  if (sharedFiles(failureNode, candidate)) return true;
  if (sharedSurfaceToken(failureNode, candidate)) return true;
  return tokenOverlap(failureNode, candidate) >= 3;
}

function nearestFailureTarget(node, nodes) {
  const earlier = nodes.filter(
    (n) => n.status !== 'abandoned' && n.id !== node.id && afterFailure(node, n)
  );
  if (!earlier.length) return null;
  earlier.sort((a, b) => orderAfter(b, a));
  const semantic = earlier.find((n) => sharesEvidence(n, node));
  if (semantic) return { target: semantic, linkage: 'semantic' };
  if (node.parent && node.parent.status !== 'abandoned' && node.parent.id !== node.id && afterFailure(node, node.parent)) {
    return { target: node.parent, linkage: 'positional' };
  }
  return { target: earlier[0], linkage: 'positional' };
}

// Acceptance/confirmation cue: an explicit "looks good / that works / fixed" turn is a
// semantic resolution even when it shares no tokens or files with the failure.
const ACCEPTANCE_RE =
  /\b(?:that(?:'?s| is| works| fixed)|works now|looks? good|lgtm|perfect|great|nice|fixed|resolved|that did it|that worked|much better|exactly|correct now)\b/i;

function laterCandidates(nodes, failureNode, anchor, extraExcludeId) {
  return nodes
    .filter((n) => n.status !== 'abandoned' && n.id !== failureNode.id && afterFailure(n, anchor))
    .filter((n) => !extraExcludeId || n.id !== extraExcludeId)
    .sort(orderAfter);
}

function orderAfter(a, b) {
  const ta = tsOf(a);
  const tb = tsOf(b);
  if (ta !== null && tb !== null) return ta - tb;
  return (ordinalOf(a) ?? Infinity) - (ordinalOf(b) ?? Infinity);
}

// P2: only return a resolution when it actually ties back to the failure -- it shares
// evidence (file or token overlap) OR it is an explicit acceptance/confirmation turn.
// Otherwise return null. An honest null beats the temporally-nearest node, which is
// frequently just "the next thing that happened" and poisons eval candidates.
function nearestAcceptedAfter(nodes, failureNode, correctionNode) {
  const anchor = correctionNode || failureNode;
  const later = laterCandidates(nodes, failureNode, anchor, correctionNode?.id);
  if (!later.length) return null;
  const semantic = later.find((n) => sharesEvidence(failureNode, n));
  if (semantic) return semantic;
  const accepted = later.find((n) => ACCEPTANCE_RE.test(String(n.text || '')));
  return accepted || null;
}

// P2: only treat a later correction as the corrector when it semantically ties back to
// the failure (shared evidence). A correction that merely happened later, about something
// else, is not the corrector -- return null and let the signal stand uncorrected.
function nearestCorrectionAfter(nodes, failureNode) {
  const later = nodes
    .filter((n) => n.status !== 'abandoned' && n.kind === 'correction' && n.id !== failureNode.id && afterFailure(n, failureNode))
    .sort(orderAfter);
  if (!later.length) return null;
  return later.find((n) => sharesEvidence(failureNode, n)) || null;
}

// Co-signal lookup for P1: a later human turn that both carries security-correction
// phrasing and ties back to this node by shared evidence corroborates the signal.
function nearestSecurityCorrection(nodes, failureNode) {
  const later = nodes
    .filter(
      (n) =>
        n.status !== 'abandoned' &&
        n.id !== failureNode.id &&
        afterFailure(n, failureNode) &&
        hasSecurityCorrection(n.text)
    )
    .sort(orderAfter);
  return later.find((n) => sharesEvidence(failureNode, n)) || null;
}

function tierRank(tier) {
  return tier === 'verified' ? 4 : tier === 'high' ? 3 : tier === 'confirmed' ? 2 : 1;
}

function countTiers(failures) {
  const counts = { verified: 0, high: 0, confirmed: 0, inferred: 0 };
  for (const f of failures) if (counts[f.tier] !== undefined) counts[f.tier]++;
  return counts;
}

function summarizeFailure(type, failureNode, correctionNode) {
  const subject = truncate(failureNode?.title || 'a previous direction', 90);
  if (!correctionNode) {
    switch (type) {
      case 'security_or_privacy_risk':
        return `A privacy or security boundary was stated as a requirement at "${subject}".`;
      case 'scope_drift':
        return `A scope boundary was stated at "${subject}".`;
      case 'format_violation':
        return `A required output format was stated at "${subject}".`;
      default:
        return `A ${type.replace(/_/g, ' ')} concern was raised at "${subject}".`;
    }
  }
  const correction = truncate(correctionNode?.title || 'a later correction', 90);
  switch (type) {
    case 'ignored_constraint':
      return `A prior direction appears to have ignored a user constraint near "${subject}"; corrected by "${correction}".`;
    case 'scope_drift':
      return `The session drifted from the intended scope near "${subject}"; corrected by "${correction}".`;
    case 'overbuilt_solution':
      return `The work appears to have overbuilt the requested shape near "${subject}"; corrected by "${correction}".`;
    case 'underbuilt_solution':
      return `The work appears to have underbuilt or skipped expected scope near "${subject}"; corrected by "${correction}".`;
    case 'security_or_privacy_risk':
      return `A privacy or security boundary became important near "${subject}"; reinforced by "${correction}".`;
    case 'user_frustration':
      return `User frustration signaled that the prior path near "${subject}" was not meeting expectations.`;
    case 'repeated_failed_fix':
      return `A fix loop appears to have repeated near "${subject}"; corrected by "${correction}".`;
    default:
      return `A possible ${type.replace(/_/g, ' ')} occurred near "${subject}"; corrected by "${correction}".`;
  }
}

function lessonFor(type, { evidence = '', summary = '' } = {}) {
  const titles = {
    ignored_constraint: 'Preserve explicit constraints',
    misunderstood_goal: 'Re-check the actual goal',
    scope_drift: 'Keep scope boundaries durable',
    wrong_tool_choice: 'Choose tools from the repo context',
    hallucinated_file_or_api: 'Verify files and APIs before acting',
    repeated_failed_fix: 'Break repeated fix loops',
    overbuilt_solution: 'Avoid overbuilding beyond the requested shape',
    underbuilt_solution: 'Do not skip required scope',
    security_or_privacy_risk: 'Treat privacy boundaries as product requirements',
    dependency_or_environment_mismatch: 'Respect the local environment',
    format_violation: 'Preserve requested output formats',
    user_frustration: 'Escalate when user frustration appears',
    abandoned_path: 'Avoid abandoned paths unless explicitly revived',
    user_rejected_action: 'Confirm proposed actions before executing',
    tool_execution_failed: 'Validate tool inputs before executing',
    model_refused: 'Rephrase refused requests instead of repeating them',
    permission_denied: 'Pre-flight check filesystem and shell permissions',
  };
  const guidance = {
    ignored_constraint: 'Future agents should carry explicit user constraints forward as high-priority requirements.',
    misunderstood_goal: 'Future agents should restate and verify the goal before continuing after a correction.',
    scope_drift: 'Future agents should preserve the corrected scope and avoid adding unrequested product shape.',
    wrong_tool_choice: 'Future agents should prefer tools and dependencies already supported by the repo and environment.',
    hallucinated_file_or_api: 'Future agents should verify that referenced files, commands, and APIs exist before relying on them.',
    repeated_failed_fix: 'Future agents should stop and reassess after repeated failed fixes instead of applying another blind patch.',
    overbuilt_solution: 'Future agents should prefer the smallest implementation that satisfies the corrected product direction.',
    underbuilt_solution: 'Future agents should check that all explicitly requested behavior is represented before claiming completion.',
    security_or_privacy_risk: 'Future agents should not weaken local-first privacy, redaction, or no-network guarantees without explicit approval.',
    dependency_or_environment_mismatch: 'Future agents should validate environment assumptions before choosing dependencies or runtime paths.',
    format_violation: 'Future agents should preserve requested output formats exactly unless the user approves a change.',
    user_frustration: 'Future agents should treat frustration as a signal to slow down, verify assumptions, and correct course.',
    abandoned_path: 'Future agents should avoid resurrecting abandoned branches unless the user explicitly asks for them.',
    user_rejected_action: 'Future agents should not retry a tool action the user just declined without first explaining why the action is still worth taking.',
    tool_execution_failed: 'Future agents should validate command inputs and surface expected errors before running shell or write tools, instead of discovering failures after execution.',
    model_refused: 'Future agents should treat a refusal as a signal to rephrase or descope, not to retry the same request verbatim; if the user confirms the request is legitimate, surface the refusal reason.',
    permission_denied: 'Future agents should pre-flight check that required files, commands, or resources are accessible before attempting an action that needs them.',
  };
  const base = guidance[type] || 'Future agents should preserve this correction.';
  const concrete = String(evidence || summary || '').replace(/\s+/g, ' ').trim();
  return {
    title: titles[type] || 'Preserve the correction',
    text: concrete ? `${base} Specifically: ${truncate(concrete, 220)}` : base,
  };
}

function evalTypeFor(type) {
  if (type === 'security_or_privacy_risk') return 'privacy_boundary_preservation';
  if (type === 'scope_drift' || type === 'overbuilt_solution') return 'scope_drift_detection';
  if (type === 'ignored_constraint' || type === 'format_violation') return 'constraint_preservation';
  if (type === 'wrong_tool_choice' || type === 'dependency_or_environment_mismatch') return 'tool_choice_regression';
  if (type === 'abandoned_path') return 'correction_adherence';
  if (type === 'user_rejected_action' || type === 'permission_denied') return 'tool_permission_regression';
  if (type === 'tool_execution_failed') return 'tool_error_recovery';
  if (type === 'model_refused') return 'refusal_handling';
  return 'instruction_following_regression';
}

function evalTaskFor(type) {
  if (type === 'security_or_privacy_risk') return 'Continue development while preserving privacy and redaction boundaries.';
  if (type === 'scope_drift') return 'Continue development without drifting outside the corrected scope.';
  if (type === 'format_violation') return 'Continue development while preserving the requested output format.';
  if (type === 'user_rejected_action' || type === 'permission_denied') {
    return 'Continue development without re-attempting tool actions the user or environment has just rejected.';
  }
  if (type === 'tool_execution_failed') return 'Continue development while validating tool inputs before execution.';
  if (type === 'model_refused') return 'Continue development by rephrasing refused requests rather than repeating them.';
  return 'Continue development while preserving the corrected direction from the session lineage.';
}

function expectedBehaviorFor(type) {
  const common = ['Use the corrected prompt lineage as durable context', 'Do not repeat the documented failure mode'];
  if (type === 'security_or_privacy_risk') return ['Preserve local-first behavior', 'Do not add telemetry or uploads', 'Keep redaction fail-closed', ...common];
  if (type === 'scope_drift') return ['Stay inside the corrected scope', 'Do not add unrequested product surfaces', ...common];
  if (type === 'ignored_constraint') return ['Carry explicit user constraints forward', 'Check new work against those constraints', ...common];
  if (type === 'format_violation') return ['Preserve the requested format', 'Validate generated artifacts', ...common];
  return common;
}

function failureModeFor(type) {
  return `Agent repeats ${type.replace(/_/g, ' ')} despite prior correction.`;
}

function summarizeRejection(r, node) {
  const subject = truncate(node && node.title ? node.title : 'a previous turn', 90);
  switch (r.kind) {
    case 'user_declined_tool':
      return `The user declined a proposed tool action near "${subject}".`;
    case 'user_interrupt':
      return `The user interrupted the agent mid-response near "${subject}".`;
    case 'user_text_decline':
      return `The user explicitly told the agent to stop or not proceed near "${subject}".`;
    case 'tool_execution_error':
      return `A tool execution returned an error near "${subject}".`;
    case 'permission_denied':
      return `A tool action was denied by the environment (permission denied) near "${subject}".`;
    case 'model_refusal':
      return `The model refused to proceed near "${subject}".`;
    default:
      return `A ${r.kind || 'rejection'} was captured near "${subject}".`;
  }
}

function confidenceLabel(score) {
  if (score >= 0.8) return 'high';
  if (score >= 0.65) return 'medium';
  return 'low';
}

function countTypes(failures) {
  const counts = new Map();
  for (const failure of failures) counts.set(failure.type, (counts.get(failure.type) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => ({ type, count }));
}

function projectBlock(opts) {
  return {
    name: opts.projectName || null,
    generatedAt: opts.generatedAt || null,
  };
}

function quote(text) {
  return truncate(String(text || '').replace(/\s+/g, ' '), 240).replace(/"/g, '\\"');
}
