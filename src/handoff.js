import { truncate, escapeMdTags } from './util.js';
import { analyzeTree, isStrategicDirection, latestByTime } from './analyze.js';

export function renderHandoff(tree, opts = {}) {
  const { projectName } = opts;
  const { nodes, stats } = tree;
  const analysis = analyzeTree(tree);
  const lines = [];

  const root = nodes.find((n) => n.kind === 'root') || nodes[0];
  const accepted = nodes.filter((n) => n.status !== 'abandoned');
  const lastCheckpoint = latestByTime(accepted.filter((n) => n.kind === 'checkpoint'));
  const lastAccepted = latestByTime(accepted);

  lines.push(`# Handoff brief: ${escapeMdTags(projectName)}`);
  lines.push(`${stats.promptCount} ${plural(stats.promptCount, 'prompt')} · ${stats.sessionCount} ${plural(stats.sessionCount, 'session')}`);
  lines.push('');

  if (root) {
    lines.push('## Original goal');
    lines.push('');
    lines.push(escapeMdTags(root.text.trim()));
    lines.push('');
  }

  lines.push('## Where things stand');
  lines.push('');
  if (lastCheckpoint) {
    lines.push(`Last checkpoint: ${escapeMdTags(lastCheckpoint.text.trim())}`);
    if (lastAccepted && lastAccepted !== lastCheckpoint) lines.push('');
  }
  if (lastAccepted && lastAccepted !== lastCheckpoint) {
    lines.push(`Most recent accepted direction: ${escapeMdTags(lastAccepted.text.trim())}`);
  }
  lines.push('');

  const decisions = accepted.filter(
    (n) => (n.kind === 'direction' || n.kind === 'scope-change') && isStrategicDirection(n)
  );
  if (decisions.length) {
    lines.push('## Accepted decisions');
    lines.push('');
    decisions.forEach((n, i) => lines.push(`${i + 1}. ${escapeMdTags(truncate(n.text.replace(/\s+/g, ' '), 360))}`));
    lines.push('');
  }

  const corrections = accepted.filter((n) => n.kind === 'correction');
  if (corrections.length) {
    lines.push('## Constraints');
    lines.push('');
    corrections.forEach((n) => lines.push(`- ${escapeMdTags(truncate(n.text.replace(/\s+/g, ' '), 300))}`));
    lines.push('');
  }

  const abandoned = nodes.filter(
    (n) => n.status === 'abandoned' && (!n.parent || n.parent.status !== 'abandoned')
  );
  if (abandoned.length) {
    lines.push('## Dead ends');
    lines.push('');
    abandoned.forEach((n) => lines.push(`- ${escapeMdTags(truncate(n.text.replace(/\s+/g, ' '), 300))}`));
    lines.push('');
  }

  if (analysis.lessons.length) {
    lines.push('## Lessons');
    lines.push('');
    analysis.lessons.slice(0, 6).forEach((lesson) => {
      lines.push(`- ${escapeMdTags(lesson.title)}: ${escapeMdTags(truncate(compactLessonText(lesson.text), 320))}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function plural(count, singular) {
  return count === 1 ? singular : `${singular}s`;
}

function compactLessonText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const evidenceAt = normalized.indexOf('Specifically:');
  return evidenceAt === -1 ? normalized : normalized.slice(evidenceAt + 'Specifically:'.length).trim();
}
