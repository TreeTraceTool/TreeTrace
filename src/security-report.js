import { truncate, escapeMd } from './util.js';
import { analyzeTree, classifySecuritySurface, isRiskyCommand, mentionsTestSkip } from './analyze.js';
import { detectHallucinations } from './hallucinate.js';
import { REPO_URL } from './config.js';

const SURFACE_LABELS = {
  auth: 'auth',
  secrets: 'secrets',
  'access-control': 'access control',
  crypto: 'crypto',
  'dependency-config': 'dependency config',
  ci: 'CI',
  deployment: 'deployment',
  tests: 'tests',
};
const SURFACE_ORDER = ['auth', 'secrets', 'access-control', 'crypto', 'dependency-config', 'ci', 'deployment', 'tests'];
const EVIDENCE_CAP = 200;
const tierRank = { verified: 4, high: 3, confirmed: 2, inferred: 1 };

function collectSurfaceTouches(tree) {
  const bySurface = new Map();
  for (const node of tree.nodes) {
    if (node.status === 'abandoned') continue;
    for (const a of node.actions || []) {
      const surface = classifySecuritySurface(a.file);
      if (!surface) continue;
      if (!bySurface.has(surface)) bySurface.set(surface, []);
      bySurface.get(surface).push({ file: a.file, nodeId: node.id, model: a.model || node.model || null });
    }
  }
  return bySurface;
}

function collectTestSkips(tree) {
  const out = [];
  for (const node of tree.nodes) {
    if (node.status === 'abandoned') continue;
    if (mentionsTestSkip(node.text)) {
      out.push({ nodeId: node.id, evidence: truncate(node.text, EVIDENCE_CAP) });
      continue;
    }
    for (const a of node.actions || []) {
      const body = a.input || a.command || '';
      if (mentionsTestSkip(body)) {
        out.push({ nodeId: node.id, evidence: truncate(body, EVIDENCE_CAP) });
        break;
      }
    }
  }
  return out;
}

function collectRiskyCommands(tree) {
  const out = [];
  for (const node of tree.nodes) {
    if (node.status === 'abandoned') continue;
    for (const a of node.actions || []) {
      if (isRiskyCommand(a.command)) {
        out.push({ nodeId: node.id, command: truncate(a.command, EVIDENCE_CAP), model: a.model || node.model || null });
      }
    }
  }
  return out;
}

function collectCorrections(tree) {
  return tree.nodes.filter((n) => n.status !== 'abandoned' && n.kind === 'correction');
}

export function buildSecurityFindings(tree, projectDir, opts = {}) {
  const analysis = analyzeTree(tree);
  const surfaces = collectSurfaceTouches(tree);
  const testSkips = collectTestSkips(tree);
  const riskyCommands = collectRiskyCommands(tree);
  const hallucinationResult = projectDir
    ? detectHallucinations(tree, projectDir, opts)
    : { hallucinations: [], verifiedAgainstWorkingTree: false };
  const securitySignals = analysis.failures
    .filter((f) => f.type === 'security_or_privacy_risk')
    .sort((a, b) => (tierRank[b.tier] || 0) - (tierRank[a.tier] || 0));
  const corrections = collectCorrections(tree);

  return { analysis, surfaces, testSkips, riskyCommands, hallucinationResult, securitySignals, corrections };
}

export function hasSecuritySignal(tree, projectDir, opts = {}) {
  const f = buildSecurityFindings(tree, projectDir, opts);
  return (
    f.surfaces.size > 0 ||
    f.testSkips.length > 0 ||
    f.riskyCommands.length > 0 ||
    f.securitySignals.length > 0 ||
    f.hallucinationResult.hallucinations.length > 0
  );
}

