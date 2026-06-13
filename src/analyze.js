import { truncate, escapeMd } from './util.js';

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
]);

const CORRECTION_HINT =
  /\b(no|stop|scrap|not that|you forgot|you ignored|that's wrong|that is wrong|i said|instead|redo|re do|go back|wrong|doesn'?t work|didn'?t work|still (failing|broken|wrong|bad)|not what i (asked|wanted|meant))\b/i;
const FRUSTRATION_HINT =
  /\b(sucks|awful|god awful|what the heck|wtf|mad|angry|frustrat|not suffic|i don'?t trust|terrible|bad)\b/i;
const PRIVACY_HINT = /\b(secret|token|api key|apikey|password|redact|privacy|private|local-first|telemetry|upload|cloud)\b/i;
const SECURITY_INTENT_RE = /(?:\b(?:updated?|rotat(?:e|ed|ing)|regenerat(?:e|ed)|new|replaced?|revoked?)\b[^.]{0,40}\b(?:pat|personal access token|api[- ]?key|access token|secret|credential)s?\b|\bpat\b[^.]{0,30}\b(?:updated?|rotat|regenerat|revoked?)|\b(?:make|change|set|update|use)\b[^.]{0,30}\bemail\b(?=[^.]*@|[^.]*\bcontact\b|[^.]*\bpublic\b)|\b(?:don'?t|do not|never)\b[^.]{0,20}\b(?:expose|leak)\b|\bexpose us\b|\bleak (?:anything|audit|nothing|secrets?|creds?)\b|\b(?:full )?audit\b[^.]{0,40}\b(?:repo|repos|repositor|organization|git commit|commit history)\b|\bcommit history\b[^.]{0,30}\b(?:audit|expose|leak|clean)\b|\b(?:re-?licens(?:e|ing)|licens(?:e|ing) (?:adjustment|change)|chang(?:e|ing)[^.]{0,15}licens)\b|\b(?:disabl|skip|remov|delet)\w*\b[^.]{0,15}\btests?\b|\b(?:change|modify|update|add|tighten|loosen|fix)\b[^.]{0,20}\b(?:access control|permissions?|rbac|auth flow)\b)/i;
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
const RISKY_CMD_RE = /(?:\brm\s+-rf\b|\bchmod\s+777\b|curl[^|]*\|\s*(?:sh|bash)|wget[^|]*\|\s*(?:sh|bash)|--no-verify\b|--force(?![\w-])|\bDROP\s+TABLE\b|\bTRUNCATE\s+TABLE\b)/i;
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
const TEST_SKIP_RE =
  /\b(?:disabl|skip|remov|delet|comment(?:ed)? out|drop|turn(?:ed)? off|x?(?:it|describe)\.skip|--no-tests?|--skip-tests?)\w*\b[^.\n]{0,24}\btests?\b|\btests?\b[^.\n]{0,24}\b(?:disabl|skip|remov|delet|comment(?:ed)? out|turn(?:ed)? off)\w*/i;

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
  return typeof text === 'string' && text.length <= 4000 && TEST_SKIP_RE.test(text);
}

function securityActions(node) {
  const out = [];
  for (const a of node.actions || []) {
    const body = `${a.command || ''} ${a.input || ''}`;
    let kind = null;
    let strong = false;
    if (SECRET_CONTENT_RE.test(body)) {
      kind = 'credential';
      strong = true;
    } else if (a.file && isCredentialFile(a.file)) {
      kind = 'file';
      strong = true;
    } else if (ACCESS_CONTROL_CONTENT_RE.test(body)) {
      kind = 'access-control';
      strong = true;
    } else if (a.command && RISKY_CMD_RE.test(a.command)) {
      kind = 'risky-command';
    } else if (ACCESS_CONTROL_WEAK_RE.test(body)) {
      kind = 'access-control';
    }
    if (kind) out.push({ action: a, kind, strong });
  }
  return out;
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

  tree.nodes.forEach((node, index) => {
    const secActs = securityActions(node);
    if (secActs.length) {
      const hasStrong = secActs.some((s) => s.strong);
      const tier = hasStrong ? 'verified' : 'high';
      const confidence = hasStrong ? 0.95 : 0.84;
      const targets = uniq(secActs.map((s) => s.action.file || s.action.command || s.action.input)).slice(0, 3);
      const kinds = uniq(secActs.map((s) => s.kind));
      addFailure({
        type: 'security_or_privacy_risk',
        confidence,
        tier,
        failureNode: node,
        correctionNode: node.kind === 'correction' ? null : nearestCorrectionAfter(tree.nodes, node),
        resolvedNode: nearestAcceptedAfter(tree.nodes, node, null),
        evidence: `Agent action touched ${kinds.join(', ')}: ${targets.map((t) => `"${truncate(String(t), 80)}"`).join(', ')}`,
        summary: `An agent action touched auth, secrets, or access control near "${truncate(node.title, 90)}".`,
      });
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
    schemaVersion: '0.2',
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
    schemaVersion: '0.2',
    project: projectBlock(opts),
    summary: analysis.summary,
    failures: analysis.failures,
    correctionChains: analysis.correctionChains,
  };
}

export function renderLessonsMarkdown(tree, opts = {}) {
  const analysis = analyzeTree(tree);
  const lines = ['# TreeTrace Lessons', ''];
  if (!analysis.lessons.length) {
    lines.push('No high-confidence failure lessons were detected in this session.');
    lines.push('');
    return lines.join('\n');
  }
  analysis.lessons.forEach((lesson, i) => {
    lines.push(`## ${i + 1}. ${escapeMd(lesson.title)}`);
    lines.push('');
    lines.push(escapeMd(lesson.text));
    lines.push('');
    const ids = lesson.nodeIds;
    const shown = ids.slice(0, 8).join(', ');
    lines.push(`Source nodes: ${shown}${ids.length > 8 ? ` (+${ids.length - 8} more)` : ''}`);
    lines.push('');
  });
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
  const lines = [`# TreeTrace Agent Memory`, '', `Project: ${escapeMd(projectName)}`, ''];

  lines.push('## Constraints the user enforced');
  lines.push('');
  const constraints = extractConstraints(nodes);
  if (constraints.length) {
    for (const label of constraints) lines.push(`- ${escapeMd(truncate(label, 140))}`);
  } else {
    lines.push('- No explicit constraints were flagged. Follow the accepted decisions in the handoff brief.');
  }
  lines.push('');

  lines.push('## Lessons from this lineage');
  lines.push('');
  if (analysis.lessons.length) {
    for (const lesson of analysis.lessons.slice(0, 8)) lines.push(`- ${escapeMd(lesson.text)}`);
  } else {
    lines.push('- No high-confidence failure lessons were detected yet.');
  }
  lines.push('');

  lines.push('## Known bad paths');
  lines.push('');
  const badPaths = analysis.failures.filter((f) => f.type === 'abandoned_path').slice(0, 6);
  if (badPaths.length) {
    for (const failure of badPaths) lines.push(`- ${escapeMd(failure.summary)}`);
  } else {
    lines.push('- No abandoned paths were detected in this session.');
  }
  lines.push('');

  lines.push('## Security-sensitive actions');
  lines.push('');
  const security = analysis.failures
    .filter((f) => f.type === 'security_or_privacy_risk')
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))
    .slice(0, 8);
  if (security.length) {
    lines.push('Treat these as durable warnings; re-verify before touching the same surfaces:');
    for (const f of security) {
      const tag = f.tier === 'inferred' ? 'stated intent' : f.tier;
      lines.push(`- (${tag}) ${escapeMd(truncate(f.evidence, 200))}`);
    }
  } else {
    lines.push('- No security-sensitive actions or intents were detected in this session.');
  }
  lines.push('');

  lines.push('## Preferred next work');
  lines.push('');
  const strategic = nodes.filter(
    (n) =>
      live(n) &&
      (n.kind === 'root' || n.kind === 'direction' || n.kind === 'scope-change') &&
      isStrategicDirection(n)
  );
  const latest = latestByTime(strategic);
  if (latest) {
    lines.push(`- Continue the most recent accepted direction: ${escapeMd(truncate(latest.title, 140))}`);
  } else {
    lines.push(`- No open forward direction was stated; resume the goal of ${escapeMd(projectName)} and confirm scope with the user.`);
  }
  const openCorrections = nodes
    .filter((n) => live(n) && n.kind === 'correction' && isStrategicDirection(n))
    .slice(-3);
  for (const n of openCorrections) lines.push(`- Keep this correction satisfied: ${escapeMd(truncate(n.title, 120))}`);
  lines.push('');

  return lines.join('\n');
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
  for (const type of SIGNAL_PRIORITY) {
    if (matched.has(type)) return [{ type, confidence: matched.get(type) }];
  }
  return [];
}

function tsOf(node) {
  const t = node && node.ts ? new Date(node.ts).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function afterFailure(candidate, failureNode) {
  const ct = tsOf(candidate);
  const ft = tsOf(failureNode);
  if (ct === null || ft === null) return true;
  return ct >= ft;
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

function tokenSet(node) {
  const out = new Set();
  for (const raw of String(node.text || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []) {
    if (!STOPWORDS.has(raw)) out.add(raw);
  }
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

function sharesEvidence(failureNode, candidate) {
  if (sharedFiles(failureNode, candidate)) return true;
  return tokenOverlap(failureNode, candidate) >= 3;
}

function nearestFailureTarget(node, nodes) {
  const earlier = nodes.filter(
    (n) => n.status !== 'abandoned' && n.id !== node.id && afterFailure(node, n)
  );
  if (!earlier.length) return null;
  earlier.sort((a, b) => (tsOf(b) ?? 0) - (tsOf(a) ?? 0));
  const semantic = earlier.find((n) => sharesEvidence(n, node));
  if (semantic) return { target: semantic, linkage: 'semantic' };
  if (node.parent && node.parent.status !== 'abandoned' && node.parent.id !== node.id && afterFailure(node, node.parent)) {
    return { target: node.parent, linkage: 'positional' };
  }
  return { target: earlier[0], linkage: 'positional' };
}

function nearestAcceptedAfter(nodes, failureNode, correctionNode) {
  const anchor = correctionNode || failureNode;
  const later = nodes
    .filter((n) => n.status !== 'abandoned' && n.id !== failureNode.id && afterFailure(n, anchor))
    .filter((n) => !correctionNode || n.id !== correctionNode.id);
  if (!later.length) return null;
  later.sort((a, b) => (tsOf(a) ?? Infinity) - (tsOf(b) ?? Infinity));
  const semantic = later.find((n) => sharesEvidence(failureNode, n));
  return semantic || later[0];
}

function nearestCorrectionAfter(nodes, failureNode) {
  const later = nodes.filter(
    (n) => n.status !== 'abandoned' && n.kind === 'correction' && n.id !== failureNode.id && afterFailure(n, failureNode)
  );
  if (!later.length) return null;
  later.sort((a, b) => (tsOf(a) ?? Infinity) - (tsOf(b) ?? Infinity));
  const semantic = later.find((n) => sharesEvidence(failureNode, n));
  return semantic || later[0];
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
  return 'instruction_following_regression';
}

function evalTaskFor(type) {
  if (type === 'security_or_privacy_risk') return 'Continue development while preserving privacy and redaction boundaries.';
  if (type === 'scope_drift') return 'Continue development without drifting outside the corrected scope.';
  if (type === 'format_violation') return 'Continue development while preserving the requested output format.';
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
