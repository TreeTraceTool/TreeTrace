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
  lines.push(
    'This report leads with concrete failure classes from the session. It reuses the same signals as the full TreeTrace analysis; it does not run a separate scanner.'
  );
  lines.push('');

  const anySignal =
    f.surfaces.size || f.testSkips.length || f.riskyCommands.length || f.securitySignals.length || f.hallucinationResult.hallucinations.length;
  if (!anySignal) {
    lines.push('No security-sensitive touches, test changes, risky commands, hallucinated references, or stated security intents were detected in this session.');
    lines.push('');
    footer(lines, opts);
    return lines.join('\n');
  }

  lines.push('## 1. Did the agent touch security-sensitive surfaces?');
  lines.push('');
  if (f.surfaces.size) {
    lines.push('Yes. Touched surfaces, with the files involved:');
    lines.push('');
    for (const surface of SURFACE_ORDER) {
      const touches = f.surfaces.get(surface);
      if (!touches || !touches.length) continue;
      const files = [...new Set(touches.map((t) => t.file))].slice(0, 8);
      lines.push(`- ${SURFACE_LABELS[surface]}: ${files.map((x) => `\`${escapeMd(truncate(x, 100))}\``).join(', ')}`);
    }
  } else {
    lines.push('No edits to auth, secrets, access control, crypto, dependency config, CI, deployment, or test files were observed in the captured actions.');
  }
  if (f.securitySignals.length) {
    lines.push('');
    lines.push('Security signals from the analysis pass (highest tier first):');
    lines.push('');
    for (const s of f.securitySignals.slice(0, 12)) {
      const tag = s.tier === 'inferred' ? 'stated intent' : s.tier;
      lines.push(`- (${tag}) ${escapeMd(truncate(s.evidence, EVIDENCE_CAP))}${s.model ? ` (${s.model})` : ''}`);
    }
  }
  lines.push('');

  lines.push('## 2. Did the agent disable or skip tests?');
  lines.push('');
  if (f.testSkips.length) {
    lines.push('Possible test removal or skipping was detected. Verify before trusting the suite:');
    lines.push('');
    for (const t of f.testSkips.slice(0, 8)) lines.push(`- (${t.nodeId}) ${escapeMd(t.evidence)}`);
  } else {
    lines.push('No evidence of disabled or skipped tests was found in prompts or captured actions.');
  }
  lines.push('');

  lines.push('## 3. Did the agent run risky shell commands?');
  lines.push('');
  if (f.riskyCommands.length) {
    lines.push('Yes. The following commands matched the risky-command patterns:');
    lines.push('');
    for (const r of f.riskyCommands.slice(0, 8)) lines.push(`- (${r.nodeId}) \`${escapeMd(r.command)}\`${r.model ? ` (${r.model})` : ''}`);
  } else {
    lines.push('No commands matched the risky-shell patterns (force pushes without review, recursive deletes, piped remote shells, world-writable chmod, destructive SQL).');
  }
  lines.push('');

  lines.push('## 4. Did the agent reference files, paths, imports, or packages that do not exist?');
  lines.push('');
  if (!f.hallucinationResult.verifiedAgainstWorkingTree) {
    lines.push('Not checked: no readable working tree was available for verification.');
  } else if (f.hallucinationResult.hallucinations.length) {
    lines.push('Yes. The following references could not be verified against the working tree or declared dependencies:');
    lines.push('');
    for (const h of f.hallucinationResult.hallucinations.slice(0, 12)) {
      lines.push(`- (${h.category}) ${escapeMd(truncate(h.evidence, EVIDENCE_CAP))}`);
    }
    lines.push('');
    lines.push('File and path existence and import and package declaration are checked deterministically. Per-symbol or per-API resolution inside a module is not attempted.');
  } else {
    lines.push('No hallucinated files, paths, imports, or packages were detected. File and path existence and import and package declaration were checked against the working tree and manifests.');
  }
  lines.push('');

  lines.push('## 5. What human correction should become a future eval or memory item?');
  lines.push('');
  const securityChains = f.analysis.correctionChains.filter((c) => c.failureType === 'security_or_privacy_risk');
  if (securityChains.length || f.corrections.length) {
    lines.push('Turn these corrections into regression evals so the next agent inherits the constraint:');
    lines.push('');
    const seen = new Set();
    for (const chain of securityChains.slice(0, 6)) {
      const corr = tree.nodes.find((n) => n.id === chain.correctionNodeId);
      if (corr && !seen.has(corr.id)) {
        seen.add(corr.id);
        lines.push(`- (security correction) ${escapeMd(truncate(corr.text.replace(/\s+/g, ' '), 300))}`);
      }
    }
    for (const corr of f.corrections.slice(-6)) {
      if (seen.has(corr.id)) continue;
      seen.add(corr.id);
      lines.push(`- ${escapeMd(truncate(corr.text.replace(/\s+/g, ' '), 300))}`);
    }
    lines.push('');
    lines.push('Eval candidates from the analysis pass live in `.treetrace/evals.jsonl`; hallucination eval candidates live in `.treetrace/hallucinations.json`.');
  } else {
    lines.push('No human correction was linked to a security-sensitive action in this session. If a security touch above was intentional, capture the rationale so the next agent does not flag it again.');
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