export function renderSecurityReport(tree, projectDir, opts = {}) {
  const projectName = opts.projectName || 'project';
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const f = buildSecurityFindings(tree, projectDir, opts);
  const lines = [];

  lines.push(`# TreeTrace Security Report - ${escapeMd(projectName)}`);
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');

  const anySignal =
    f.surfaces.size || f.testSkips.length || f.riskyCommands.length || f.securitySignals.length || f.hallucinationResult.hallucinations.length;
  if (!anySignal) {
    lines.push('None detected.');
    lines.push('');
    footer(lines, opts);
    return lines.join('\n');
  }

  lines.push('## Surfaces touched');
  lines.push('');
  if (f.surfaces.size) {
    for (const surface of SURFACE_ORDER) {
      const touches = f.surfaces.get(surface);
      if (!touches || !touches.length) continue;
      const files = [...new Set(touches.map((t) => t.file))].slice(0, 8);
      const nodeIds = [...new Set(touches.map((t) => t.nodeId).filter(Boolean))].slice(0, 8);
      const ids = nodeIds.length ? ` [${nodeIds.join(', ')}]` : '';
      lines.push(`- ${SURFACE_LABELS[surface]}: ${files.map((x) => `\`${escapeMd(truncate(x, 100))}\``).join(', ')}${ids}`);
    }
  } else {
    lines.push('None detected.');
  }
  if (f.securitySignals.length) {
    lines.push('');
    lines.push('## Security signals (highest tier first)');
    lines.push('');
    for (const s of f.securitySignals.slice(0, 12)) {
      const tag = s.tier === 'inferred' ? 'stated intent' : s.tier;
      const nodeId = s.firstSeenNodeId ? ` [${s.firstSeenNodeId}]` : '';
      lines.push(`- (${tag})${nodeId} ${escapeMd(truncate(s.evidence, EVIDENCE_CAP))}${s.model ? ` (${s.model})` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Test skips');
  lines.push('');
  if (f.testSkips.length) {
    for (const t of f.testSkips.slice(0, 8)) lines.push(`- (${t.nodeId}) ${escapeMd(t.evidence)}`);
  } else {
    lines.push('None detected.');
  }
  lines.push('');

  lines.push('## Risky shell commands');
  lines.push('');
  if (f.riskyCommands.length) {
    for (const r of f.riskyCommands.slice(0, 8)) lines.push(`- (${r.nodeId}) \`${escapeMd(r.command)}\`${r.model ? ` (${r.model})` : ''}`);
  } else {
    lines.push('None detected.');
  }
  lines.push('');

  lines.push('## Hallucinated references');
  lines.push('');
  if (!f.hallucinationResult.verifiedAgainstWorkingTree) {
    lines.push('Working tree not available for verification.');
  } else if (f.hallucinationResult.hallucinations.length) {
    for (const h of f.hallucinationResult.hallucinations.slice(0, 12)) {
      const nodeId = h.nodeId ? ` [${h.nodeId}]` : '';
      lines.push(`- (${h.category})${nodeId} ${escapeMd(truncate(h.evidence, EVIDENCE_CAP))}`);
    }
  } else {
    lines.push('None detected.');
  }
  lines.push('');

  lines.push('## Corrections to promote');
  lines.push('');
  const securityChains = f.analysis.correctionChains.filter((c) => c.failureType === 'security_or_privacy_risk');
  if (securityChains.length || f.corrections.length) {
    const seen = new Set();
    for (const chain of securityChains.slice(0, 6)) {
      const corr = tree.nodes.find((n) => n.id === chain.correctionNodeId);
      if (corr && !seen.has(corr.id)) {
        seen.add(corr.id);
        lines.push(`- (${corr.id}) ${escapeMd(truncate(corr.text.replace(/\s+/g, ' '), 300))}`);
      }
    }
    for (const corr of f.corrections.slice(-6)) {
      if (seen.has(corr.id)) continue;
      seen.add(corr.id);
      lines.push(`- (${corr.id}) ${escapeMd(truncate(corr.text.replace(/\s+/g, ' '), 300))}`);
    }
    lines.push('');
    lines.push('→ Eval candidates: .treetrace/evals.jsonl · .treetrace/hallucinations.json');
  } else {
    lines.push('None. If a security touch above was intentional, log the rationale.');
  }
  lines.push('');

  footer(lines, opts);
  return lines.join('\n');
}

function footer(lines, opts) {
  lines.push('---');
  lines.push('');
  lines.push(`Generated by [treetrace](${REPO_URL})${opts.version ? ` v${opts.version}` : ''}.`);
  lines.push('');
}
