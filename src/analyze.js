import { truncate } from './util.js';

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
const SCOPE_DRIFT_HINT = /\b(don'?t add|do not add|not a web app|keep it local|too much|overbuilt|scope drift|stay focused|same format|keep .* cli|zero-config cli)\b/i;
const TOOL_HINT = /\b(wrong tool|wrong library|use .* instead|don'?t use|dependency|package|environment|node version|python version|missing module)\b/i;
const HALLUCINATION_HINT = /\b(hallucinat|doesn'?t exist|does not exist|no such file|fake file|fake api|made up)\b/i;
const REPEATED_FIX_HINT = /\b(still failing|still broken|again|same error|didn'?t fix|doesn'?t fix|keeps? failing)\b/i;
const UNDERBUILT_HINT = /\b(underbuilt|missing|not enough|too bare|incomplete|you skipped|you missed)\b/i;
const FORMAT_HINT = /\b(format|json|markdown|schema|same structure|exact output|invalid)\b/i;

export function analyzeTree(tree) {
  if (tree.analysis) return tree.analysis;

  for (const node of tree.nodes) {
    node.failureSignals = [];
    node.evalCandidate = false;
    node.lessonIds = [];
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
    if (correctionChains.some((c) => c.failureNodeId === failureNode.id && c.correctionNodeId === correctionNode.id)) {
      return;
    }
    correctionChains.push({
      id: `chain_${pad(correctionChains.length + 1)}`,
      failureNodeId: failureNode.id,
      correctionNodeId: correctionNode.id,
      resolvedNodeId: resolvedNode?.id || null,
      failureType: type,
      confidence: confidenceLabel(confidence),
      summary,
    });
  };

  const addFailure = ({ type, confidence, failureNode, correctionNode, resolvedNode, evidence, summary }) => {
    if (!FAILURE_TYPES.has(type) || !failureNode) return null;
    if (correctionNode && correctionNode.id === failureNode.id) correctionNode = null;

    const ids = uniq([failureNode.id, correctionNode?.id, resolvedNode?.id]);
    const key = `${type}:${failureNode.id}`;
    const existing = failureByKey.get(key);
    if (existing) {
      if (confidence > existing.confidence) existing.confidence = confidence;
      const lr = lessonByType.get(type);
      if (lr) lr.nodeIds = uniq([...lr.nodeIds, ...ids]);
      const er = evalByType.get(evalTypeFor(type));
      if (er) er.sourceNodeIds = uniq([...er.sourceNodeIds, ...ids]);
      if (correctionNode && !existing.correctedByNodeId) existing.correctedByNodeId = correctionNode.id;
      linkChain(type, confidence, failureNode, correctionNode, resolvedNode, summary);
      return existing;
    }

    const lesson = lessonFor(type, correctionNode || failureNode);
    let lessonRec = lessonByType.get(type);
    if (!lessonRec) {
      lessonRec = { id: `lesson_${pad(lessons.length + 1)}`, title: lesson.title, nodeIds: ids, text: lesson.text };
      lessons.push(lessonRec);
      lessonByType.set(type, lessonRec);
    } else {
      lessonRec.nodeIds = uniq([...lessonRec.nodeIds, ...ids]);
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
      confidence,
      evidence,
      resolvedBy: correctionNode?.id || resolvedNode?.id || null,
    });
    failureNode.evalCandidate = true;
    failureNode.lessonIds.push(lessonRec.id);

    const failure = {
      id: `failure_${pad(failures.length + 1)}`,
      type,
      confidence,
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
    if (node.status === 'abandoned') {
      addFailure({
        type: 'abandoned_path',
        confidence: 0.9,
        failureNode: node,
        resolvedNode: nearestAcceptedAfter(tree.nodes, index),
        evidence: `Branch abandoned after prompt: "${quote(node.text)}"`,
        summary: `A side path was abandoned: ${truncate(node.title, 120)}`,
      });
      return;
    }

    const shouldAnalyze =
      node.kind === 'correction' ||
      CORRECTION_HINT.test(node.text) ||
      FRUSTRATION_HINT.test(node.text) ||
      PRIVACY_HINT.test(node.text);
    if (!shouldAnalyze) return;

    const priorNode = nearestFailureTarget(node, tree.nodes, index);
    const failureNode = priorNode || node;
    const correctionNode = priorNode ? node : null;
    const resolvedNode = nearestAcceptedAfter(tree.nodes, index);
    const signals = inferSignals(node);

    for (const signal of signals) {
      addFailure({
        type: signal.type,
        confidence: signal.confidence,
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
    lines.push(`## ${i + 1}. ${lesson.title}`);
    lines.push('');
    lines.push(lesson.text);
    lines.push('');
    lines.push(`Source nodes: ${lesson.nodeIds.join(', ')}`);
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
  const lines = [`# TreeTrace Agent Memory`, ''];
  lines.push(`Project: ${projectName}`);
  lines.push('');
  lines.push('## Durable project constraints');
  lines.push('');
  lines.push('- Keep the project local-first and privacy-first.');
  lines.push('- Treat the structured outputs as the core product.');
  lines.push('- Keep the human-readable report as one artifact among several.');
  lines.push('');
  lines.push('');
  lines.push('## Lessons from this lineage');
  lines.push('');
  if (analysis.lessons.length) {
    for (const lesson of analysis.lessons.slice(0, 8)) lines.push(`- ${lesson.text}`);
  } else {
    lines.push('- No high-confidence failure lessons were detected yet.');
  }
  lines.push('');
  lines.push('## Known bad paths');
  lines.push('');
  const badPaths = analysis.failures.filter((f) => f.type === 'abandoned_path').slice(0, 6);
  if (badPaths.length) {
    for (const failure of badPaths) lines.push(`- ${failure.summary}`);
  } else {
    lines.push('');
    lines.push('- Do not narrow the project to only a README generator.');
  }
  lines.push('');
  lines.push('## Preferred next work');
  lines.push('');
  lines.push('- Improve the failure-signal heuristics with real fixtures.');
  lines.push('- Add a compare mode for baseline and candidate exports.');
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

function inferSignals(node) {
  const text = node.text;
  const signals = [];
  const push = (type, confidence) => {
    if (!signals.some((s) => s.type === type)) signals.push({ type, confidence });
  };

  if (SCOPE_DRIFT_HINT.test(text)) push('scope_drift', 0.82);
  if (/\b(i said|you forgot|you ignored|not what i (asked|wanted|meant)|asked for)\b/i.test(text)) {
    push('ignored_constraint', 0.84);
  }
  if (TOOL_HINT.test(text)) push('dependency_or_environment_mismatch', 0.72);
  if (/\bwrong tool|wrong library|use .* instead\b/i.test(text)) push('wrong_tool_choice', 0.78);
  if (HALLUCINATION_HINT.test(text)) push('hallucinated_file_or_api', 0.82);
  if (REPEATED_FIX_HINT.test(text)) push('repeated_failed_fix', 0.8);
  if (/\btoo much|overbuilt|scrap .* web app|too heavy\b/i.test(text)) push('overbuilt_solution', 0.78);
  if (UNDERBUILT_HINT.test(text)) push('underbuilt_solution', 0.76);
  if (PRIVACY_HINT.test(text)) push('security_or_privacy_risk', 0.7);
  if (FORMAT_HINT.test(text)) push('format_violation', 0.68);
  if (FRUSTRATION_HINT.test(text)) push('user_frustration', 0.72);
  if (!signals.length && node.kind === 'correction') push('misunderstood_goal', 0.62);

  return signals.slice(0, 3);
}

function nearestFailureTarget(node, nodes, index) {
  if (node.parent && node.parent.status !== 'abandoned' && node.parent.id !== node.id) return node.parent;
  for (let i = index - 1; i >= 0; i--) {
    if (nodes[i].status !== 'abandoned' && nodes[i].id !== node.id) return nodes[i];
  }
  return null;
}

function nearestAcceptedAfter(nodes, index) {
  for (let i = index + 1; i < nodes.length; i++) {
    if (nodes[i].status !== 'abandoned') return nodes[i];
  }
  return null;
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

function lessonFor(type, node) {
  const prompt = truncate(node?.text || '', 180);
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
  const text = {
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
  return {
    title: titles[type] || 'Preserve the correction',
    text: `${text[type] || 'Future agents should preserve this correction.'}${prompt ? ` Evidence: "${prompt}"` : ''}`,
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
