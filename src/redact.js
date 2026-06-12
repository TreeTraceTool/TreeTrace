import { createInterface } from 'node:readline/promises';
import { sha256, shannonEntropy, truncate, c } from './util.js';

/**
 * Secret/PII scanner + export gate.
 *
 * Philosophy: NOTHING leaves un-reviewed. In a TTY the user resolves every
 * unique hit (redact / keep / edit). Outside a TTY every hit is redacted
 * automatically — the tool fails closed, never open. After rendering, the
 * final artifact is shadow-scanned again; an unresolved high/medium hit at
 * that stage aborts the write.
 *
 * Rules are curated for precision (gitleaks-style provider formats) plus a
 * high-entropy fallback. False negatives are existential for a privacy tool,
 * false positives merely cost a keystroke — when in doubt, flag.
 */

export const RULES = [
  // ---- high: unambiguous secret formats ----
  { id: 'private-key-block', severity: 'high', re: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----|$)/g },
  { id: 'aws-access-key', severity: 'high', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', severity: 'high', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-fine-grained', severity: 'high', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'gitlab-token', severity: 'high', re: /\bglpat-[0-9a-zA-Z_-]{20,}\b/g },
  { id: 'anthropic-key', severity: 'high', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', severity: 'high', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', severity: 'high', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { id: 'stripe-live-key', severity: 'high', re: /\b[sr]k_live_[0-9a-zA-Z]{10,}\b/g },
  { id: 'npm-token', severity: 'high', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'tailscale-key', severity: 'high', re: /\btskey-[a-zA-Z0-9-]{10,}\b/g },
  { id: 'google-api-key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'sendgrid-key', severity: 'high', re: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/g },
  { id: 'twilio-key', severity: 'high', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { id: 'telegram-bot-token', severity: 'high', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{32,33}\b/g },
  { id: 'discord-webhook', severity: 'high', re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g },
  { id: 'jwt', severity: 'high', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },

  // ---- medium: context-dependent assignments ----
  { id: 'wireguard-key', severity: 'medium', re: /\b(PrivateKey|PresharedKey)\s*=\s*[A-Za-z0-9+/]{42,44}=?/g },
  { id: 'url-basic-auth', severity: 'medium', re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"`]{2,}:[^/\s@'"`]{2,}@[^\s'"`]+/gi },
  { id: 'bearer-header', severity: 'medium', re: /\bBearer\s+[A-Za-z0-9._+/=-]{20,}\b/g },
  { id: 'secret-assignment', severity: 'medium', re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*(?!(?:['"]?\s*)?(?:\$\{|<|%|\*{3}|\.{3}|REDACTED|xxx+|placeholder|changeme|example|your[-_]))(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s'"`,;]{8,})/gi },

  // ---- soft: PII and context the user may want to keep ----
  { id: 'email', severity: 'soft', re: /\b[A-Za-z0-9._%+-]+@(?!(?:users\.noreply\.github\.com|example\.(?:com|org)))[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: 'ipv4', severity: 'soft', re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b(?!\.\d)/g },
  { id: 'home-dir-username', severity: 'soft', re: /(?:\/(?:home|Users)\/|C:\\Users\\)([A-Za-z][A-Za-z0-9._-]{2,30})\b/g },
];

const HEX_RE = /^[0-9a-fA-F]+$/;
const ENTROPY_CANDIDATE_RE = /\b[A-Za-z0-9+/_=-]{32,}\b/g;
const VERSION_LIKE_RE = /^\d+[.\d-]*$/;
const JOIN_SEPARATOR_RE = /[\s\u200B-\u200D\uFEFF]/;
const JOINED_SCAN_RULE_IDS = new Set([
  'aws-access-key',
  'github-token',
  'github-fine-grained',
  'gitlab-token',
  'anthropic-key',
  'openai-key',
  'slack-token',
  'stripe-live-key',
  'npm-token',
  'tailscale-key',
  'google-api-key',
  'sendgrid-key',
  'twilio-key',
  'telegram-bot-token',
  'jwt',
]);

export function scanText(text) {
  const findings = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        match: m[0],
        index: m.index,
      });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }

  // High-entropy fallback: long mixed-charset tokens that no provider rule
  // caught. Pure hex (git SHAs, digests) and uuids excluded — too noisy.
  const seenSpans = findings.map((f) => [f.index, f.index + f.match.length]);
  ENTROPY_CANDIDATE_RE.lastIndex = 0;
  let m;
  while ((m = ENTROPY_CANDIDATE_RE.exec(text)) !== null) {
    const tok = m[0];
    if (HEX_RE.test(tok) || VERSION_LIKE_RE.test(tok)) continue;
    if (!/[A-Z]/.test(tok) || !/[a-z]/.test(tok) || !/[0-9]/.test(tok)) continue;
    if (shannonEntropy(tok) < 4.4) continue;
    const start = m.index;
    if (seenSpans.some(([s, e]) => start >= s && start < e)) continue;
    findings.push({ ruleId: 'high-entropy-token', severity: 'medium', match: tok, index: start });
  }

  findings.push(...scanJoinedProviderTokens(text, findings));
  return findings;
}

function scanJoinedProviderTokens(text, existing) {
  const chars = [];
  const indexMap = [];
  for (let i = 0; i < text.length; i++) {
    if (JOIN_SEPARATOR_RE.test(text[i])) continue;
    chars.push(text[i]);
    indexMap.push(i);
  }
  if (chars.length === text.length) return [];

  const joined = chars.join('');
  const existingSpans = existing.map((f) => [f.index, f.index + f.match.length]);
  const findings = [];
  for (const rule of RULES) {
    if (!JOINED_SCAN_RULE_IDS.has(rule.id)) continue;
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(joined)) !== null) {
      const start = indexMap[m.index];
      const end = indexMap[m.index + m[0].length - 1] + 1;
      const original = text.slice(start, end);
      if (!JOIN_SEPARATOR_RE.test(original)) continue;
      if (original.length - m[0].length > 20) continue;
      if (existingSpans.some(([s, e]) => start >= s && start < e)) continue;
      findings.push({ ruleId: rule.id, severity: rule.severity, match: original, index: start });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
    }
  }
  return findings;
}

export function maskFor(finding) {
  return `[REDACTED:${finding.ruleId}]`;
}

/**
 * Resolve findings into decisions, keyed by sha256(match).
 * decision = { action: 'redact'|'keep', replacement, ruleId }
 */
export async function resolveFindings(findings, priorDecisions, { interactive, autoRedact }) {
  const decisions = { ...priorDecisions };
  const unique = new Map(); // hash -> { finding, count }
  for (const f of findings) {
    const h = sha256(f.match);
    if (!unique.has(h)) unique.set(h, { finding: f, count: 0 });
    unique.get(h).count++;
  }

  const unresolved = [...unique.entries()].filter(([h]) => !decisions[h]);
  if (!unresolved.length) return { decisions, asked: 0 };

  if (!interactive || autoRedact) {
    for (const [h, { finding }] of unresolved) {
      decisions[h] = { action: 'redact', replacement: maskFor(finding), ruleId: finding.ruleId };
    }
    return { decisions, asked: 0, autoRedacted: unresolved.length };
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(
    `\n${c.bold(`${unresolved.length} potential secret${unresolved.length === 1 ? '' : 's'} found`)} — nothing is exported until each is resolved.\n\n`
  );
  let i = 0;
  for (const [h, { finding, count }] of unresolved) {
    i++;
    const sev =
      finding.severity === 'high' ? c.red(finding.severity)
      : finding.severity === 'medium' ? c.yellow(finding.severity)
      : c.gray(finding.severity);
    process.stderr.write(
      `${c.dim(`[${i}/${unresolved.length}]`)} ${sev} ${c.bold(finding.ruleId)} ×${count}\n    ${c.cyan(truncate(finding.match, 72))}\n`
    );
    let answer;
    for (;;) {
      answer = (await rl.question(`    ${c.bold('[r]')}edact  ${c.bold('[k]')}eep  ${c.bold('[e]')}dit replacement › `))
        .trim()
        .toLowerCase();
      if (['r', 'k', 'e', 'redact', 'keep', 'edit', ''].includes(answer)) break;
    }
    if (answer === 'k' || answer === 'keep') {
      decisions[h] = { action: 'keep', ruleId: finding.ruleId };
    } else if (answer === 'e' || answer === 'edit') {
      const replacement = (await rl.question('    replacement text › ')).trim() || maskFor(finding);
      decisions[h] = { action: 'redact', replacement, ruleId: finding.ruleId };
    } else {
      decisions[h] = { action: 'redact', replacement: maskFor(finding), ruleId: finding.ruleId };
    }
  }
  rl.close();
  return { decisions, asked: unresolved.length };
}

/**
 * Apply redaction decisions to text. Decisions are keyed by sha256(match) and
 * deliberately never store the secret itself (the persisted decision file must
 * be safe to commit); the raw strings come from this run's findings.
 */
export function applyDecisions(text, findings, decisions) {
  const toRedact = new Map(); // original -> replacement
  for (const f of findings) {
    const d = decisions[sha256(f.match)];
    if (d && d.action === 'redact') {
      toRedact.set(f.match, d.replacement || maskFor(f));
    }
  }
  let out = text;
  // Longest matches first so substrings of larger secrets don't pre-empt them.
  for (const [original, replacement] of [...toRedact.entries()].sort(
    (a, b) => b[0].length - a[0].length
  )) {
    out = out.split(original).join(replacement);
  }
  return out;
}

/**
 * Shadow scan: run after rendering. Any high/medium finding that is not an
 * explicit "keep" means the gate failed — abort, never write.
 */
export function shadowScan(renderedText, decisions) {
  const leaks = [];
  for (const f of scanText(renderedText)) {
    if (f.severity === 'soft') continue;
    const d = decisions[sha256(f.match)];
    if (d && d.action === 'keep') continue;
    if (f.match.startsWith('[REDACTED:')) continue;
    leaks.push(f);
  }
  return leaks;
}
