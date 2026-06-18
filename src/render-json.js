import { REPO_URL, SCHEMA_VERSION } from './config.js';
import { analyzeTree } from './analyze.js';

const RELATIONSHIP_BY_KIND = {
  direction: 'refines',
  correction: 'corrects',
  'scope-change': 'expands',
  checkpoint: 'checkpoints',
  question: 'asks',
  rejection: 'rejects',
  root: 'refines',
};

export function renderJson(tree, opts = {}) {
  const { projectName, generatedBy = 'treetrace', version = '0.1.0', sourceType = 'claude-code-jsonl' } = opts;
  const { nodes, sessions, stats } = tree;
  const analysis = analyzeTree(tree);

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: generatedBy, version, url: REPO_URL },
    project: {
      name: projectName,
      generatedAt: opts.generatedAt || null,
      sourceType,
    },
    stats: {
      prompts: stats.promptCount,
      rawPrompts: stats.rawPromptCount,
      sessions: stats.sessionCount,
      days: stats.days,
      corrections: stats.corrections,
      scopeChanges: stats.scopeChanges,
      checkpoints: stats.checkpoints,
      abandonedBranches: stats.abandonedBranches,
      rejections: stats.rejections || 0,
      rejectionsByKind: stats.rejectionsByKind || {},
      toolUses: stats.toolUses,
      filesTouched: stats.filesTouched,
      models: stats.models,
      firstTs: stats.firstTs,
      lastTs: stats.lastTs,
    },
    analysis: {
      failureSignals: analysis.summary.totalFailureSignals,
      correctionChains: analysis.summary.correctionChains,
      evalCandidates: analysis.summary.evalCandidates,
      lessons: analysis.summary.lessons,
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
      failureSignals: n.failureSignals || [],
      evalCandidate: Boolean(n.evalCandidate),
      lessonIds: n.lessonIds || [],
      rejections: n.rejections || [],

      sourceEventIds: n.uuid ? [n.uuid] : [],
    })),
    edges: nodes
      .filter((n) => n.parent)
      .map((n) => ({
        from: n.parent.id,
        to: n.id,
        relationship: RELATIONSHIP_BY_KIND[n.kind] || 'refines',
      })),
    correctionChains: analysis.correctionChains,
    lessons: analysis.lessons,
    evalCandidates: analysis.evalCandidates,
  };
}
