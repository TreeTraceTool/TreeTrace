import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, normalize } from 'node:path';
import { truncate } from './util.js';

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

const PY_STDLIB = new Set([
  'os', 'sys', 're', 'json', 'math', 'random', 'datetime', 'time', 'collections', 'itertools',
  'functools', 'typing', 'pathlib', 'subprocess', 'logging', 'argparse', 'unittest', 'asyncio',
  'io', 'abc', 'enum', 'dataclasses', 'copy', 'hashlib', 'base64', 'csv', 'sqlite3', 'socket',
  'threading', 'multiprocessing', 'shutil', 'glob', 'tempfile', 'traceback', 'inspect', 'string',
  'textwrap', 'decimal', 'fractions', 'statistics', 'struct', 'pickle', 'http', 'urllib', 'xml',
  'html', 'email', 'warnings', 'contextlib', 'operator', 'weakref', 'gc', 'platform', 'signal',
]);

const FILE_TOKEN_RE = /(?:[\w@./+-]*\/)?[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b/g;
const REL_PREFIX_RE = /^(?:\.\/|\.\.\/)/;
const URL_LIKE_RE = /:\/\//;
const VERSION_LIKE_RE = /^\d+(?:\.\d+)+$/;
const JS_IMPORT_RE =
  /\b(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"\n]+)['"]|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const PY_IMPORT_RE = /^[ \t]*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm;

const EVIDENCE_CAP = 120;
const MAX_TEXT_SCAN = 20000;

function readPackageNames(projectDir) {
  const names = new Set();
  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (pkg[field] && typeof pkg[field] === 'object') {
          for (const name of Object.keys(pkg[field])) names.add(name);
        }
      }
    } catch {

    }
  }
  return names;
}

function readLockfilePackages(projectDir) {
  const names = new Set();
  const lockPath = join(projectDir, 'package-lock.json');
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (lock.packages && typeof lock.packages === 'object') {
        for (const key of Object.keys(lock.packages)) {
          const idx = key.lastIndexOf('node_modules/');
          if (idx >= 0) names.add(key.slice(idx + 'node_modules/'.length));
        }
      }
      if (lock.dependencies && typeof lock.dependencies === 'object') {
        for (const name of Object.keys(lock.dependencies)) names.add(name);
      }
    } catch {

    }
  }
  return names;
}

function readPyRequirements(projectDir) {
  const names = new Set();
  for (const file of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
    const p = join(projectDir, file);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/^[ \t]*['"]?([A-Za-z][\w.-]+)['"]?\s*(?:[=<>~!]=?|@|\s*=\s*)/gm)) {
        names.add(m[1].toLowerCase());
      }
    } catch {

    }
  }
  return names;
}

function packageRoot(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.slice(0, 2).join('/');
  }
  return spec.split('/')[0];
}

function collectCreatedFiles(tree) {
  const created = new Set();
  for (const node of tree.nodes) {
    for (const a of node.actions || []) {
      if (!a.file || typeof a.file !== 'string') continue;
      if (a.tool === 'Write' || a.tool === 'Edit' || a.tool === 'NotebookEdit') {
        created.add(normalizeFileKey(a.file));
      }
    }
  }
  return created;
}

