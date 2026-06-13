import { analyzeTree, renderLessonsMarkdown, renderMemoryMarkdown } from './analyze.js';
import { renderHandoff } from './handoff.js';
import { renderMarkdown } from './render-md.js';
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
  lines.push(
    'This is the human-readable rollup. Keep the split `.treetrace/` artifacts for agents, CI, eval harnesses, and other tools.'
  );
  lines.push('');

  lines.push('## Read order');
  lines.push('');
  lines.push('1. `TREETRACE_REPORT.md` - human rollup and terminal-friendly report.');
  lines.push('2. `PROMPT_TREE.md` - detailed prompt lineage and reusable prompt pack.');
  lines.push('3. `.treetrace/lessons.md` - reusable correction memory.');
  lines.push('4. `.treetrace/agent-memory.md` - compact memory for the next coding agent.');
  lines.push('5. `.treetrace/tree.json`, `failures.json`, and `evals.jsonl` - machine-readable data.');
  lines.push('');

  lines.push('## Session summary');
  lines.push('');
  const { promptCount, rawPromptCount } = tree.stats;
  const foldedTurns = (rawPromptCount || promptCount) - promptCount;
  lines.push(
    foldedTurns > 0
      ? `- Prompts: ${promptCount} (merged from ${rawPromptCount} raw turns; ${foldedTurns} continuation or duplicate turn${foldedTurns === 1 ? '' : 's'} folded in)`
      : `- Prompts: ${promptCount}`
  );
  lines.push(`- Sessions: ${tree.stats.sessionCount}`);
  if (tree.stats.days) lines.push(`- Active span: ${plural(tree.stats.days, 'day')}`);
  if (tree.stats.corrections) lines.push(`- Corrections: ${tree.stats.corrections}`);
  if (tree.stats.abandonedBranches) lines.push(`- Abandoned branches: ${tree.stats.abandonedBranches}`);
  if (tree.stats.toolUses) lines.push(`- Tool calls: ${tree.stats.toolUses.toLocaleString()}`);
  if (tree.stats.filesTouched) lines.push(`- Files touched: ${tree.stats.filesTouched}`);
  const tc = analysis.summary.tierCounts || { verified: 0, high: 0, confirmed: 0, inferred: 0 };
  lines.push(
    `- Failure signals: ${analysis.summary.totalFailureSignals} (verified ${tc.verified}, high ${tc.high || 0}, confirmed ${tc.confirmed}, inferred ${tc.inferred})`
  );
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
  lines.push('| File | Use it for |');
  lines.push('|------|------------|');
  lines.push('| `TREETRACE_REPORT.md` | Human review, terminal output, quick context. |');
  lines.push('| `PROMPT_TREE.md` | Full lineage narrative and replayable prompt pack. |');
  lines.push('| `.treetrace/tree.json` | Canonical schema for tools and integrations. |');
  lines.push('| `.treetrace/failures.json` | Failure labels, evidence, correction chains. |');
  lines.push('| `.treetrace/lessons.md` | Human-readable lessons. |');
  lines.push('| `.treetrace/evals.jsonl` | Eval/regression cases; not meant to be pretty. |');
  lines.push('| `.treetrace/agent-memory.md` | Short memory pack for Codex, Claude Code, Cursor, or another agent. |');
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
      lines.push(`- ${failure.id} (${failure.type}, ${meta}): ${escapeMd(failure.summary)}`);
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
    lines.push('Every time an agent touched auth, secrets, or access control in this session:');
    lines.push('');
    for (const f of securityTrail.slice(0, 12)) {
      const tag = f.tier === 'inferred' ? 'stated intent' : f.tier;
      lines.push(`- (${tag}) ${escapeMd(f.evidence)}${f.model ? ` (${f.model})` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Handoff brief');
  lines.push('');
  lines.push(demoteHeadings(stripTitle(renderHandoff(tree, opts)), 2));
  lines.push('');

  lines.push('## Agent memory');
  lines.push('');
  lines.push(demoteHeadings(stripTitle(renderMemoryMarkdown(tree, opts)), 2));
  lines.push('');

  lines.push('## Lessons');
  lines.push('');
  lines.push(demoteHeadings(stripTitle(renderLessonsMarkdown(tree, opts)), 2));
  lines.push('');

  lines.push('## Prompt tree');
  lines.push('');
  lines.push(demoteHeadings(stripTitle(renderMarkdown(tree, { ...opts, titlesOnly: opts.titlesOnly })), 2));
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`Generated by [treetrace](${REPO_URL}).`);
  lines.push('');

  return lines.join('\n');
}

export function renderTerminalSummary(tree, opts = {}) {
  const projectName = opts.projectName || 'project';
  const analysis = analyzeTree(tree);
  const accepted = tree.nodes.filter((n) => n.status !== 'abandoned');
  const lastAccepted = accepted.at(-1);
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

function stripTitle(markdown) {
  return markdown.replace(/^# .*(?:\r?\n){1,2}/, '').trim();
}

function demoteHeadings(markdown, levels) {
  return markdown.replace(/^(#{1,5}) /gm, (m, hashes) => `${hashes}${'#'.repeat(levels)} `);
}

function confidencePct(confidence) {
  return `${Math.round(confidence * 100)}%`;
}
