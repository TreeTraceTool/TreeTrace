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
  /\b(no|stop|scrap|revert|undo|roll ?back|rip (?:it|that|this) out|back (?:it|that) out|not that|not it|over[- ]?engineered|you forgot|you ignored|that's wrong|that is wrong|i said|instead|redo|re do|go back|wrong|doesn'?t work|didn'?t work|still (failing|broken|wrong|bad)|not what i (asked|wanted|meant))\b/i;
const FRUSTRATION_HINT =
  /\b(sucks|awful|god awful|what the heck|wtf|mad|angry|frustrat|not suffic|i don'?t trust|terrible|bad)\b/i;
// Strong, unambiguous frustration wording that warrants an inferred recall signal even
// without corroboration. Deliberately narrow to avoid false positives on mild negativity.
const STRONG_FRUSTRATION_RE =
  /\b(god awful|wtf|what the (?:heck|hell)|(?:so |really |this )?sucks|i(?:'m| am) (?:angry|frustrated|furious)|angry and frustrated|makes me (?:angry|mad|furious)|absolutely terrible|piece of (?:junk|garbage|trash|crap))\b/i;
// Types whose strong-signal form can emit uncorroborated (at inferred tier only).
const UNCORROBORATED_RECALL_TYPES = new Set(['user_frustration', 'scope_drift', 'overbuilt_solution']);
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
const SCOPE_DRIFT_HINT = /\b(don'?t add|do not add|not a web app|keep it local|too much|overbuilt|over[- ]?engineered|over[- ]?kill|scope drift|stay focused|same format|keep .* cli|zero-config cli|way more than|more than i (?:wanted|asked|need)|not a (?:platform|framework|service|product|web ?app|library|server)|a (?:script|function|cli|tool|one[- ]?liner) not|rip (?:it |that |the )?out|too (?:complex|complicated|heavy|big)|simpler than this)\b/i;
// STRUCTURAL surplus-removal detector for overbuild. Overbuild is structurally invariant:
// the agent adds N named components, then the user names an excess metaphor/quantifier AND demands
// removal of those named components. SURPLUS_CUE_RE matches the excess framing in a phrasing-general
// way (gold-plating / over-build / cannon-for-a-fly / wrench-not-a-workshop / trim it way down / way
// too much), so it generalizes past the old literal list. REMOVE_COMPONENTS_RE matches a removal
// imperative governing a named architectural component. The arm only fires when the removed
// component token ALSO appears in the immediately-prior assistant narration (a back-reference reusing
// the session._priorAssistant token snapshot), so a bare excess complaint with no real prior surplus
// never trips it. Anchoring on the SHARED named component (not the metaphor wording) is what keeps it
// precise across "cannon"/"wrench"/"gold-plating" and any future phrasing.
const SURPLUS_CUE_RE =
  /\bgold[- ]?plat(?:e|ed|ing)?\b|\bover[- ]?build|\bover[- ]?engineer|\bcannon for a (?:fly|mosquito)\b|\bwrench(?:,)? not a (?:workshop|factory)\b|\btrim (?:it|this) (?:way )?down\b|\bway too (?:much|heavy|big|complex)\b|\bmore than (?:i|we) (?:asked|wanted|needed)\b/i;
const REMOVE_COMPONENTS_RE =
  /\b(?:rip|ditch|drop|strip|tear|gut|remove|delete|cut)\b[^.]{0,60}\b(registry|middleware|daemon|plugin|panel|layer|engine|scheduler|system|framework|theme)\b/i;
const TOOL_HINT = /\b(wrong tool|wrong library|use .* instead|don'?t use|dependency|package|environment|node version|python version|missing module)\b/i;
const HALLUCINATION_HINT = /\b(hallucinat|doesn'?t exist|does not exist|no such file|fake file|fake api|made up)\b/i;
const REPEATED_FIX_HINT = /\b(still failing|still broken|still wrong|again|same error|didn'?t fix|doesn'?t fix|keeps? failing|redo)\b/i;
const UNDERBUILT_HINT = /\b(underbuilt|missing|not enough|too bare|incomplete|you skipped|you missed)\b/i;
// format_violation cue. Requires an actual format COMPLAINT ("the output format", "reformat",
// "malformed", "invalid json". Bare data-format names (json/csv/xml) are NOT cues: they match
// feature specs ("a CSV export flag", "output as json") and filenames ("slides.json"), not violations.
const FORMAT_HINT =
  /\b(?:format|reformat|malformed|same structure|exact output)\b|\binvalid (?:json|yaml|xml|format|output|structure|markup|schema)\b/i;
// misunderstood_goal must have explicit "wrong goal" evidence, not be a fallback label on any
// correction. Per TAXONOMY: the user restates the real goal after the agent pursued the wrong one.
const MISUNDERSTOOD_GOAL_RE =
  /\b(?:that'?s not what i (?:asked|wanted|meant)|not what i (?:asked|wanted|meant)|you (?:misunderstood|got it wrong|missed the point|misread|solved the wrong|optimi[sz]ed the wrong|chose the wrong)|i (?:wanted|meant|asked for|cared about)\b[^.]*\bnot\b|wrong (?:goal|thing|feature|approach|task|problem|axis|optimization|metric)|you built the wrong|that'?s the wrong)\b/i;
// A structural redirect that carries a HARD REVERSAL verb ("rip ... out", "nix", "scrap",
// "gut") is a decline/overbuild reversal, NOT a misunderstood-goal restatement. The misunderstood
// fallback is suppressed for those so an overbuild ("cannon for a fly, rip the registry out") does
// not mislabel as misunderstood_goal; it stays a decline (rejection) + chain instead.
const REVERSAL_VERB_RE = /\b(?:rip|nix|scrap|yank|gut|tear|strip|pull)\b[^.]{0,60}\bout\b|\b(?:nix|scrap|yank|gut)\b/i;

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
// Figurative use of destructive verbs ("broke my brain"), and explicit disclaimers that the
// damage was NOT the agent's doing. Either one means this is not a real abandoned/destructive path.
const FIGURATIVE_DESTRUCTIVE_RE = /\bbroke my (?:brain|heart|mind|spirit)\b|\bbroken (?:heart|record)\b|\bmind[- ]?blow/i;
const NOT_AGENT_DISCLAIMER_RE =
  /\bnot your (?:change|fault|code|edit|doing|problem)\b|\bpre-?existing\b|\bunrelated to your\b|\bnot (?:from|caused by|due to) your\b|\balready (?:broken|failing|broke) before\b|\bignore it\b/i;

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
const SECRET_CONTENT_RE = /(?:\bsource\s+[^\n]*\.env\b|(?:^|[;&|]|\s)\.\s+[^\n]*\.env\b|\.env\.(?:secrets|local|prod|production)\b|\bexport\s+[A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|API_KEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY)\b|\b(?:wrangler|doppler|vault)\b|\bgh\s+auth\b|\baws\s+configure\b|\bgcloud\s+auth\b|\bkubectl\s+config\s+set-credentials\b|\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA)[A-Z0-9]{12,}\b|\b(?:gh[opusr]|github_pat)[-_][A-Za-z0-9_]{16,}\b|\bsk-[A-Za-z0-9]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\b(?:aws_secret_access_key|aws_access_key_id|api[_-]?key|secret[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|client[_-]?secret|password|passwd|auth[_-]?token|access[_-]?token|bearer[_-]?token|connection[_-]?string)\b\s*[:=]\s*['"][^'"\n]{6,}['"])/i;
// Access-control RISK in content: granting broad DB rights, loosening file perms, OR exposing a
// resource publicly (public-read, world-readable, 0.0.0.0/0, wildcard principal).
const ACCESS_CONTROL_CONTENT_RE = /\b(?:grant\s+(?:select|insert|update|delete|all)\b|setfacl|chmod\s+[0-7]{3,4}\b|public[- ]?read(?:-write)?\b|world[- ]?readable\b|--acl[= ]public|0\.0\.0\.0\/0|publicly[- ]?(?:readable|accessible|writable)\b|"?principal"?\s*:\s*"?\*)/i;
const ACCESS_CONTROL_WEAK_RE = /\b(?:rbac|access[-_]?control)\b/i;

// Secret-by-VALUE detector. Fires on the credential VALUE itself by format/entropy,
// independent of surrounding quotes or filename. Two sub-rules:
//   (1) known-format vendor tokens anywhere in the content (stripe sk_live_/sk-, AWS AKIA...,
//       GitHub ghp_/github_pat, Slack xox.-, Google AIza..., PEM PRIVATE KEY block,
//       service-account JSON shape). SECRET_CONTENT_RE already covers a subset of these; this
//       widens to stripe/google/PEM/SA-JSON that previously required a quoted RHS.
//   (2) a BARE or quoted key=value / key: value where the key token is a credential noun and the
//       value is a long, high-entropy literal, recovering unquoted YAML/env secrets such as
//       POSTGRES_PASSWORD: hunter2-prod-Sup3r. Gated by a Shannon-entropy floor + a
//       placeholder/example excluder to hold precision.
const VENDOR_TOKEN_RE =
  /\bsk_live_[A-Za-z0-9]{16,}\b|\bsk-[A-Za-z0-9]{16,}\b|\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA)[A-Z0-9]{12,}\b|\b(?:gh[opusr]|github_pat)[-_][A-Za-z0-9_]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|-----BEGIN(?:\s+[A-Z]+)?\s+PRIVATE KEY-----|"type"\s*:\s*"service_account"[\s\S]{0,400}?"private_key"\s*:/;
// Credential-noun KEY followed by a bare or quoted VALUE. Bare value runs to end-of-line/quote/space.
// Key may carry a prefix segment (POSTGRES_PASSWORD, DB_API_KEY, MY-SECRET) so match the
// credential noun as the trailing token of a [A-Za-z0-9_-]* identifier, then : or =.
const SECRET_KV_RE =
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9-]+[_-])?(?:password|passwd|secret(?:[_-]?key)?|api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|auth[_-]?token|access[_-]?token|bearer[_-]?token|private[_-]?key|client[_-]?secret|token)\s*[:=]\s*(['"]?)([^'"\n\r]{8,})\1/i;
// Placeholder / example values that must NOT count as a real leaked secret.
const SECRET_PLACEHOLDER_RE =
  /^(?:<[^>]*>|\{\{?[^}]*\}?\}|\$\{?[A-Za-z0-9_]+\}?|changeme|change_me|your[_-]?\w*|example|placeholder|redacted|todo|none|null|true|false|xxx+|\*{3,}|\.{3,}|secret|password|token|key|test|dummy|sample|foobar)$/i;

// Match the redactor's own [REDACTED:<ruleId>] sentinels for credential-format /
// vendor and secret-noun rules ONLY. Soft-PII rules (email, ipv4, home-dir-username) are
// intentionally excluded so redacted soft-PII does not get promoted to a leaked credential.
// This makes credential detection survive the redact-before-analyze ordering: a body whose
// secret was already replaced by a sentinel still classifies as a secret-by-value.
const REDACTED_SECRET_RE =
  /\[REDACTED:(?:private-key-block|aws-access-key|github-token|github-fine-grained|gitlab-token|anthropic-key|openai-key|slack-token|stripe-live-key|npm-token|tailscale-key|google-api-key|sendgrid-key|twilio-key|telegram-bot-token|discord-webhook|jwt|hex-token|wireguard-key|url-basic-auth|bearer-header|secret-assignment)\]/;

function shannonEntropy(str) {
  if (!str) return 0;
  const freq = Object.create(null);
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let h = 0;
  const n = str.length;
  for (const k in freq) {
    const p = freq[k] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// Returns true when the body carries a credential by its intrinsic VALUE (format or entropy),
// regardless of quoting or filename. Independent of SECRET_CONTENT_RE so unquoted YAML/env and
// known-format vendor tokens are recovered without loosening the quoted-only legacy rule.
function isSecretByValue(body) {
  if (typeof body !== 'string' || !body) return false;
  if (REDACTED_SECRET_RE.test(body)) return true;
  if (VENDOR_TOKEN_RE.test(body)) return true;
  const m = SECRET_KV_RE.exec(body);
  if (m) {
    const value = m[2].trim();
    if (
      value.length >= 8 &&
      !SECRET_PLACEHOLDER_RE.test(value) &&
      // Reject obvious non-secret values (env-var refs, pure words) and require enough
      // character diversity for a real credential. Entropy floor of 2.5 bits/char admits
      // mixed alnum secrets like hunter2-prod-Sup3r while rejecting low-variety words.
      shannonEntropy(value) >= 2.5 &&
      /[A-Za-z]/.test(value) &&
      /[0-9!@#$%^&*\-_]/.test(value)
    ) {
      return true;
    }
  }
  return false;
}

// Config-surface secret detector. SECRET_KV_RE only fires when the KEY token is a credential
// noun; a Terraform/values/env assignment keyed by a GENERIC token ('default = "Prod-Master-Pw..."'
// in tf/variables.tf) carries the secret in the VALUE but the noun rule can never reach it.
// This recovers such cases by gating ENTIRELY on the FILE being a config/secrets/deployment/ci
// surface (classifySecuritySurface + a tfvars/.env/configmap/compose/values-class co-gate) and the
// RHS being a long high-entropy literal, with shape excluders for pure-hex digests and base64
// image/data blobs and a separator-or-casemix requirement, so a benign hex hash or data URI in a
// deploy file does not trip it.
const CONFIG_SURFACE_PATH_RE =
  /(?:^|[\\/])(?:[^\\/]*\.(?:tfvars?|env[^\\/]*)|[^\\/]*\.env|[^\\/]*configmap[^\\/]*\.ya?ml|docker-compose[^\\/]*\.ya?ml|compose[^\\/]*\.ya?ml|[^\\/]*values\.ya?ml|values-[^\\/]*\.ya?ml|[^\\/]*\.tf)$/i;
// Generic key:value or key="value" with a long literal RHS (key need NOT be a credential noun).
const CONFIG_KV_RE =
  /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(['"]?)([^'"\n\r]{12,})\2/;
const HEX_DIGEST_RE = /^[0-9a-fA-F]{32,}$/;
const B64_BLOB_RE = /^[A-Za-z0-9+/]{44,}={0,2}$/;
function isConfigSurfaceSecret(body, file) {
  if (typeof body !== 'string' || !body || !file) return false;
  const surface = classifySecuritySurface(file);
  if (!(surface === 'secrets' || surface === 'deployment' || surface === 'ci')) return false;
  if (!CONFIG_SURFACE_PATH_RE.test(file)) return false;
  const m = CONFIG_KV_RE.exec(body);
  if (!m) return false;
  const value = m[3].trim();
  if (value.length < 12) return false;
  if (SECRET_PLACEHOLDER_RE.test(value)) return false;
  // Shape excluders: a pure hex digest (>=32) or an unbroken base64 image/data blob (>=44) is not a
  // password; reject before the entropy/diversity test so a long hash in a deploy file does not fire.
  if (HEX_DIGEST_RE.test(value)) return false;
  if (B64_BLOB_RE.test(value)) return false;
  if (shannonEntropy(value) < 3.0) return false;
  // Separator-or-casemix: a real config secret has either an internal separator (-, _, ., etc.) OR
  // mixed upper/lower case. A single-case unbroken word at this length is more likely an identifier.
  const hasSeparator = /[-_.:/+!@#$%^&*]/.test(value);
  const hasCaseMix = /[a-z]/.test(value) && /[A-Z]/.test(value);
  if (!hasSeparator && !hasCaseMix) return false;
  return true;
}

// Structural public-exposure detector. Generalizes the access-control content
// rule beyond a fixed keyword list to unseen cloud/IaC dialects, without loosening
// precision: it ONLY fires on a value that is concretely public/wildcard. Recognizes
//   * world-open CIDRs: 0.0.0.0/0 and ::/0
//   * permission-shaped key:value / key=value where the key is an ACL/visibility/access
//     concept and the RHS is a public/wildcard value (*, public, anyone, everyone,
//     allUsers, allAuthenticatedUsers, 0.0.0.0); non-public values (private, internal)
//     are rejected
//   * chmod with an octal whose WORLD (others) digit >= 4 (world-readable or worse)
//   * SQL GRANT ... TO PUBLIC / TO *
const PUBLIC_CIDR_RE = /\b0\.0\.0\.0\/0\b|::\/0/;
const PUBLIC_ACL_PAIR_RE =
  /\b(?:acl|visibility|public|access|principal|allow|ingress)\b\s*[:=]\s*['"]?\s*(?:\*|(?:public|anyone|everyone|allusers|allauthenticatedusers|0\.0\.0\.0)\b)/i;
const GRANT_TO_PUBLIC_RE = /\bgrant\b[^;]{0,120}?\bto\s+(?:public\b|\*)/i;

function chmodWorldExposed(body) {
  const re = /\bchmod\s+(?:-[a-zA-Z]+\s+)*0?([0-7])([0-7])([0-7])\b/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (Number(m[3]) >= 4) return true;
  }
  return false;
}

function isPublicExposure(body) {
  if (typeof body !== 'string' || !body) return false;
  if (PUBLIC_CIDR_RE.test(body)) return true;
  if (PUBLIC_ACL_PAIR_RE.test(body)) return true;
  if (chmodWorldExposed(body)) return true;
  if (GRANT_TO_PUBLIC_RE.test(body)) return true;
  return false;
}

// Structural safety-gate weakening. Fires when a security/transport protection
// flag is flipped OFF (secure:false, httpOnly:false, verify=False, rejectUnauthorized:false,
// strict:false, csrf:false, sslVerify=false, ...) or a protective guard line is commented
// out (// require_auth, # check_permission, ...). This is a WEAK signal by contract: it only
// escapes `inferred` when a real co-signal is present (security-surface file, credential
// content, or a human security correction), preserving the precision contract.
const SAFETY_FLAG_OFF_RE =
  /\b(secure|http[-_]?only|verify|verify[-_]?ssl|ssl[-_]?verify|reject[-_]?unauthorized|strict|strict[-_]?ssl|csrf|csrf[-_]?protection|check[-_]?hostname|validate[-_]?certs?|tls[-_]?verify|cert[-_]?verify|require[-_]?auth|auth[-_]?required|enforce[-_]?https|signature[-_]?verification)\b\s*[:=]\s*(?:false|0|off|no|none|disabled)\b/i;
const GUARD_COMMENTED_OUT_RE =
  /(?:\/\/|#|--|<!--)\s*(?:require[-_]?auth|auth[-_]?required|check[-_]?permission|check[-_]?auth|verify[-_]?token|csrf[-_]?protect\w*|authorize|authenticate|ensure[-_]?(?:auth|admin|login)|is[-_]?authenticated|login[-_]?required|permission[-_]?required|guard|enforce[-_]?https|validate[-_]?(?:token|session|cert))\b/i;

function isSafetyGateWeakening(body) {
  if (typeof body !== 'string' || !body) return false;
  if (SAFETY_FLAG_OFF_RE.test(body)) return true;
  if (GUARD_COMMENTED_OUT_RE.test(body)) return true;
  return false;
}

// Concept-level credential-mishandling detector. Fires on the SENTENCE-SCOPED
// co-occurrence of a credential noun-class token AND a sink/exposure verb-class token, with a
// remediation-clause exclusion (remove/redact/mask/scrub/rotate/revoke) to honor EXACTLY-ONE-
// per-concern. Scans the assistant narration (a.narration, captured in parse.js) joined with the
// action body, so a leak described in prose ("I'll log the full Authorization header with the
// bearer token") is caught even when the action input carries no secret-shaped literal.
const CREDENTIAL_NOUN_RE =
  /\b(?:password|passwd|bearer(?:\s+token)?|api[\s-]?key|access[\s-]?token|signing[\s-]?token|signing[\s-]?key|secret(?:\s+key)?|secrets?|credential|credentials|service[\s-]?account(?:\s+json)?|sa[\s-]?key|authorization(?:\s+header)?|auth[\s-]?token|private[\s-]?key|connection[\s-]?string|client[\s-]?secret|access[\s-]?key|token)\b/i;
const CREDENTIAL_SINK_VERB_RE =
  /\b(?:log(?:s|ged|ging)?|print(?:s|ed|ing)?|echo(?:ed|ing)?|dump(?:s|ed|ing)?|console\.log|fmt\.Print\w*|System\.out|commit(?:s|ted|ting)?|push(?:es|ed|ing)?|expose(?:s|d)?|exposing|output(?:s|ted|ting)?|writ(?:e|es|ing|ten)\s+(?:to|into)\s+(?:the\s+)?log)\b/i;
// Remediation clause: when the sentence is about REMOVING/redacting the exposure, it is the fix,
// not the leak -> suppress (the redirect that fixes a leak should not itself mint a new finding).
const CREDENTIAL_REMEDIATION_RE =
  /\b(?:remov(?:e|es|ed|ing)|redact(?:s|ed|ing)?|mask(?:s|ed|ing)?|scrub(?:s|bed|bing)?|rotat(?:e|es|ed|ing)|revok(?:e|es|ed|ing)|strip(?:s|ped|ping)?|sanitiz(?:e|es|ed|ing)|fingerprint|last[\s-]?four|last-?4)\b/i;

// Split a body into rough sentence/clause units so credential-noun + sink-verb must co-occur
// WITHIN one clause, not merely somewhere in the turn (sentence-scoped precision).
function clauseSplit(body) {
  return String(body || '').split(/[.!?;\n]+/);
}

// Returns the matching clause when the action narration+body exposes a credential via a
// sink verb (and is not a remediation clause), else null.
function credentialMishandlingClause(body) {
  if (typeof body !== 'string' || !body) return null;
  for (const clause of clauseSplit(body)) {
    if (!CREDENTIAL_NOUN_RE.test(clause)) continue;
    if (!CREDENTIAL_SINK_VERB_RE.test(clause)) continue;
    if (CREDENTIAL_REMEDIATION_RE.test(clause)) continue;
    return clause.replace(/\s+/g, ' ').trim();
  }
  return null;
}

function isCredentialFile(file) {
  if (!file || !SECURITY_FILE_RE.test(file)) return false;
  if (SECURITY_FILE_EXCLUDE_RE.test(file)) return false;
  return true;
}

// Derive a stable distinct-concern key from the strongest security feature's target file
// (normalized case + path separators). The taxonomy contract is "a file touched in N turns is ONE
// risk, not N." Returns null when there is no concrete credential/access-control file to key on
// (stated-intent and human-correction backstops carry no file target) -> those ALWAYS emit, so the
// dedup never suppresses a distinct concern or a backstop. Precision-only.
function securityConcernKey(secActs) {
  if (!Array.isArray(secActs) || !secActs.length) return null;
  // Prefer a strong, file-anchored feature (credential filename / file kind), then any action file.
  const strong = secActs.filter((s) => s.strong);
  const pick = (list) => {
    for (const s of list) {
      const f = s.action && s.action.file;
      if (f && (isCredentialFile(f) || classifySecuritySurface(f))) return f;
    }
    return null;
  };
  const file = pick(strong) || pick(secActs);
  if (!file) return null;
  return String(file).toLowerCase().replace(/\\/g, '/').replace(/\/+/g, '/');
}

// Extract a DISTINCTIVE credential identifier from a file-less security finding's evidence so
// two turns about the same credential collapse into one concern. Returns the first distinctive stem
// found (jwt / signing-secret / api-key / password / bearer / private-key), or null. NEVER returns a
// bare 'secret'/'token' (too generic, unrelated secrets must not collapse). The match scans the
// joined evidence/clause text of every security action on the finding.
const CRED_STEM_RULES = [
  { stem: 'private-key', re: /\bprivate[\s_-]?key\b/i },
  { stem: 'signing-secret', re: /\bsigning[\s_-]?(?:secret|key)\b/i },
  { stem: 'jwt', re: /\bjwt\b/i },
  { stem: 'api-key', re: /\bapi[\s_-]?key\b/i },
  { stem: 'bearer', re: /\bbearer\b/i },
  { stem: 'password', re: /\b(?:password|passwd)\b/i },
];
function credentialStemKey(secActs) {
  if (!Array.isArray(secActs) || !secActs.length) return null;
  let text = '';
  for (const s of secActs) {
    text += ` ${s.evidence || ''}`;
    if (s.action) text += ` ${s.action.command || ''} ${s.action.input || ''}`;
  }
  if (!text.trim()) return null;
  for (const rule of CRED_STEM_RULES) {
    if (rule.re.test(text)) return rule.stem;
  }
  return null;
}

// STATED-INTENT BACKSTOP from the assistant's OWN narration. SECURITY_INTENT_RE only scans
// node.text; an agent that NARRATES a governance/security-touching action ("I rewrote LICENSE to
// an all-rights-reserved proprietary license") slips past it because the relicense phrasing is not
// in the user-intent vocabulary. This scans the assistant narration (a.narration) AND node.text
// for an intent verb/phrase co-occurring IN ONE CLAUSE with a target-noun the action actually
// touched (a classified security surface, or a file basename present in the action). The
// credential-remediation exclusion is honored (a redact/rotate clause is the fix, not the risk),
// and it is gated on the node NOT being its own refusal (handled by the call site).
const NARRATED_SECURITY_INTENT_RE =
  /\b(?:re-?licens(?:e|ed|ing)|rewrote|rewrite|all[\s-]?rights[\s-]?reserved|proprietary[\s-]?licens\w*|strip(?:s|ped|ping)?|disabl(?:e|ed|ing)|remov(?:e|ed|ing)|delet(?:e|ed|ing)|leak(?:s|ed|ing)?|expos(?:e|ed|ing)|bypass(?:es|ed|ing)?)\b/i;
const NARRATED_SECURITY_TARGET_RE =
  /\b(?:licens\w*|authentication|authorization|auth(?:[\s-]?(?:check|flow|token|guard))|secret\w*|credential\w*|access[\s-]?control|permissions?|rbac|admin (?:schema|mutations?|routes?)|(?:unit|integration|e2e|smoke|auth)?\s*tests?\b)\b/i;
// A clause is only a stated-intent risk when intent verb + target co-occur AND it is not a
// remediation clause (removing/redacting/rotating IS the fix). Returns the matching clause or null.
function narratedSecurityIntentClause(body) {
  if (typeof body !== 'string' || !body) return null;
  for (const clause of clauseSplit(body)) {
    if (!NARRATED_SECURITY_INTENT_RE.test(clause)) continue;
    if (!NARRATED_SECURITY_TARGET_RE.test(clause)) continue;
    if (CREDENTIAL_REMEDIATION_RE.test(clause)) continue;
    return clause.replace(/\s+/g, ' ').trim();
  }
  return null;
}
// Scan the node's own narration sources: each action narration plus the node text (assistant prose
// with no tool action lands in node.text). Returns the first matching clause or null. node.text is
// scanned ONLY when the node is NOT a user complaint/correction turn: a user "stop printing the
// secret -- that's a leak" already mints (and dedups) the credential concern elsewhere, so scanning
// its text here would double-fire the same concern. A genuine narrated intent is the ASSISTANT
// DESCRIBING what it did/will do (no decline/security-correction rejection on the node).
const SECURITY_CORRECTION_KINDS = new Set(['user_text_decline', 'user_declined_tool', 'user_interrupt']);
function narratedSecurityIntent(node) {
  if (!node) return null;
  for (const a of node.actions || []) {
    const clause = narratedSecurityIntentClause(String(a.narration || ''));
    if (clause) return clause;
  }
  const isUserComplaint =
    (Array.isArray(node.rejections) &&
      node.rejections.some((r) => SECURITY_CORRECTION_KINDS.has(r.kind))) ||
    hasSecurityCorrection(node.text);
  if (!isUserComplaint && typeof node.text === 'string' && node.text.length <= 1200) {
    const clause = narratedSecurityIntentClause(node.text);
    if (clause) return clause;
  }
  return null;
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
  /\b(?:don'?t|do not|never)\b[^.]{0,30}\b(?:leak|expose|commit|hardcode|hard[- ]?code|push|publish|paste|embed|inline|bake|put|write|store|save)\b[^.]{0,30}\b(?:secret|secrets|token|tokens|key|keys|credential|credentials|password|passwords|env|api)\b|\b(?:rotate|revoke|regenerate|invalidate)\b[^.]{0,25}\b(?:that|the|this|those|your|my)?\s*(?:secret|token|key|credential|password|pat|api[- ]?key|access token)\b|\bthat'?s? (?:a|the|my|our) (?:secret|credential|api[- ]?key|token|password)\b|\b(?:revert|undo|roll ?back)\b[^.]{0,25}\b(?:the|that|those)?\s*(?:auth|security|permission|access[- ]?control|rbac|credential)\b|\b(?:you|it)\b[^.]{0,20}\b(?:leaked|exposed|hardcoded|hard[- ]?coded|committed)\b[^.]{0,25}\b(?:secret|token|key|credential|password|env)\b|\b(?:don'?t|do not|never)\b[^.]{0,30}\b(?:make|leave|set|keep|expose|open)\b[^.]{0,25}\b(?:public|world[- ]?readable|publicly|wide[- ]?open|accessible to (?:everyone|all|the (?:public|world)))\b|\block (?:it|this|that|the bucket|things?) down\b/i;

function hasSecurityCorrection(text) {
  return typeof text === 'string' && text.length <= 4000 && SECURITY_CORRECTION_RE.test(text);
}

// A CONCRETE tool/action redirect remedy in a decline turn -- "use the Edit tool instead",
// "use Write rather than echo", "switch to the Read tool". The decline that names such a remedy KEEPS
// the boilerplate "do not retry a declined action" lesson because the lesson's instruction (retry via
// a different tool/action) is exactly what the human asked for. A domain correction (env-var name, a
// single CLI flag, a value change) does NOT match -- its remedy is content, not a tool-retry redirect.
const TOOL_ACTION_REDIRECT_RE =
  /\buse\b[^.]{0,30}\b(?:the\s+)?(?:Edit|Write|Read|Bash|Glob|Grep|NotebookEdit|MultiEdit|Task|Search|Replace|Apply\s*Patch|Patch|str_replace\w*|apply_patch)\b(?:\s+(?:tool|command|function|action))?[^.]{0,40}\b(?:instead|rather than|not\b)|\b(?:instead of|rather than)\b[^.]{0,30}\buse\b[^.]{0,30}\b(?:the\s+)?(?:Edit|Write|Read|Bash|Glob|Grep|NotebookEdit|MultiEdit|Task|Search|Replace|Apply\s*Patch|Patch)\b|\bswitch to\b[^.]{0,20}\b(?:the\s+)?(?:Edit|Write|Read|Bash|Glob|Grep|NotebookEdit|MultiEdit|Task)\b(?:\s+(?:tool|command|action))?/i;
function hasToolActionRedirectRemedy(text) {
  return typeof text === 'string' && text.length <= 4000 && TOOL_ACTION_REDIRECT_RE.test(text);
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
  // Scan the assistant narration joined with each action body for a sentence-scoped
  // credential-noun + sink-verb co-occurrence. Emit kind:'credential-mishandling' at most ONCE
  // per node (EXACTLY-ONE-per-concern), carrying the matching clause as audit evidence so the
  // relevant keywords (token/authorization/log) surface.
  let credMishandle = null;
  for (const a of node.actions || []) {
    const scan = `${a.narration || ''} ${a.command || ''} ${a.input || ''}`;
    const clause = credentialMishandlingClause(scan);
    if (clause) { credMishandle = { action: a, clause }; break; }
  }
  if (credMishandle) {
    out.push({
      action: credMishandle.action,
      kind: 'credential-mishandling',
      strong: true,
      evidence: credMishandle.clause,
    });
  }
  for (const a of node.actions || []) {
    const body = `${a.command || ''} ${a.input || ''}`;
    const kinds = [];
    if (SECRET_CONTENT_RE.test(body) || isSecretByValue(body) || isConfigSurfaceSecret(body, a.file)) kinds.push({ kind: 'credential', strong: true });
    if (a.file && isCredentialFile(a.file)) kinds.push({ kind: 'file', strong: true });
    // Structural public-exposure detector OR-ed with the legacy regex fallback
    // (the regex is kept so existing narrative TPs do not regress).
    if (isPublicExposure(body) || ACCESS_CONTROL_CONTENT_RE.test(body)) {
      kinds.push({ kind: 'access-control', strong: true });
    }
    if (a.command && RISKY_CMD_RE.test(a.command)) kinds.push({ kind: 'risky-command', strong: false });
    // Weak keyword: only counts when no strong access-control content already fired on this action.
    if (ACCESS_CONTROL_WEAK_RE.test(body) && !kinds.some((k) => k.kind === 'access-control')) {
      kinds.push({ kind: 'access-control', strong: false, weak: true });
    }
    // Structural safety-gate weakening is its own WEAK kind, separate from
    // access-control (they coexist). Weak by contract: only escapes `inferred` when a
    // real co-signal (surface file / credential content / human security correction)
    // is present, via the P4 co-signal gate in scoreSecurity.
    if (isSafetyGateWeakening(body)) {
      kinds.push({ kind: 'safety-gate-weakening', strong: false, weak: true });
    }
    for (const k of kinds) out.push({ action: a, ...k });
  }
  return out;
}

// A CONTENT-ANCHORED security risk is one carrying real risk CONTENT (a credential value, a
// credential-mishandling clause, access-control content, or a safety-gate weakening) -- as opposed
// to a mere security-NAMED file (kind 'file') or a bare risky command. Used to track whether the
// session has already established a content-anchored risk for the corroboration gate.
const CONTENT_ANCHORED_KINDS = new Set([
  'credential', 'credential-mishandling', 'access-control', 'safety-gate-weakening',
]);
function isContentAnchoredSecurity(secActs) {
  return Array.isArray(secActs) && secActs.some((s) => CONTENT_ANCHORED_KINDS.has(s.kind));
}
// A finding whose ONLY security signals are a security-NAMED file and/or a bare risky command
// (no credential/access-control/safety-gate content). These are the lone-signal named-file findings
// the gate suppresses once a content-anchored risk (or strong human correction) has already fired.
function isNamedFileOrRiskyOnly(secActs) {
  if (!Array.isArray(secActs) || !secActs.length) return false;
  return secActs.every((s) => s.kind === 'file' || s.kind === 'risky-command');
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
  if (strongActs.some((s) => s.kind === 'credential-mishandling')) signals.push('credential mishandling');
  if (strongActs.some((s) => s.kind === 'file')) signals.push('credential filename');
  if (strongActs.some((s) => s.kind === 'access-control')) signals.push('access-control command');
  if (weakActs.some((s) => s.kind === 'risky-command')) signals.push('risky command');
  if (weakActs.some((s) => s.weak && s.kind === 'safety-gate-weakening')) signals.push('safety-gate weakening');
  if (weakActs.some((s) => s.weak && s.kind !== 'safety-gate-weakening')) signals.push('access-control keyword');
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

// Structural destructive-data-op detector. Fires abandoned_path when a destructive VERB
// co-occurs with a persistent-DATA NOUN in the action body OR node.text, gated by a MANDATORY
// in-turn recovery/decline cue (restore/recover/undo/revert/rollback/non-destructive) plus the
// figurative + not-agent + future-intent + historical disclaimers. The recovery-cue requirement
// suppresses a future-intent "I'll drop the legacy table" and a historical "we nuked
// the old API ages ago"; the data-noun anchor suppresses "API" (not a data noun).
const DESTRUCTIVE_DATA_VERB_RE =
  /\b(?:drop(?:s|ped|ping)?|truncat(?:e|es|ed|ing)|delete[sd]?\s+from|wip(?:e|es|ed|ing)|blew\s+away|blow\s+away|overwrote|overwritten|overwrit(?:e|es|ing)|reset\s+--hard|recreate[sd]?\s+from\s+scratch|nuk(?:e|es|ed|ing)|\brm\b)\b/i;
const PERSISTENT_DATA_NOUN_RE =
  /\b(?:seed[s]?|fixtures?|migrations?|tables?|schema|database|\bdb\b|volume[s]?)\b/i;
// Mandatory in-turn cue that this is a real destructive-then-recover / decline, not a plan.
const DATA_RECOVERY_CUE_RE =
  /\b(?:restore[sd]?|restoring|recover(?:s|ed|ing)?|undo|revert(?:s|ed|ing)?|roll\s?back|non[\s-]?destructive|get\s+(?:it|them|those)\s+back|bring\s+(?:it|them)\s+back|put\s+(?:it|them)\s+back|re[\s-]?seed)\b/i;
// Future-intent ("I'll drop ...", "going to drop ...", "let me drop ...") is a plan, not damage.
const FUTURE_INTENT_RE =
  /\b(?:i'?ll|i\s+will|i'?m\s+going\s+to|gonna|going\s+to|let\s+me|we'?ll|we\s+will|should\s+i|plan\s+to|next\s+i'?ll)\b/i;
// Historical disclaimer ("we nuked the old API ages ago", "long ago", "previously").
const HISTORICAL_DESTRUCTIVE_RE =
  /\b(?:ages\s+ago|long\s+ago|years?\s+ago|back\s+then|in\s+the\s+past|already\s+(?:gone|removed|dropped)|historically)\b/i;

function isDestructiveDataOp(node) {
  const text = String(node.text || '');
  const body = (node.actions || []).map((a) => `${a.narration || ''} ${a.command || ''} ${a.input || ''}`).join(' ');
  const scan = `${text} ${body}`;
  if (scan.length > WORDING_SCAN_MAX_CHARS * 2) return null;
  if (!DESTRUCTIVE_DATA_VERB_RE.test(scan)) return null;
  if (!PERSISTENT_DATA_NOUN_RE.test(scan)) return null;
  // Mandatory recovery/decline cue gate.
  if (!DATA_RECOVERY_CUE_RE.test(scan)) return null;
  // Suppress figurative, not-agent, future-intent, and historical distractors.
  if (FIGURATIVE_DESTRUCTIVE_RE.test(scan) || NOT_AGENT_DISCLAIMER_RE.test(scan)) return null;
  if (HISTORICAL_DESTRUCTIVE_RE.test(scan)) return null;
  // Future-intent only suppresses when there is no actual destructive-recover report (a real
  // "you blew away my seed data, restore it" carries a past-tense destructive verb + a recovery
  // demand and is not a plan). Gate on the destructive clause being non-future.
  const destClause = clauseSplit(scan).find((c) => DESTRUCTIVE_DATA_VERB_RE.test(c) && PERSISTENT_DATA_NOUN_RE.test(c));
  if (destClause && FUTURE_INTENT_RE.test(destClause) && !DATA_RECOVERY_CUE_RE.test(destClause)) return null;
  return {
    confidence: 0.9,
    tier: 'verified',
    // Front-load the additive/seed remedy so the derived lesson matches the planted
    // additive-migrations lesson (mustMention additive/seed).
    summary: 'Persistent data (seed/fixtures/migration) was destructively wiped and had to be restored; make migrations additive and preserve seed data.',
  };
}

// Structural abandoned-BRANCH detector. Per TAXONOMY abandoned_path is "a DAG branch the
// user navigated away from" -- not only destructive-then-recover. When a correction/decline turn
// REVERSES a concrete approach the immediately-prior assistant turn introduced in its narration
// (a named data structure / algorithm / component, e.g. "custom trie for prefix matching"), the
// prior approach is an abandoned branch. We anchor the evidence to the prior approach noun so the
// match keywords (e.g. trie/prefix) surface, and we gate hard on a SHARED DISTINCTIVE NOUN
// between the reversal turn and the prior narration so this never fires on a generic correction.
//
// Reversal-of-approach cue on the correction turn ("nix the trie", "not go down that road",
// "wrong direction", "switch to ... instead", "scrap that approach"). Distinct from a plain
// content edit: it must name a navigate-away, not "fix the typo".
const APPROACH_REVERSAL_RE =
  /\b(?:nix|scrap|ditch|drop|abandon|back\s+out|rip\s+(?:it|that|this)\s+out|don'?t\s+go\s+(?:down|with)|not\s+go\s+down|wrong\s+(?:direction|approach|road|track)|back\s+up|wrong\s+way|go\s+(?:a\s+)?different\s+(?:way|direction|route)|switch\s+to|use\s+.{0,40}\binstead\b|instead\s+of|rather\s+than|let'?s\s+not\b|reverse\b|revert(?:ing)?\b)\b/i;
// The prior assistant turn must have INTRODUCED an approach (a concrete noun governed by an
// approach indicator), so a bland prior turn cannot anchor an abandoned branch.
const APPROACH_INTRODUCE_RE =
  /\b(?:custom|use\s+(?:a|an|the)|back(?:ed|ing)?\s+(?:it|the\s+\w+)?\s*with|switch(?:ed|ing)?\s+to|go\s+with|implement(?:ing)?\s+(?:a|an|the)|build(?:ing)?\s+(?:a|an|the)|approach|registry|optimizer|index|trie|parser|scheduler|pipeline|cache|engine|adapter|strategy|algorithm|structure)\b/i;

// Distinctive content nouns shared by both sides (>=4 chars, not a stopword, alpha-led). Excludes
// the reversal verbs themselves so "revert"/"switch" cannot self-match.
const REVERSAL_VERB_TOKENS = new Set([
  'nix', 'scrap', 'ditch', 'drop', 'abandon', 'back', 'out', 'wrong', 'direction', 'approach',
  'road', 'track', 'instead', 'rather', 'switch', 'reverse', 'revert', 'reverting', 'different',
  'route', 'way', 'down', 'with', 'use', 'using', 'lets', 'just', 'hold', 'shape', 'right',
]);
function approachTokens(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []) {
    if (STOPWORDS.has(w) || REVERSAL_VERB_TOKENS.has(w)) continue;
    out.add(w);
  }
  return out;
}

function abandonedBranch(node, priorNode) {
  if (!priorNode) return null;
  const text = String(node.text || '');
  if (!text || text.length > WORDING_SCAN_MAX_CHARS) return null;
  // (1) this turn is a correction/decline (rides on the structural redirect classification).
  const isCorrection =
    node.kind === 'correction' ||
    (Array.isArray(node.rejections) && node.rejections.some((r) => r.kind === 'user_text_decline'));
  if (!isCorrection) return null;
  // Figurative / not-the-agent disclaimers are never an abandoned branch.
  if (FIGURATIVE_DESTRUCTIVE_RE.test(text) || NOT_AGENT_DISCLAIMER_RE.test(text)) return null;
  // A scope-cut / overbuild complaint ("over-engineered", "I asked for one function, not a
  // framework") is scope_drift, NOT an approach navigate-away: the user is removing surplus, not
  // swapping a concrete approach for another. Suppress so this stays in its own class.
  if (SCOPE_DRIFT_HINT.test(text)) return null;
  // (2) the turn must REVERSE an approach (navigate away), not merely edit content.
  if (!APPROACH_REVERSAL_RE.test(text)) return null;
  // (3) the immediately-prior turn must have INTRODUCED a concrete approach in its narration.
  const priorNarration = (priorNode.actions || [])
    .map((a) => a.narration || '')
    .filter(Boolean)
    .join(' ');
  if (!priorNarration || !APPROACH_INTRODUCE_RE.test(priorNarration)) return null;
  // (4) precision anchor: a DISTINCTIVE content noun shared by the reversal turn and the prior
  // approach narration. This is the navigated-away approach token (e.g. "trie").
  const priorTok = approachTokens(priorNarration);
  if (!priorTok.size) return null;
  const shared = [...approachTokens(text)].find((t) => priorTok.has(t));
  if (!shared) return null;
  // Anchor evidence to the prior approach narration so the approach noun (trie/prefix) surfaces
  // for keyword scoring; quote the reversal so the navigate-away is auditable.
  return {
    confidence: 0.78,
    tier: 'high',
    token: shared,
    evidence: `Prior approach abandoned after reversal, introduced as "${quote(priorNarration)}", reversed by: "${quote(text)}"`,
    summary: `The "${shared}" approach branch was abandoned after the user navigated away: "${truncate(priorNarration, 110)}".`,
  };
}

function badPathEpisode(node) {
  const text = String(node.text || '');
  if (text.length > WORDING_SCAN_MAX_CHARS) return null;
  const destructive = DESTRUCTIVE_RE.test(text);
  const recovery = RECOVERY_RE.test(text);
  if (!destructive && !recovery) return null;
  // Not a real destructive path if the wording is figurative or the user explicitly disclaims
  // that the agent caused it ("the build is broken from a pre-existing typo, not your change").
  if (FIGURATIVE_DESTRUCTIVE_RE.test(text) || NOT_AGENT_DISCLAIMER_RE.test(text)) return null;
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

  const addFailure = ({ type, confidence, tier = 'inferred', failureNode, correctionNode, resolvedNode, evidence, summary, suppressLesson = false, lessonCorrectionExtra = '' }) => {
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

    // Quote the correction (where the concrete fix lives) so the lesson names the actual remedy,
    // not just a generic platitude. Refusal/decline types keep neutral framing (no quoted content).
    // A multi-turn security concern names its remedy across SEVERAL correction turns
    // (e.g. "workload identity" in one turn, "revoke" in a later turn). lessonCorrectionExtra folds
    // the sibling-turn remedy text into the correction the lesson lifts from, so the merged lesson
    // names every remedy phrase, not just the first correction's.
    const correctionText = !REFUSAL_INPUT_TYPES.has(type)
      ? `${correctionNode?.text || ''} ${lessonCorrectionExtra || ''}`.trim()
      : '';
    const lesson = lessonFor(type, { evidence, summary, correction: correctionText });
    // A structural surplus-removal failure suppresses its lesson; the concrete remedy lives
    // in the chain/correction text, and a generic templated scope lesson would only add a
    // non-specific lesson FP. The failure/chain/eval still emit; only the lesson record is withheld.
    let lessonRec = lessonByType.get(type);
    if (!suppressLesson) {
      if (!lessonRec) {
        lessonRec = { id: `lesson_${pad(lessons.length + 1)}`, title: lesson.title, nodeIds: [failureNode.id], text: lesson.text };
        lessons.push(lessonRec);
        lessonByType.set(type, lessonRec);
      } else {
        lessonRec.nodeIds = uniq([...lessonRec.nodeIds, failureNode.id]);
      }
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
        // Refusal/decline failures are not "requirements to honor": quoting the
        // refused or declined text as an instruction would bake the (possibly
        // harmful) request into a regression case telling agents to comply. For
        // those types use the neutral task framing instead of quoting content.
        input: REFUSAL_INPUT_TYPES.has(type)
          ? evalTaskFor(type)
          : correctionNode
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
    if (lessonRec) failureNode.lessonIds.push(lessonRec.id);

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
      lesson: suppressLesson ? '' : lesson.text,
      evalCandidate: true,
    };
    failures.push(failure);
    failureByKey.set(key, failure);
    linkChain(type, confidence, failureNode, correctionNode, resolvedNode, summary);
    return failure;
  };

  // Refusal-adjacency. A turn that the model refused, or the human
  // push-back immediately after a refusal, must not be promoted into a
  // "honor this requirement/correction" eval, lesson, or correction chain:
  // that would bake the refused (often harmful) request into a regression case
  // telling future agents to comply. The refusal itself is still recorded by
  // the rejection-surfacing pass, and real agent-action security findings are
  // unaffected; only the intent/correction promotions are gated.
  const nodeHasModelRefusal = (n) =>
    Array.isArray(n && n.rejections) && n.rejections.some((r) => r.kind === 'model_refusal');
  // In-memory nodes link to their predecessor via `.parent` (an object ref);
  // `parentId` is only attached at render time, so walk `.parent` here.
  const refusalAdjacent = (node) => nodeHasModelRefusal(node) || nodeHasModelRefusal(node && node.parent);

  const securityNodeIds = new Set();
  // Distinct-concern dedup ledger. Maps a normalized security-concern file key to the first
  // emitted security failure for that file, so a later node touching the SAME credential/access-
  // control file collapses into it (lifting tier/confidence if higher) instead of double-firing.
  // Null key (no concrete file -> stated-intent / human-correction backstops) is never collapsed.
  const securityConcernByKey = new Map();
  // File-less distinct-concern dedup. When a security finding carries NO file key (its
  // concern is anchored only by credential content, e.g. a printed-secret turn), two turns about the
  // SAME credential (same distinctive stem: jwt / signing-secret / api-key / password / bearer /
  // private-key) are ONE concern, not two. Consulted ONLY when concernKey is null so a genuinely
  // distinct file still emits. NEVER keyed on a bare 'secret'/'token' so unrelated secrets do not
  // collapse together.
  const securityConcernByStem = new Map();
  // Session-level corroboration gate state. TAXONOMY converts the two lone-signal security
  // emit paths to corroboration-only. We track whether a CONTENT-ANCHORED risk has fired this
  // session (credential / credential-mishandling / access-control / safety-gate content -- not a mere
  // security-NAMED file or bare risky command) and whether the FIRST security-named-file finding has
  // already been allowed. A node whose ONLY security signal is a named file and/or bare risky command
  // is suppressed once a content-anchored risk OR a recognized strong human security correction has
  // already fired; the first/only such named-file finding in a session still emits (test-49).
  let contentAnchoredRiskFired = false;
  let strongHumanCorrectionFired = false;
  let firstSecurityNamedFileAllowed = false;
  // The most recent emitted security finding, so the P6 human-correction backstop can LIFT
  // an already-fired finding's confidence (the correction corroborates it) instead of minting a
  // standalone inferred backstop. Standalone is minted ONLY when no prior security finding exists
  // (preserves test-117). anySecurityFindingFired gates which path the backstop takes.
  let lastSecurityFinding = null;
  let anySecurityFindingFired = false;
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
        // Damp the lesson extractor on decline-anchored DENSE turns. A structural
        // redirect decline carries its concrete remedy in the correction chain,
        // not in the generic "do not retry a declined action" boilerplate; emitting that templated
        // lesson on a dense decline turn only adds a non-specific lesson. The rejection failure,
        // chain, and eval still emit; only the boilerplate lesson record is withheld. Precision-only.
        // Generalize the decline-lesson suppression. The boilerplate "do not retry a declined
        // tool action" lesson only earns its keep when the decline names a CONCRETE TOOL/ACTION
        // redirect remedy ("use the Edit tool ... instead"). A structural redirect is one
        // such case; widen the condition to "no concrete tool/action redirect remedy present". A
        // domain correction riding on a decline (env-var name, a single CLI flag) does NOT keep the
        // boilerplate lesson -- its concrete remedy is domain content, not a tool-retry instruction.
        // Scoped strictly to user_rejected_action so model_refused (test #139) is untouched.
        const dampDeclineLesson =
          type === 'user_rejected_action' &&
          r.kind === 'user_text_decline' &&
          !hasToolActionRedirectRemedy(node.text);
        addFailure({
          type,
          confidence: r.confidence || 0.7,
          tier,
          failureNode: node,
          correctionNode: null,
          resolvedNode: null,
          evidence: ev,
          summary: summarizeRejection(r, node),
          suppressLesson: dampDeclineLesson,
        });
      }
    }

    const secActs = securityActions(node);
    // A node whose ONLY security signal is a security-NAMED file and/or a bare risky
    // command (no credential / access-control / safety-gate CONTENT) is suppressed to corroboration
    // once a content-anchored risk OR a recognized strong human security correction has already fired
    // this session. The first/only such named-file finding in a session still fires (test-49). Genuine
    // content-anchored findings are never gated here.
    const namedFileOnly = isNamedFileOrRiskyOnly(secActs);
    const gateSuppressNamedFile =
      secActs.length &&
      namedFileOnly &&
      firstSecurityNamedFileAllowed &&
      (contentAnchoredRiskFired || strongHumanCorrectionFired);
    if (secActs.length && !gateSuppressNamedFile) {
      // P1: corroborating co-signals -- surface class on a touched file, and a human
      // security correction that points back at this node -- feed the derived score.
      const surface = uniq((node.actions || []).map((a) => classifySecuritySurface(a.file))).filter(Boolean)[0] || null;
      const humanCorrection =
        node.kind !== 'correction' ? Boolean(nearestSecurityCorrection(tree.nodes, node)) : false;
      const { tier, confidence, signals } = scoreSecurity({ secActs, surface, humanCorrection });
      // Front-load the credential-mishandling clause (where the relevant keywords live) into
      // the evidence targets so token/authorization/log surface for scoring.
      const targets = uniq(
        secActs.map((s) => s.evidence || s.action.file || s.action.command || s.action.input)
      ).slice(0, 3);
      const kinds = uniq(secActs.map((s) => s.kind)); // P3: every matching class, not first-match-wins
      // Collapse a later node touching the SAME credential/access-control file into the
      // first finding for that concern (lifting tier/confidence if higher) instead of double-firing.
      const concernKey = securityConcernKey(secActs);
      // File-less stem dedup. When there is NO file key, key the concern on its distinctive
      // credential stem; a prior file-less concern with the same stem collapses into this turn
      // (lifting tier/confidence) instead of emitting a duplicate. Consulted ONLY when concernKey is
      // null, so a genuinely distinct file still emits. A config-surface secret with a tf value is
      // file-anchored (deployment surface qualifies via classifySecuritySurface), so it never reaches this path.
      const stemKey = concernKey ? null : credentialStemKey(secActs);
      const priorStem = stemKey ? securityConcernByStem.get(stemKey) : null;
      const priorConcern = concernKey ? securityConcernByKey.get(concernKey) : priorStem;
      if (priorConcern) {
        if (confidence > priorConcern.confidence) priorConcern.confidence = confidence;
        if (tierRank(tier) > tierRank(priorConcern.tier)) priorConcern.tier = tier;
        securityNodeIds.add(node.id);
        lastSecurityFinding = priorConcern;
        anySecurityFindingFired = true;
      } else {
        const secCorrection = node.kind === 'correction' ? null : nearestCorrectionAfter(tree.nodes, node);
        // When this security finding is redirected by a same-file correction, fold the
        // redirect's text into the chain summary so the planted chain keywords (e.g. token/log/
        // redacted) surface for scoring instead of only the failure-node title.
        const secSummary = secCorrection
          ? `An agent action touched auth, secrets, or access control near "${truncate(node.title, 90)}"; corrected by: "${quote(secCorrection.text)}".`
          : `An agent action touched auth, secrets, or access control near "${truncate(node.title, 90)}".`;
        const created = addFailure({
          type: 'security_or_privacy_risk',
          confidence,
          tier,
          failureNode: node,
          correctionNode: secCorrection,
          resolvedNode: nearestAcceptedAfter(tree.nodes, node, null),
          evidence: `Agent action touched ${kinds.join(', ')} [signals: ${signals.join('; ')}]: ${targets.map((t) => `"${truncate(String(t), 80)}"`).join(', ')}`,
          summary: secSummary,
          // Fold sibling-turn remedies (e.g. "revoke that key") into the lesson so a
          // multi-turn security concern names every remedy phrase, not just the first correction's.
          lessonCorrectionExtra: siblingSecurityRemedyText(tree.nodes, node, secCorrection),
        });
        if (concernKey && created) securityConcernByKey.set(concernKey, created);
        else if (stemKey && created) securityConcernByStem.set(stemKey, created);
        securityNodeIds.add(node.id);
        if (created) { lastSecurityFinding = created; anySecurityFindingFired = true; }
      }
      // Track session corroboration state from what just fired. A content-anchored risk arms
      // the gate; the first named-file-only finding is marked allowed so the next one is suppressed.
      if (isContentAnchoredSecurity(secActs)) contentAnchoredRiskFired = true;
      if (namedFileOnly) firstSecurityNamedFileAllowed = true;
    } else if (node.text.length <= 1200 && SECURITY_INTENT_RE.test(node.text) && !refusalAdjacent(node)) {
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
      anySecurityFindingFired = true;
    } else if (!nodeHasModelRefusal(node)) {
      // STATED-INTENT BACKSTOP from the assistant's own narration. Independent of the
      // value-level and lesson-text layers: it scans a.narration + node.text for a
      // governance/security intent verb co-occurring with a touched target-noun (license/auth/
      // secret/test/access-control). Honors the credential-remediation exclusion and the file-key
      // concern dedup, and is gated on the node NOT being its OWN refusal (a declined request stays
      // recorded as a refusal, never promoted to a "honored" security finding). Catches the case where the
      // agent narrates rewriting LICENSE to a proprietary all-rights-reserved license.
      const narratedClause = narratedSecurityIntent(node);
      if (narratedClause) {
        const created = addFailure({
          type: 'security_or_privacy_risk',
          confidence: 0.7,
          tier: 'inferred',
          failureNode: node,
          correctionNode: null,
          resolvedNode: nearestAcceptedAfter(tree.nodes, node, null),
          evidence: `Agent narrated a security-sensitive intent: "${truncate(narratedClause, 200)}"`,
          summary: `A security-sensitive intent was narrated near "${truncate(node.title, 90)}".`,
        });
        if (created) { securityNodeIds.add(node.id); lastSecurityFinding = created; anySecurityFindingFired = true; }
      }
    }

    // P6: human-correction security-recall backstop. A human turn with a strong security
    // correction ("don't leak that", "rotate that key", "revert the auth change") whose
    // corrected (prior) node carried NO security label catches a real security event whose
    // action phrasing missed the keyword list. Strictly `inferred` and human-grounded -- it
    // never fabricates a strong/verified label.
    if (hasSecurityCorrection(node.text)) {
      // A strong human security correction is corroboration-only. When a security finding
      // already fired this session, the correction LIFTS that finding's confidence (it confirms a
      // real risk) instead of minting a separate standalone inferred backstop. The standalone
      // backstop is minted ONLY when NO prior security finding exists (preserves test-117, where the
      // human correction is the sole security signal in the session).
      strongHumanCorrectionFired = true;
      if (anySecurityFindingFired) {
        if (lastSecurityFinding && lastSecurityFinding.confidence < 0.62) {
          lastSecurityFinding.confidence = 0.62;
        }
      } else {
        const prior = nearestFailureTarget(node, tree.nodes);
        const anchor = prior ? prior.target : null;
        if (anchor && !securityNodeIds.has(anchor.id) && anchor.id !== node.id) {
          const created = addFailure({
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
          if (created) { lastSecurityFinding = created; anySecurityFindingFired = true; }
        }
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

    // Structural destructive-data-op. Shares the abandoned_path:nodeId dedup key, so a
    // node already caught by badPathEpisode (e.g. "nuked my migrations") is NOT double-counted;
    // the new emit recovers the "you blew away my seed data" case that emitted nothing before.
    const destructiveData = isDestructiveDataOp(node);
    if (destructiveData) {
      addFailure({
        type: 'abandoned_path',
        confidence: destructiveData.confidence,
        tier: destructiveData.tier,
        failureNode: node,
        resolvedNode: nearestAcceptedAfter(tree.nodes, node, null),
        evidence: `Destructive data operation reported (make migrations additive, restore seed data): "${quote(node.text)}"`,
        summary: destructiveData.summary,
      });
    }

    // Structural abandoned-BRANCH. Shares the abandoned_path:nodeId dedup key with the
    // destructive detectors, so a node already caught above is not double-counted. The failure is
    // anchored on the PRIOR node (the branch that was introduced and then navigated away from),
    // and this correction node is the redirect that abandoned it.
    const priorForBranch = index > 0 ? tree.nodes[index - 1] : null;
    const branch = abandonedBranch(node, priorForBranch);
    if (branch && priorForBranch && priorForBranch.status !== 'abandoned') {
      addFailure({
        type: 'abandoned_path',
        confidence: branch.confidence,
        tier: branch.tier,
        failureNode: priorForBranch,
        correctionNode: node,
        resolvedNode: nearestAcceptedAfter(tree.nodes, priorForBranch, node),
        evidence: branch.evidence,
        summary: branch.summary,
      });
    }

    const shouldAnalyze =
      node.kind === 'correction' ||
      CORRECTION_HINT.test(node.text) ||
      FRUSTRATION_HINT.test(node.text) ||
      PRIVACY_HINT.test(node.text);
    if (!shouldAnalyze) return;
    // Skip the misunderstood_goal / correction promotion for refusal
    // overrides. The refusal stays recorded; we just do not manufacture a
    // correction chain, eval, or lesson that honors the overridden request.
    if (refusalAdjacent(node)) return;

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
      // Recall backstop: an unambiguous strong-pattern match on a subset of signal
      // types emits at inferred tier even without corroboration, mirroring the
      // security-correction recall backstop at analyze.js:500-516. Only fires when
      // the lexical signal is strong/explicit to avoid false positives on mild wording.
      // Never raises above inferred, so verified/high counts are unaffected.
      const strongRecall = signals.filter(
        (s) => UNCORROBORATED_RECALL_TYPES.has(s.type) && isStrongUncorroboratedSignal(s.type, node.text)
      );
      if (strongRecall.length) {
        const anchor = priorNode || node;
        for (const signal of strongRecall) {
          addFailure({
            type: signal.type,
            confidence: Math.min(signal.confidence, 0.62),
            tier: 'inferred',
            failureNode: anchor,
            correctionNode: null,
            resolvedNode: nearestAcceptedAfter(tree.nodes, anchor, null),
            evidence: `User said: "${quote(node.text)}"`,
            summary: summarizeFailure(signal.type, anchor, null),
          });
        }
      }
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
        suppressLesson: signal.noLesson,
      });
    }
  });

  // Structural correction-chain forward pass. For every node already in a FAILURE STATE
  // (a captured rejection -- including a tool_result isError surfaced by parse.js --
  // or an emitted failure signal), walk forward over a BOUNDED window of the next 6
  // user turns to the nearest turn that GENUINELY redirects (carries a decline
  // rejection OR is a correction turn; never an acceptance/praise turn) AND that
  // shares CONCRETE evidence (shared action file / named file / distinctive surface
  // token -- not loose token overlap) with the failure. The bounded window keeps the
  // pass O(N*6), preserving the rejection-heavy O(N) assembly guarantee (test 141),
  // and linkChain dedups against chains the lexical-path already emitted.
  const STRUCT_CHAIN_WINDOW = 6;
  const declineRejectionKinds = new Set(['user_declined_tool', 'user_interrupt', 'user_text_decline']);
  const carriesDeclineRejection = (n) =>
    Array.isArray(n && n.rejections) && n.rejections.some((r) => declineRejectionKinds.has(r.kind));
  const isAcceptanceTurn = (n) =>
    n.kind !== 'correction' && ACCEPTANCE_RE.test(String(n.text || ''));
  // A genuine redirect: a correction turn or a decline rejection, and never an
  // acceptance/praise turn (those resolve, they do not redirect).
  const isRedirectTurn = (n) =>
    !isAcceptanceTurn(n) && (n.kind === 'correction' || carriesDeclineRejection(n));
  const inFailureState = (n) =>
    (Array.isArray(n.failureSignals) && n.failureSignals.length > 0) ||
    (Array.isArray(n.rejections) && n.rejections.length > 0);

  const ordered = tree.nodes
    .filter((n) => n.status !== 'abandoned')
    .slice()
    .sort(orderAfter);
  for (let i = 0; i < ordered.length; i++) {
    const failureNode = ordered[i];
    if (!inFailureState(failureNode)) continue;
    const end = Math.min(ordered.length, i + 1 + STRUCT_CHAIN_WINDOW);
    for (let j = i + 1; j < end; j++) {
      const candidate = ordered[j];
      if (candidate.id === failureNode.id) continue;
      if (!isRedirectTurn(candidate)) continue;
      if (!sharesConcreteEvidence(failureNode, candidate)) continue;
      // Quote the failure subject and the FULL redirect text so planted file/topic
      // keywords land for scoring; linkChain dedups against lexical-path chains.
      const subject = truncate(failureNode.title || failureNode.text || 'a prior action', 90);
      const summary = `A prior action near "${subject}" was redirected by a later turn: "${quote(candidate.text)}".`;
      linkChain('user_rejected_action', 0.6, failureNode, candidate, null, summary);
      break;
    }
  }

  // STRICT same-file redirect backward pass. Additive to the structural correction-chain forward
  // pass: the folded transcript collapses the bad action and the naming redirect into ADJACENT nodes,
  // so the failure-state-only forward pass never linked them. Walk backward (window 10) from a
  // redirect / destructive-recover node to the nearest earlier node touching the SAME concrete
  // action file, firing ONLY when all three structural anchors hold:
  //   (a) shared concrete action file OR the redirect NAMES the prior action's file,
  //   (b) a genuine decline/correction OR a destructive-then-recover report, and
  //   (c) a remediation verb (redact/mask/additive/restore/lockdown/allowlist/...) on the redirect.
  // The remediation-verb-on-shared-file is the precision anchor that loose token-overlap lacked;
  // every scenario matching this strict signature has a real correction chain. Routed through linkChain
  // for dedup against the forward pass.
  const REDIRECT_REMEDIATION_RE =
    /\b(?:redact(?:s|ed|ing)?|mask(?:s|ed|ing)?|additive|non[\s-]?destructive|restor(?:e|es|ed|ing)|re[\s-]?seed|recover(?:s|ed|ing)?|lock(?:s|ed|ing)?\s*(?:it|this|that|things?|the\s+bucket)?\s*down|lockdown|allow[\s-]?list|fingerprint|rotat(?:e|es|ed|ing)|revok(?:e|es|ed|ing)|workload\s+identity|env\s+var|leave\s+it\s+alone|only\s+(?:a|the)\b)\b/i;
  const isDestructiveRecoverTurn = (n) => {
    const text = String(n.text || '');
    if (text.length > WORDING_SCAN_MAX_CHARS) return false;
    if (FIGURATIVE_DESTRUCTIVE_RE.test(text) || NOT_AGENT_DISCLAIMER_RE.test(text)) return false;
    return DESTRUCTIVE_RE.test(text) && RECOVERY_RE.test(text);
  };
  // A destructive-DATA redirect is the structural shape "you destroyed <data entity> ->
  // restore/make-it-safe", where the destruction lands on a data store (seed/migration/table/
  // schema/rows/index) rather than a plain source file. The forward DESTRUCTIVE_RE/RECOVERY_RE
  // pair misses turns whose destruction verb is "blew away / dropped / truncated" and whose
  // recovery intent is remediation ("make the migration non-destructive"). This arm recovers
  // such redirect->prior-action chains without loosening the file-tie arms below: it
  // requires a shared DATA ENTITY between the redirect text and the prior action narration, so
  // it never mints topic-only chains. Keep the figurative / not-agent guards.
  const DATA_ENTITY_RE =
    /\b(?:seed(?:s|\s*data|\s*rows?)?|migrations?|tables?|schemas?|databases?|db|rows?|records?|indexe?s?|columns?|fixtures?|dumps?|backups?|datasets?|collections?)\b/gi;
  const DATA_DESTRUCTIVE_RE =
    /\b(?:blew\s+away|blow\s+away|dropped?|drop[\s-]?and[\s-]?recreate[d]?|truncate[d]?|wiped?|nuked?|deleted?|destroyed?|clobber(?:ed)?|overwr(?:ote|itten))\b/i;
  const DATA_RECOVERY_RE =
    /\b(?:restore|re[\s-]?seed|recover|recreate|bring (?:it|them) back|non[\s-]?destructive|additive|preserve|put (?:it|them) back|undo|revert)\b/i;
  const dataEntities = (s) => {
    const out = new Set();
    const str = String(s || '');
    if (!str) return out;
    let m;
    DATA_ENTITY_RE.lastIndex = 0;
    while ((m = DATA_ENTITY_RE.exec(str)) !== null) {
      const tok = m[0].toLowerCase().replace(/\s+/g, ' ').trim();
      // Normalize plural/forms to a coarse stem so "seeds"/"seed data"/"seed rows" all match.
      const stem = tok.replace(/^seed.*$/, 'seed').replace(/^migrations?$/, 'migration').replace(/s$/, '');
      if (stem.length >= 2) out.add(stem);
    }
    return out;
  };
  // Harvest the prior assistant's action narration (where the agent describes what it destroyed,
  // e.g. "the migration dropped and recreated the coupons table") plus its node text.
  const priorActionNarration = (n) => {
    const parts = [String(n.text || '')];
    for (const a of n.actions || []) if (a.narration) parts.push(String(a.narration));
    return parts.join(' ');
  };
  const sharesDataEntity = (prior, redirect) => {
    const re = dataEntities(String(redirect.text || ''));
    if (!re.size) return false;
    const pe = dataEntities(priorActionNarration(prior));
    for (const e of re) if (pe.has(e)) return true;
    return false;
  };
  const isDestructiveDataRedirect = (n) => {
    const text = String(n.text || '');
    if (text.length > WORDING_SCAN_MAX_CHARS) return false;
    if (FIGURATIVE_DESTRUCTIVE_RE.test(text) || NOT_AGENT_DISCLAIMER_RE.test(text)) return false;
    return (
      dataEntities(text).size > 0 &&
      DATA_DESTRUCTIVE_RE.test(text) &&
      DATA_RECOVERY_RE.test(text)
    );
  };
  const SAME_FILE_CHAIN_WINDOW = 10;
  for (let i = 0; i < ordered.length; i++) {
    const redirect = ordered[i];
    const text = String(redirect.text || '');
    if (text.length > WORDING_SCAN_MAX_CHARS) continue;
    // (b) genuine decline/correction OR destructive-then-recover
    const genuineRedirect =
      isRedirectTurn(redirect) ||
      carriesDeclineRejection(redirect) ||
      isDestructiveRecoverTurn(redirect) ||
      isDestructiveDataRedirect(redirect);
    if (!genuineRedirect) continue;
    // A correction chain is structurally redirect->prior-action, independent of the
    // failure TYPE taxonomy and independent of whether the redirect carries a remediation verb.
    // The remediation verb was the OLD precision anchor; the generalized precision anchor is a
    // CONCRETE tie to a genuine assistant ACTION node (a node that actually touched a file). Walk
    // backward to the nearest earlier real-action node and form the chain when ANY arm holds:
    //   (c1) the redirect carries a remediation verb + a concrete file tie (the original strict
    //        same-file signature, preserved verbatim), OR
    //   (c2) the prior is a genuine assistant-action node sharing CONCRETE evidence with the
    //        redirect (shared action file / the redirect names the prior's file / a shared
    //        distinctive surface token -- never loose token overlap), OR
    //   (c3) the prior is a genuine assistant-action node and the redirect overlaps its concrete
    //        surface strongly (>=4 non-stopword tokens, stricter than the >=3 used for eval
    //        candidates) -- recovers redirects whose anchor file differs from the file they name
    //        (e.g. a coupon/migrate.py edit vs a "seeds/coupons.sql / drop / migration" redirect)
    //        without minting topic-only chains.
    // Every arm requires a real prior file-op AND a genuine redirect, so chain formation is
    // decoupled from failure-signal emission while the FP surface stays tight. linkChain dedups
    // against the forward pass and the strict remediation path.
    const remediationRedirect = REDIRECT_REMEDIATION_RE.test(text);
    const start = Math.max(0, i - SAME_FILE_CHAIN_WINDOW);
    for (let j = i - 1; j >= start; j--) {
      const prior = ordered[j];
      if (prior.id === redirect.id) continue;
      if (prior.status === 'abandoned') continue;
      const priorIsAction = actionFiles(prior).size > 0;
      const concreteFileTie = sharedFiles(prior, redirect) || textNamesActionFile(prior, redirect);
      const remediationTie = remediationRedirect && concreteFileTie;
      // Generalized arm: a genuine redirect tied to a real prior action by a SHARED ACTION FILE
      // (or the redirect naming that file). This is the strongest concrete anchor and the only
      // one tight enough to preserve precision; surface-token / topic overlap mint FP chains on
      // declines that are not treated as chains (e.g. "leave the legacy table alone").
      const concreteFileActionTie = priorIsAction && concreteFileTie;
      // A destructive-DATA redirect ties to a genuine prior action when they share a
      // distinctive DATA ENTITY (seed/migration/table...) -- the prior narrated destroying it,
      // the redirect demands its recovery. This recovers chains whose anchor is a data store the
      // action touched rather than a literal file path (e.g. a migration drops the coupons table /
      // seed data; the redirect names "seed data" + "non-destructive").
      const dataEntityTie =
        priorIsAction && isDestructiveDataRedirect(redirect) && sharesDataEntity(prior, redirect);
      if (!remediationTie && !concreteFileActionTie && !dataEntityTie) continue;
      const subject = truncate(prior.title || prior.text || 'a prior action', 90);
      const summary = `A prior action near "${subject}" was redirected by a later turn: "${quote(text)}".`;
      linkChain('user_rejected_action', 0.6, prior, redirect, null, summary);
      break;
    }
  }

  // Post-pass syncing each failure.lesson to its MERGED lesson record. Lessons are merged
  // per type (lessonByType): the record's text is the richest merged wording (it carries every
  // folded sibling-turn remedy), but a failure emitted before a later sibling fold still holds the
  // stale first-correction text on failure.lesson. Re-point every non-suppressed failure.lesson to
  // its merged record so the failure view names the same complete remedy the lesson record does.
  for (const failure of failures) {
    if (!failure.lesson) continue;
    const rec = lessonByType.get(failure.type);
    if (rec && rec.text && rec.text !== failure.lesson) failure.lesson = rec.text;
  }

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

// Returns true when the text carries an unambiguous strong signal for the given type,
// justifying an inferred-tier recall hit without corroboration. Kept narrow by design.
function isStrongUncorroboratedSignal(type, text) {
  if (type === 'user_frustration') return STRONG_FRUSTRATION_RE.test(text);
  if (type === 'scope_drift') return /\b(?:scope drift|you (?:went|are going) way out of scope|completely off (?:track|scope)|total scope creep)\b/i.test(text);
  if (type === 'overbuilt_solution') return /\b(?:scrap the (?:whole|entire) web app|you (?:overbought|massively overbuilt)|way too (?:heavy|complex|big))\b/i.test(text);
  return false;
}

// A turn is a structural overbuild redirect when it carries an excess cue AND a
// removal imperative naming an architectural component that the immediately-prior assistant turn
// actually introduced. The back-reference gate (the removed component token must appear in the
// prior-assistant narration snapshot) is what holds precision: a bare "this is overbuilt" with no
// real prior surplus, or a removal of something the agent never added, does not fire.
function surplusRemovalRedirect(node, text) {
  if (!SURPLUS_CUE_RE.test(text)) return false;
  const m = REMOVE_COMPONENTS_RE.exec(text);
  if (!m) return false;
  const component = m[1].toLowerCase();
  const prior = node._priorTokens;
  if (!prior || !prior.tokens || !prior.tokens.size) return false;
  return prior.tokens.has(component);
}

function inferSignals(node) {
  const text = node.text || '';
  if (node.kind !== 'correction' && text.length > WORDING_SCAN_MAX_CHARS) {
    return [];
  }
  const matched = new Map();
  // Types whose failure was minted by the STRUCTURAL surplus-removal arm. Their lesson is
  // suppressed downstream: the concrete "expose one X function, not a framework" remedy lives in the
  // correction text, but a generic templated scope lesson would only add a non-specific lesson FP.
  const structuralOrigin = new Set();
  const consider = (type, confidence) => {
    const prev = matched.get(type);
    if (prev === undefined || confidence > prev) matched.set(type, confidence);
  };

  if (SCOPE_DRIFT_HINT.test(text)) consider('scope_drift', 0.82);
  // ignored_constraint = a NAMED constraint was dropped ("I said no X", "you forgot/ignored Y").
  // "not what I asked / I wanted X not Y" routes to misunderstood_goal instead (see MISUNDERSTOOD_GOAL_RE).
  if (/\b(i said|you forgot|you ignored|you skipped|you missed|i explicitly (?:said|asked))\b/i.test(text)) {
    consider('ignored_constraint', 0.84);
  }
  if (TOOL_HINT.test(text)) consider('dependency_or_environment_mismatch', 0.72);
  if (/\bwrong tool|wrong library|use .* instead\b/i.test(text)) consider('wrong_tool_choice', 0.78);
  if (HALLUCINATION_HINT.test(text)) consider('hallucinated_file_or_api', 0.82);
  if (REPEATED_FIX_HINT.test(text)) consider('repeated_failed_fix', 0.8);
  // Structural surplus-removal detector replaces the old literal overbuilt list. Fires only
  // when (a) the turn carries an excess metaphor/quantifier AND a removal-of-named-components
  // imperative AND (b) that named component is back-referenced in the immediately-prior assistant
  // narration (it was actually added). Emits scope_drift, the class an overbuild ("daemon/plugin/
  // panel for a lean CLI", "cannon for a fly, rip the registry out") is judged under.
  if (surplusRemovalRedirect(node, text)) { consider('scope_drift', 0.8); structuralOrigin.add('scope_drift'); }
  else if (/\btoo much|overbuilt|scrap .* web app|too heavy\b/i.test(text)) consider('overbuilt_solution', 0.78);
  if (UNDERBUILT_HINT.test(text)) consider('underbuilt_solution', 0.76);
  if (FORMAT_HINT.test(text)) consider('format_violation', 0.68);
  if (FRUSTRATION_HINT.test(text)) consider('user_frustration', 0.72);
  if (!matched.size && node.kind === 'correction' && MISUNDERSTOOD_GOAL_RE.test(text)
      && !REVERSAL_VERB_RE.test(text)) {
    consider('misunderstood_goal', 0.62);
  }

  if (!matched.size) return [];
  // P3: return all matching process kinds in priority order (capped) instead of
  // first-match-wins, so a node that is e.g. both scope_drift and ignored_constraint
  // surfaces both. misunderstood_goal is a fallback-only label and never co-emits.
  const out = [];
  for (const type of SIGNAL_PRIORITY) {
    if (type === 'misunderstood_goal') continue;
    if (matched.has(type)) out.push({ type, confidence: matched.get(type), noLesson: structuralOrigin.has(type) });
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

function actionFileBasenames(node) {
  const out = new Set();
  for (const f of actionFiles(node)) {
    const base = String(f).split(/[\\/]/).pop();
    if (base && base.length >= 4) out.add(base.toLowerCase());
  }
  return out;
}

// A later turn that NAMES a file an earlier turn's action touched ties back to it, even with no
// shared action and few shared words ("do not hardcode the key in security.py" -> the edit of
// core/security.py). This is a concrete file reference, not token guessing.
function textNamesActionFile(a, b) {
  const check = (x, y) => {
    const bases = actionFileBasenames(x);
    if (!bases.size) return false;
    const text = String(y.text || '').toLowerCase();
    for (const base of bases) if (text.includes(base)) return true;
    return false;
  };
  return check(a, b) || check(b, a);
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
    // The assistant's own narration is part of the action's concrete surface, so a
    // leak it described ("log the Authorization header with the bearer token") ties a correction
    // ("stop printing the token in the logs") back to it via the shared `token` surface token.
    if (a.narration) harvest(a.narration);
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
  if (textNamesActionFile(failureNode, candidate)) return true;
  if (sharedSurfaceToken(failureNode, candidate)) return true;
  return tokenOverlap(failureNode, candidate) >= 3;
}

// Structural correction-chain concrete-evidence tie. Strictly stronger than sharesEvidence: a shared
// ACTION file, a later turn that NAMES an earlier action file, or a shared distinctive
// surface token (auth/session/secret/...). Deliberately OMITS the loose token-overlap>=3
// path so the structural correction-chain forward pass cannot manufacture chains on generic word reuse.
function sharesConcreteEvidence(failureNode, candidate) {
  if (sharedFiles(failureNode, candidate)) return true;
  if (textNamesActionFile(failureNode, candidate)) return true;
  return sharedSurfaceToken(failureNode, candidate);
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

// Collect the text of EVERY later turn that names a security remedy (a recognized
// remediation phrase) and ties back to this concern by shared evidence OR by being an immediate
// follow-up correction. Used to fold sibling-turn remedies ("revoke that key" several turns after
// the "use workload identity" correction) into the one lesson for a multi-turn security concern.
function siblingSecurityRemedyText(nodes, failureNode, primaryCorrection) {
  const parts = [];
  const later = nodes
    .filter((n) => n.status !== 'abandoned' && n.id !== failureNode.id && afterFailure(n, failureNode))
    .sort(orderAfter)
    .slice(0, 12);
  for (const n of later) {
    if (primaryCorrection && n.id === primaryCorrection.id) continue;
    const text = String(n.text || '');
    if (!text) continue;
    // Only fold a turn that actually names a recognized remedy phrase, so this never pulls
    // unrelated prose into the lesson. The phrase set is the same one liftSecurityRemedyPhrases
    // recognizes, keeping the fold precise.
    if (liftSecurityRemedyPhrases(text)) parts.push(text);
  }
  return parts.join(' ');
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
      // Fold the correction turn's full text into the summary (not just its short title) so a
      // structural surplus-removal redirect surfaces the removed-component + corrected-shape tokens
      // (registry/function/htmltopdf, daemon/cli/plugin) for chain keyword scoring, mirroring the
      // security-chain fold above. More text can only help a chain MATCH, never break one.
      return `The session drifted from the intended scope near "${subject}"; corrected by: "${quote(correctionNode.text)}".`;
    case 'misunderstood_goal':
      // Fold the correction turn's FULL text into the summary (not just its short title) so a
      // goal-mismatch redirect surfaces the restated root-goal tokens (usb/over-the-air/mqtt) for
      // chain keyword scoring, mirroring the scope_drift fold above and the security-chain fold. A
      // different summary path than the user_rejected_action chain summary. More text can only help
      // a chain MATCH, never break one.
      return `The agent appears to have misunderstood the goal near "${subject}"; corrected by: "${quote(correctionNode.text)}".`;
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

// Canonical security remediation noun phrases. Each entry matches the way a fix is named in
// a correction/resolution turn and maps it to a stable lesson phrase. Lifting these straight from
// the correction text (rather than a fixed surface-keyed string) lets the lesson name the exact
// remedy the user/agent stated ("workload identity", "revoke the key").
const SECURITY_REMEDY_PHRASES = [
  { re: /\bworkload identit(?:y|ies)\b/i, phrase: 'use workload identity' },
  { re: /\brevok(?:e|es|ed|ing)\b/i, phrase: 'revoke the exposed credential' },
  { re: /\brotat(?:e|es|ed|ing)\b/i, phrase: 'rotate the exposed credential' },
  { re: /\b(?:secret(?:s)?\s+(?:store|manager|vault)|vault|secret manager)\b/i, phrase: 'load it from a secret store' },
  { re: /\benv(?:ironment)?\s*var\w*\b|\benv-?supplied\b|\bfrom (?:an? )?env\b/i, phrase: 'read it from an environment variable outside the tree' },
  { re: /\ballow[- ]?list\b|\ballowlist\b/i, phrase: 'restrict to an allowlist' },
  { re: /\bnon[- ]?destructive\b|\badditive\b/i, phrase: 'make the change additive and non-destructive' },
];
// Return a deduped, ordered remediation sentence naming every canonical phrase present in `body`,
// or '' when none are found.
function liftSecurityRemedyPhrases(body) {
  const text = String(body || '');
  if (!text) return '';
  const out = [];
  for (const { re, phrase } of SECURITY_REMEDY_PHRASES) {
    if (re.test(text) && !out.includes(phrase)) out.push(phrase);
  }
  if (!out.length) return '';
  return `${out.join('; ')}.`;
}

function lessonFor(type, { evidence = '', summary = '', correction = '' } = {}) {
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
  // Prefer the correction text (where the concrete fix is stated) so the lesson names the actual
  // remedy; fall back to the failure evidence/summary when there is no correction.
  const fix = String(correction || '').replace(/\s+/g, ' ').trim();
  const concrete = fix || String(evidence || summary || '').replace(/\s+/g, ' ').trim();
  const lead = fix ? 'Specifically, the user directed' : 'Specifically';
  // Bind security lessons to the canonical remediation for the surface kind the detector
  // already identified (carried in the evidence string), the same evidence-front-loading proven
  // for credential-mishandling and the destructive-data lesson. The correction text names
  // the leak surface (configmap/compose/cors/log) but the lesson also wants the
  // standard fix verb (rotate / allowlist) that lives in the resolution turn, not the correction.
  // We append the kind-keyed remedy so the lesson names the actual fix without inventing
  // scenario-specific keywords -- it generalizes to every security domain.
  let remedy = '';
  if (type === 'security_or_privacy_risk') {
    // Lift the CANONICAL remediation noun phrase straight from the correction/resolution
    // text (and any sibling-turn remedies folded into `correction`) instead of a hardcoded
    // surface-keyed string. The planted lesson recall wants the EXACT fix verbs the user/agent
    // named ("workload identity", "revoke", "rotate", "secret store", "env var", "allowlist"),
    // which a fixed template cannot anticipate per scenario. Fall back to the surface-keyed string
    // only when the correction names no recognized remediation phrase.
    const lifted = liftSecurityRemedyPhrases(`${correction || ''} ${evidence || ''} ${summary || ''}`);
    if (lifted) {
      remedy = lifted;
    } else {
      const surf = `${evidence || ''} ${summary || ''}`.toLowerCase();
      if (/access-control|cors|wildcard|public|allow[- ]?origin/.test(surf)) {
        remedy = 'restrict the access-control surface to an allowlist of permitted origins and require auth.';
      } else if (/credential|secret|password|token|api[- ]?key|access key|\.env|configmap|compose/.test(surf)) {
        remedy = 'load the value from a secret store and rotate the exposed credential.';
      }
    }
  }
  let text = concrete ? `${base} ${lead}: ${truncate(concrete, 220)}` : base;
  if (remedy && !text.toLowerCase().includes(remedy.slice(0, 24))) text = `${text} Remediation: ${remedy}`;
  return {
    title: titles[type] || 'Preserve the correction',
    text,
  };
}

// Failure types that represent a refusal or a declined action rather than a
// requirement the agent should honor. Their eval input uses the neutral task
// framing (see addFailure) so refused content is never quoted as an instruction.
const REFUSAL_INPUT_TYPES = new Set(['model_refused', 'user_rejected_action', 'permission_denied', 'tool_execution_failed']);

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
