import { analyzeTree, latestByTime, renderRejectionsJson } from './analyze.js';
import { plural, truncate, escapeMd } from './util.js';
import { REPO_URL } from './config.js';

export function renderReportMarkdown(tree, opts = {}) {
  const projectName = opts.projectName || 'project';
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const analysis = analyzeTree(tree);
  const lines = [];

  lines.push(`# TreeTrace Report - ${escapeMd(projectName)}`);
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');

  lines.push('## Session summary');
  lines.push('');
  const { promptCount, rawPromptCount } = tree.stats;
  const foldedTurns = (rawPromptCount || promptCount) - promptCount;
  const tc = analysis.summary.tierCounts || { verified: 0, high: 0, confirmed: 0, inferred: 0 };
  const promptPart =
    foldedTurns > 0
      ? `Prompts: ${promptCount} (from ${rawPromptCount} raw turns)`
      : `Prompts: ${promptCount}`;
  const sessionParts = [
    promptPart,
    `Sessions: ${tree.stats.sessionCount}`,
    tree.stats.days ? `Span: ${plural(tree.stats.days, 'day')}` : null,
    tree.stats.toolUses ? `Tool calls: ${tree.stats.toolUses.toLocaleString()}` : null,
    tree.stats.filesTouched ? `Files touched: ${tree.stats.filesTouched}` : null,
  ].filter(Boolean);
  lines.push(`- ${sessionParts.join('  ')}`);
  lines.push(
    `- Failure signals: ${analysis.summary.totalFailureSignals} (verified ${tc.verified}, high ${tc.high || 0}, confirmed ${tc.confirmed}, inferred ${tc.inferred})`
  );
  if (tree.stats.corrections) lines.push(`- Corrections: ${tree.stats.corrections}`);
  if (tree.stats.abandonedBranches) lines.push(`- Abandoned branches: ${tree.stats.abandonedBranches}`);
  if (tree.stats.rejections) {
    const byKind = tree.stats.rejectionsByKind || {};
    const breakdown = Object.entries(byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
      .join(', ');
    lines.push(`- Rejections: ${tree.stats.rejections}${breakdown ? ` (${breakdown})` : ''}`);
  }
  if (analysis.summary.models && analysis.summary.models.length) {
    lines.push(`- Models seen: ${analysis.summary.models.join(', ')}`);
  }
  if (analysis.summary.thinkingBlocks) {
    lines.push(`- Reasoning blocks captured: ${analysis.summary.thinkingBlocks}`);
  }
  lines.push(`- Eval candidates: ${analysis.summary.evalCandidates}`);
  lines.push(`- Lessons: ${analysis.summary.lessons}`);
  lines.push('');

  lines.push('## Output map');
  lines.push('');
  lines.push('| File | Purpose |');
  lines.push('|------|---------|');
  lines.push('| `TREETRACE_REPORT.md` | this file |');
  lines.push('| `PROMPT_TREE.md` | prompt lineage + replay pack |');
  lines.push('| `.treetrace/tree.json` | canonical schema |');
  lines.push('| `.treetrace/failures.json` | labels + correction chains |');
  lines.push('| `.treetrace/rejections.json` | typed rejections/refusals/declines (v0.3) |');
  lines.push('| `.treetrace/hallucinations.json` | unresolved references |');
  lines.push('| `.treetrace/lessons.md` | correction memory |');
  lines.push('| `.treetrace/evals.jsonl` | regression eval cases |');
  lines.push('| `.treetrace/agent-memory.md` | next-agent memory pack |');
  lines.push('');

  if (analysis.failures.length) {
    lines.push('## Failure signals');
    lines.push('');
    for (const { type, count } of analysis.summary.topFailureTypes) {
      lines.push(`- ${type}: ${count}`);
    }
    lines.push('');
    for (const failure of analysis.failures.slice(0, 8)) {
      const meta = [failure.tier, confidencePct(failure.confidence), failure.model].filter(Boolean).join(', ');
      const nodeId = failure.firstSeenNodeId ? ` [${failure.firstSeenNodeId}]` : '';
      const evidence = failure.evidence ? ` Evidence: ${escapeMd(truncate(failure.evidence, 180))}` : '';
      lines.push(`- ${failure.id}${nodeId} (${failure.type}, ${meta}): ${escapeMd(failure.summary)}${evidence}`);
    }
    if (analysis.failures.length > 8) {
      lines.push(`- ... ${analysis.failures.length - 8} more in .treetrace/failures.json`);
    }
    lines.push('');
  }

  const securityTrail = analysis.failures.filter((f) => f.type === 'security_or_privacy_risk');
  if (securityTrail.length) {
    const rank = { verified: 4, high: 3, confirmed: 2, inferred: 1 };
    securityTrail.sort((a, b) => (rank[b.tier] || 0) - (rank[a.tier] || 0));
    lines.push('## Security audit trail');
    lines.push('');
    for (const f of securityTrail.slice(0, 12)) {
      const tag = f.tier === 'inferred' ? 'stated intent' : f.tier;
      const nodeId = f.firstSeenNodeId ? ` [${f.firstSeenNodeId}]` : '';
      lines.push(`- (${tag})${nodeId} ${escapeMd(f.evidence)}${f.model ? ` (${f.model})` : ''}`);
    }
    lines.push('');
  }

  const rejectionsView = renderRejectionsJson(tree, opts);
  if (rejectionsView.summary.total) {
    lines.push('## Rejections');
    lines.push('');
    lines.push('Typed rejection / refusal / decline events captured on the session. Each one is also surfaced as a failure signal of the mapped type.');
    lines.push('');
    const byKind = rejectionsView.summary.byKind || {};
    const breakdown = Object.entries(byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k.replace(/_/g, ' ')} (${v})`)
      .join(', ');
    lines.push(`- Total: ${rejectionsView.summary.total}${breakdown ? ` — ${breakdown}` : ''}`);
    lines.push('');
    for (const r of rejectionsView.rejections.slice(0, 12)) {
      const nodeId = r.nodeId ? ` [${r.nodeId}]` : '';
      const pct = `${Math.round((r.confidence || 0) * 100)}%`;
      const ev = r.evidence ? ` — ${escapeMd(truncate(r.evidence, 160))}` : '';
      lines.push(`- (${r.kind}, ${pct})${nodeId}${ev}`);
    }
    if (rejectionsView.rejections.length > 12) {
      lines.push(`- ... ${rejectionsView.rejections.length - 12} more in .treetrace/rejections.json`);
    }
    lines.push('');
  }

  lines.push('## Artifacts');
  lines.push('');
  lines.push('See: `PROMPT_TREE.md` · `.treetrace/lessons.md` · `.treetrace/agent-memory.md` · handoff: run `treetrace --handoff`');

  lines.push('---');
  lines.push(`Generated by [treetrace](${REPO_URL})${opts.version ? ` v${opts.version}` : ''}.`);
  lines.push('');

  return lines.join('\n');
}

export function renderTerminalSummary(tree, opts = {}) {
  const projectName = opts.projectName || 'project';
  const analysis = analyzeTree(tree);
  const accepted = tree.nodes.filter((n) => n.status !== 'abandoned');
  const lastAccepted = latestByTime(accepted);
  const lines = [];

  lines.push(`TreeTrace summary - ${projectName}`);
  lines.push('');
  lines.push(
    `${plural(tree.stats.promptCount, 'prompt')} across ${plural(tree.stats.sessionCount, 'session')} ` +
      `| ${analysis.summary.totalFailureSignals} failure signals ` +
      `| ${analysis.summary.lessons} lessons ` +
      `| ${analysis.summary.evalCandidates} eval candidates`
  );
  if (lastAccepted) {
    lines.push('');
    lines.push(`Latest accepted direction: ${truncate(lastAccepted.text.replace(/\s+/g, ' '), 280)}`);
  }
  if (analysis.lessons.length) {
    lines.push('');
    lines.push('Top lessons:');
    for (const lesson of analysis.lessons.slice(0, 3)) {
      lines.push(`- ${truncate(lesson.text.replace(/\s+/g, ' '), 240)}`);
    }
  }
  lines.push('');
  lines.push('Human report: TREETRACE_REPORT.md');
  lines.push('Stream it in the terminal with: treetrace --report');
  lines.push('');

  return lines.join('\n');
}

function confidencePct(confidence) {
  return `${Math.round(confidence * 100)}%`;
}
