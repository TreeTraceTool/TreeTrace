import { truncate, escapeMd } from './util.js';
import { analyzeTree, isStrategicDirection } from './analyze.js';

export function renderHandoff(tree, opts = {}) {
  const { projectName } = opts;
  const { nodes, stats } = tree;
  const analysis = analyzeTree(tree);
  const lines = [];

  const root = nodes.find((n) => n.kind === 'root') || nodes[0];
  const accepted = nodes.filter((n) => n.status !== 'abandoned');
  const lastCheckpoint = [...accepted].reverse().find((n) => n.kind === 'checkpoint');
  const lastAccepted = accepted.at(-1);

  lines.push(`# Handoff brief: ${escapeMd(projectName)}`);
  lines.push('');
  lines.push(
    `You are taking over an AI-assisted project. This brief was distilled from the real prompt lineage (${stats.promptCount} prompts, ${stats.sessionCount} sessions). Read it fully before acting.`
  );
  lines.push('');

  if (root) {
    lines.push('## Original goal');
    lines.push('');
    lines.push(escapeMd(root.text.trim()));
    lines.push('');
  }

  lines.push('## Where things stand');
  lines.push('');
  if (lastCheckpoint) {
    lines.push(`Last checkpoint: ${escapeMd(lastCheckpoint.text.trim())}`);
  }
  if (lastAccepted && lastAccepted !== lastCheckpoint) {
    lines.push('');
    lines.push(`Most recent accepted direction: ${escapeMd(lastAccepted.text.trim())}`);
  }
  lines.push('');

  const decisions = accepted.filter(
    (n) => (n.kind === 'direction' || n.kind === 'scope-change') && isStrategicDirection(n)
  );
  if (decisions.length) {
    lines.push('## Accepted decisions (in order)');
    lines.push('');
    decisions.forEach((n, i) => lines.push(`${i + 1}. ${escapeMd(truncate(n.text.replace(/\s+/g, ' '), 360))}`));
    lines.push('');
  }

  const corrections = accepted.filter((n) => n.kind === 'correction');
  if (corrections.length) {
    lines.push('## Constraints learned the hard way');
    lines.push('');
    lines.push('These corrections were issued during the build. Do not repeat the mistakes they fixed:');
    lines.push('');
    corrections.forEach((n) => lines.push(`- ${escapeMd(truncate(n.text.replace(/\s+/g, ' '), 300))}`));
    lines.push('');
  }

  const abandoned = nodes.filter(
    (n) => n.status === 'abandoned' && (!n.parent || n.parent.status !== 'abandoned')
  );
  if (abandoned.length) {
    lines.push('## Known dead ends');
    lines.push('');
    lines.push('These approaches were tried and abandoned. Avoid unless told otherwise:');
    lines.push('');
    abandoned.forEach((n) => lines.push(`- ${escapeMd(truncate(n.text.replace(/\s+/g, ' '), 300))}`));
    lines.push('');
  }

  if (analysis.lessons.length) {
    lines.push('## Agent memory lessons');
    lines.push('');
    analysis.lessons.slice(0, 6).forEach((lesson) => {
      lines.push(`- ${escapeMd(truncate(lesson.text.replace(/\s+/g, ' '), 320))}`);
    });
    lines.push('');
  }

  lines.push('## First task');
  lines.push('');
  lines.push(
    'Confirm you understand the goal, the accepted decisions, and the constraints above, then ask the user what to tackle next (or continue the most recent accepted direction if instructed to proceed autonomously).'
  );
  lines.push('');

  return lines.join('\n');
}