function normalizeFileKey(p) {
  return p.replace(/^\.?\//, '').replace(/\\/g, '/').toLowerCase();
}

function looksLikeFileToken(tok) {
  if (tok.length < 3 || tok.length > 200) return false;
  if (URL_LIKE_RE.test(tok)) return false;
  if (VERSION_LIKE_RE.test(tok)) return false;
  const ext = tok.slice(tok.lastIndexOf('.') + 1).toLowerCase();
  if (!ext || ext.length > 10) return false;
  return true;
}

function fileExists(projectDir, rel) {
  const clean = rel.replace(/^\.\//, '');
  let target;
  if (isAbsolute(clean)) {
    target = clean;
  } else {
    target = resolve(projectDir, clean);
  }
  try {
    if (existsSync(target)) return true;
  } catch {

  }
  const base = clean.split('/').pop();
  return globByBasename(projectDir, base, target);
}

function globByBasename(projectDir, base, fullCandidate) {
  try {
    const direct = join(projectDir, base);
    if (existsSync(direct) && statSync(direct).isFile()) return true;
  } catch {

  }
  return false;
}

function collectFileReferences(tree) {
  const refs = [];
  const seen = new Set();
  const push = (raw, nodeId) => {
    const tok = raw.trim().replace(/^['"`(]+|['"`),.;:]+$/g, '');
    if (!looksLikeFileToken(tok)) return;
    const key = normalizeFileKey(tok);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ token: tok, key, nodeId });
  };
  for (const node of tree.nodes) {
    if (node.status === 'abandoned') continue;
    const text = String(node.text || '').slice(0, MAX_TEXT_SCAN);
    for (const m of text.matchAll(FILE_TOKEN_RE)) push(m[0], node.id);
    for (const a of node.actions || []) {
      const body = `${a.input || ''}`.slice(0, MAX_TEXT_SCAN);
      for (const m of body.matchAll(FILE_TOKEN_RE)) push(m[0], node.id);
    }
  }
  return refs;
}

function collectImportReferences(tree) {
  const refs = [];
  const seen = new Set();
  const push = (spec, lang, nodeId) => {
    if (!spec) return;
    const root = packageRoot(spec);
    if (!root) return;
    const key = `${lang}:${root}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ spec: root, lang, nodeId });
  };
  for (const node of tree.nodes) {
    if (node.status === 'abandoned') continue;
    const sources = [String(node.text || '')];
    for (const a of node.actions || []) {
      if (a.input) sources.push(String(a.input));
      if (a.command) sources.push(String(a.command));
    }
    for (const src of sources) {
      const text = src.slice(0, MAX_TEXT_SCAN);
      for (const m of text.matchAll(JS_IMPORT_RE)) push(m[1] || m[2] || m[3], 'js', node.id);
      for (const m of text.matchAll(PY_IMPORT_RE)) {
        if (m[1]) push(m[1], 'py', node.id);
        if (m[2]) for (const piece of m[2].split(',')) push(piece.trim(), 'py', node.id);
      }
    }
  }
  return refs;
}

function isRelativeOrLocalSpec(spec) {
  return REL_PREFIX_RE.test(spec) || spec.startsWith('/') || spec.startsWith('node:');
}

export function detectHallucinations(tree, projectDir, opts = {}) {
  const hallucinations = [];
  if (!projectDir || !existsSync(projectDir)) {
    return { schemaVersion: '0.2', verifiedAgainstWorkingTree: false, hallucinations, summary: emptySummary() };
  }

  const created = collectCreatedFiles(tree);
  const pkgNames = readPackageNames(projectDir);
  const lockNames = readLockfilePackages(projectDir);
  const pyNames = readPyRequirements(projectDir);
  const hasManifest = pkgNames.size > 0 || lockNames.size > 0 || pyNames.size > 0;

  for (const ref of collectFileReferences(tree)) {
    if (created.has(ref.key)) continue;
    if (REL_PREFIX_RE.test(ref.token)) continue;
    if (fileExists(projectDir, ref.token)) continue;
    hallucinations.push({
      category: 'hallucinated_file_or_path',
      reference: truncate(ref.token, EVIDENCE_CAP),
      nodeId: ref.nodeId,
      evidence: `Referenced "${truncate(ref.token, EVIDENCE_CAP)}" which does not exist in the working tree and was not created during the session.`,
      evalCandidate: {
        type: 'reference_existence_check',
        task: 'Verify a file or path exists in the working tree before editing or relying on it.',
        target: truncate(ref.token, EVIDENCE_CAP),
      },
    });
  }

  for (const ref of collectImportReferences(tree)) {
    if (isRelativeOrLocalSpec(ref.spec)) continue;
    if (ref.lang === 'js') {
      if (NODE_BUILTINS.has(ref.spec) || NODE_BUILTINS.has(ref.spec.replace(/^node:/, ''))) continue;
      if (pkgNames.has(ref.spec) || lockNames.has(ref.spec)) continue;
      if (!hasManifest) continue;
    } else {
      if (PY_STDLIB.has(ref.spec)) continue;
      if (pyNames.has(ref.spec.toLowerCase())) continue;
      if (pyNames.size === 0) continue;
    }
    hallucinations.push({
      category: 'hallucinated_import_or_package',
      reference: truncate(ref.spec, EVIDENCE_CAP),
      nodeId: ref.nodeId,
      evidence: `Imported "${truncate(ref.spec, EVIDENCE_CAP)}" (${ref.lang}) which is not a declared dependency or a standard-library module.`,
      evalCandidate: {
        type: 'import_existence_check',
        task: 'Verify an import or package is declared as a dependency before relying on it.',
        target: truncate(ref.spec, EVIDENCE_CAP),
      },
    });
  }

  return {
    schemaVersion: '0.2',
    verifiedAgainstWorkingTree: true,
    manifestSeen: hasManifest,
    hallucinations,
    summary: summarize(hallucinations),
  };
}

function emptySummary() {
  return { total: 0, byCategory: { hallucinated_file_or_path: 0, hallucinated_import_or_package: 0 } };
}

function summarize(hallucinations) {
  const summary = emptySummary();
  summary.total = hallucinations.length;
  for (const h of hallucinations) {
    if (summary.byCategory[h.category] !== undefined) summary.byCategory[h.category]++;
  }
  return summary;
}

export function renderHallucinationsJson(tree, projectDir, opts = {}) {
  const result = detectHallucinations(tree, projectDir, opts);
  return {
    schemaVersion: '0.2',
    project: { name: opts.projectName || null, generatedAt: opts.generatedAt || null },
    verifiedAgainstWorkingTree: result.verifiedAgainstWorkingTree,
    manifestSeen: result.manifestSeen || false,
    summary: result.summary,
    hallucinations: result.hallucinations,
    note: 'File and path existence and import and package declaration are checked deterministically against the working tree and manifests. Per-symbol and per-API resolution inside a module is not attempted.',
  };
}
