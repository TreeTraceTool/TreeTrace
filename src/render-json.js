import { REPO_URL } from './config.js';

/**
 * Machine-readable export: treetrace lineage schema v0.1.
 * Documented in SCHEMA.md with a mapping to the Agent Trace RFC.
 */

const RELATIONSHIP_BY_KIND = {
  direction: 'refines',
  correction: 'corrects',
  'scope-change': 'expands',
  checkpoint: 'checkpoints',
  question: 'asks',
  root: 'refines',
};

export function renderJson(tree, opts = {}) {
  const { projectName, generatedBy = 'treetrace', version = '0.1.0' } = opts;
  const { nodes, sessions, stats } = tree;

  return {
    schemaVersion: '0.1',
    generator: { name: generatedBy, version, url: REPO_URL },
    project: {
      name: projectName,
      generatedAt: opts.generatedAt || null,
      sourceType: 'claude-code-jsonl',
    },
    stats: {
      prompts: stats.promptCount,
      sessions: stats.sessionCount,
      days: stats.days,
      corrections: stats.corrections,
      scopeChanges: stats.scopeChanges,
      checkpoints: stats.checkpoints,
      abandonedBranches: stats.abandonedBranches,
      toolUses: stats.toolUses,
      filesTouched: stats.filesTouched,
      models: stats.models,
      firstTs: stats.firstTs,
      lastTs: stats.lastTs,
    },
    sessions: sessions
      .filter((s) => s.prompts.length)
      .map((s) => ({
        id: s.sessionId,
        title: s.title,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        promptCount: s.prompts.length,
        isContinuation: s.isContinuation,
      })),
    nodes: nodes.map((n) => ({
      id: n.id,
      parentId: n.parent ? n.parent.id : null,
      role: 'user',
      kind: n.kind,
      title: n.title,
      text: n.text,
      status: n.status,
      nudges: n.nudges || 0,
      reruns: n.reruns || 0,
      session: n.sessionId,
      timestamp: n.ts,
      // source linkage for audit: the original record uuid inside the local
      // session transcript (raw transcripts themselves are never exported)
      sourceEventIds: n.uuid ? [n.uuid] : [],
    })),
    edges: nodes
      .filter((n) => n.parent)
      .map((n) => ({
        from: n.parent.id,
        to: n.id,
        relationship: RELATIONSHIP_BY_KIND[n.kind] || 'refines',
      })),
  };
}
