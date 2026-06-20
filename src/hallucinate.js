import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { truncate } from './util.js';
import { SCHEMA_VERSION } from './config.js';

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

const KNOWN_FILE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'd.ts',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'clj', 'cljs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'swift', 'php', 'cs',
  'lua', 'pl', 'pm', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hrl', 'elm', 'hs',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'vue', 'svelte', 'astro',
  'md', 'mdx', 'markdown', 'rst', 'txt', 'csv', 'tsv', 'sql', 'graphql', 'gql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'dockerfile', 'lock', 'gradle',
  'gitignore', 'gitattributes', 'npmrc', 'nvmrc', 'editorconfig', 'eslintrc', 'prettierrc',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'proto', 'tf', 'tfvars',
]);

const AMBIGUOUS_BARE_EXTENSIONS = new Set(['env']);

const KNOWN_EXTENSIONLESS_FILES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', 'licence', 'notice', 'changelog',
  'authors', 'contributing', 'codeowners', 'procfile', 'rakefile', 'gemfile',
  'pipfile', 'brewfile', 'vagrantfile', 'jenkinsfile', 'gnumakefile',
  '.env', '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.editorconfig',
  '.dockerignore', '.eslintrc', '.prettierrc', '.babelrc', '.bashrc', '.zshrc',
]);

const FILE_TOKEN_RE = /(?:[\w@./+-]*\/)?[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b/g;
const PATHISH_TOKEN_RE = /(?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+\/?/g;
const BAREWORD_TOKEN_RE = /(?:^|[\s'"`([{])(\.?[A-Za-z][\w.-]*)(?=$|[\s'"`)\]},.;:])/g;
const REL_PREFIX_RE = /^(?:\.\/|\.\.\/)/;
const URL_LIKE_RE = /:\/\//;
const VERSION_LIKE_RE = /^\d+(?:\.\d+)+$/;
const FILE_OP_VERB_RE = /\b(?:open|edit|read|cat|touch|create|write|delete|rm|view|append|chmod|mv|cp|run)\b/i;
// A file-op verb only signals a real path when it IMMEDIATELY governs the token (verb + optional
// determiner, anchored at the end of the preamble). "edit src/foo" / "open the .husky/x" qualify;
// "filter view that lets me compare hotlist/watchlist" does not (the noun "view" is not governing).
const FILE_OP_GOVERNS_RE =
  /\b(?:open|edit|read|cat|touch|create|write|delete|rm|view|append|chmod|mv|cp|run)\s+(?:the\s+|a\s+|an\s+|your\s+|this\s+|that\s+|my\s+|our\s+|its\s+)?(?:new\s+|existing\s+|file\s+|path\s+|module\s+)?["'`(]?$/i;
const RATIO_LIKE_RE = /^\d+\/\d+$/;
const KNOWN_DIR_PREFIXES = new Set([
  'src', 'lib', 'libs', 'test', 'tests', 'spec', 'specs', 'dist', 'build',
  'bin', 'cmd', 'pkg', 'internal', 'app', 'apps', 'api', 'web', 'www',
  'server', 'client', 'common', 'shared', 'utils', 'util', 'helpers',
  'config', 'configs', 'scripts', 'tools', 'docs', 'doc', 'examples',
  'example', 'fixtures', 'mocks', 'stubs', 'public', 'static', 'assets',
  'styles', 'components', 'pages', 'routes', 'models', 'views', 'controllers',
  'services', 'middleware', 'plugins', 'modules', '.github', '.circleci',
]);
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

function collectCreatedFiles(tree, projectDir) {
  const created = new Set();
  for (const node of tree.nodes) {
    for (const a of node.actions || []) {
      if (!a.file || typeof a.file !== 'string') continue;
      if (a.tool === 'Write') {
        created.add(normalizeFileKey(a.file));
      } else if (a.tool === 'Edit' || a.tool === 'NotebookEdit') {
        if (fileExists(projectDir, a.file)) created.add(normalizeFileKey(a.file));
      }
    }
  }
  return created;
}

function normalizeFileKey(p) {
  return p.replace(/^\.?\//, '').replace(/\\/g, '/').toLowerCase();
}

function tokenExtension(tok) {
  const base = tok.split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function hasSlash(tok) {
  return tok.includes('/');
}

function looksLikeFileToken(tok) {
  if (tok.length < 3 || tok.length > 200) return false;
  if (URL_LIKE_RE.test(tok)) return false;
  if (VERSION_LIKE_RE.test(tok)) return false;
  const ext = tokenExtension(tok);
  if (!ext || ext.length > 10) return false;
  if (hasSlash(tok)) return true;
  if (!KNOWN_FILE_EXTENSIONS.has(ext)) return false;
  if (AMBIGUOUS_BARE_EXTENSIONS.has(ext) && !tok.startsWith('.')) return false;
  return true;
}

function hasRealFileSignal(tok, context) {
  if (REL_PREFIX_RE.test(tok)) return true;
  const first = tok.split('/')[0].toLowerCase();
  // A dot-directory prefix (.github/, .husky/, .config/) is almost always a real path, not prose.
  if (first.length > 1 && first.startsWith('.')) return true;
  if (KNOWN_DIR_PREFIXES.has(first)) return true;
  if (FILE_OP_GOVERNS_RE.test(context || '')) return true;
  return false;
}

function looksLikeExtensionlessFile(tok, context) {
  if (tok.length < 3 || tok.length > 200) return false;
  if (URL_LIKE_RE.test(tok)) return false;
  const lower = tok.toLowerCase().replace(/^\.\//, '');
  if (KNOWN_EXTENSIONLESS_FILES.has(lower)) {
    if (lower.startsWith('.')) return true;
    return FILE_OP_GOVERNS_RE.test(context || '');
  }
  if (hasSlash(tok) && !tokenExtension(tok)) {
    if (!(/^(?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+\/?$/.test(tok))) return false;
    if (RATIO_LIKE_RE.test(tok)) return false;
    if (!hasRealFileSignal(tok, context)) return false;
    return true;
  }
  return false;
}

function withinProjectDir(projectDir, target) {
  const root = resolve(projectDir);
  const resolved = resolve(target);
  return resolved === root || resolved.startsWith(root + sep);
}

function resolveInProject(projectDir, rel) {
  const clean = rel.replace(/^\.\//, '');
  const target = isAbsolute(clean) ? clean : resolve(projectDir, clean);
  if (!withinProjectDir(projectDir, target)) return null;
  return target;
}

function fileExists(projectDir, rel) {
  const target = resolveInProject(projectDir, rel);
  if (!target) return true;
  try {
    if (existsSync(target)) return true;
  } catch {

  }
  const base = rel.replace(/^\.\//, '').split('/').pop();
  return globByBasename(projectDir, base);
}

const GLOB_SKIP_DIRS = new Set(['node_modules', '.git', '.treetrace', '.hg', '.svn', 'dist', 'build', 'coverage']);
const GLOB_MAX_DIRS = 4000;

// Bounded recursive search for a file by basename anywhere in the project tree.
// A bare reference like "security.py" should resolve to "core/security.py" if it exists.
function globByBasename(projectDir, base) {
  if (!base) return false;
  let visited = 0;
  const stack = [projectDir];
  while (stack.length) {
    const dir = stack.pop();
    if (++visited > GLOB_MAX_DIRS) return false;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (GLOB_SKIP_DIRS.has(ent.name) || ent.name.startsWith('.git')) continue;
        const child = join(dir, ent.name);
        if (withinProjectDir(projectDir, child)) stack.push(child);
      } else if (ent.isFile() && ent.name === base) {
        return true;
      }
    }
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
  const pushExtensionless = (raw, nodeId, context) => {
    const tok = raw.trim().replace(/^['"`(]+|['"`),.;:]+$/g, '');
    if (tokenExtension(tok) && !KNOWN_EXTENSIONLESS_FILES.has(tok.toLowerCase().replace(/^\.\//, ''))) return;
    if (!looksLikeExtensionlessFile(tok, context)) return;
    const key = normalizeFileKey(tok);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ token: tok, key, nodeId });
  };
  // Local window around a match so a file-op verb only counts as a path signal when it is ADJACENT
  // to the token, not anywhere in the prompt. Prevents one "edit"/"run" from greenlighting every
  // slash-phrase ("hotlist/watchlist") or known bareword ("license") elsewhere in the same prompt.
  const CTX_BEFORE = 40;
  // Preamble: the text immediately BEFORE the token, so FILE_OP_GOVERNS_RE can test whether a
  // file-op verb directly governs this token (end-anchored), not merely appears in the prompt.
  const preamble = (text, tokenStart) => text.slice(Math.max(0, tokenStart - CTX_BEFORE), tokenStart);
  for (const node of tree.nodes) {
    if (node.status === 'abandoned') continue;
    const text = String(node.text || '').slice(0, MAX_TEXT_SCAN);
    for (const m of text.matchAll(FILE_TOKEN_RE)) push(m[0], node.id);
    for (const m of text.matchAll(PATHISH_TOKEN_RE)) pushExtensionless(m[0], node.id, preamble(text, m.index));
    for (const m of text.matchAll(BAREWORD_TOKEN_RE)) {
      pushExtensionless(m[1], node.id, preamble(text, m.index + (m[0].length - m[1].length)));
    }
    for (const a of node.actions || []) {
      const body = `${a.input || ''}`.slice(0, MAX_TEXT_SCAN);
      for (const m of body.matchAll(FILE_TOKEN_RE)) push(m[0], node.id);
      for (const m of body.matchAll(PATHISH_TOKEN_RE)) pushExtensionless(m[0], node.id, preamble(body, m.index));
      // An assistant CLAIM of a file lives in the action narration ("I added the A*
      // implementation in solver/astar.py"), not in node.text or the touched-file set. Scan it for
      // extension-bearing file tokens so a claimed-but-never-created file surfaces. Precision is
      // anchored downstream by the same created/existsSync cross-check that gates every other ref:
      // a narration mention of a file that DOES exist (heuristics.py) or WAS touched (grid.py) is
      // dropped, and prose slash phrases with no extension ("flood/fill") never match FILE_TOKEN_RE.
      if (a.narration && typeof a.narration === 'string') {
        const narr = a.narration.slice(0, MAX_TEXT_SCAN);
        for (const m of narr.matchAll(FILE_TOKEN_RE)) push(m[0], node.id);
      }
      if (a.file && typeof a.file === 'string' &&
          (a.tool === 'Write' || a.tool === 'Edit' || a.tool === 'NotebookEdit')) {
        push(a.file, node.id);
      }
    }
  }
  return refs;
}

function collectImportReferences(tree) {
  const refs = [];
  const seen = new Set();
  const push = (spec, lang, nodeId) => {
    if (!spec) return;
    if (isRelativeOrLocalSpec(spec)) return;
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

// Well-known JS/Python library stems that a dotted token like "cytoscape.js" or "whisper.py"
// references as a LIBRARY, not as a project file. Used only when no manifest is present so a
// dotted library mention is not mistaken for a missing project file.
const WELL_KNOWN_LIBRARY_STEMS = new Set([
  'cytoscape', 'd3', 'three', 'whisper', 'numpy', 'pandas', 'scipy', 'sklearn',
  'tensorflow', 'torch', 'pytorch', 'keras', 'matplotlib', 'seaborn', 'react',
  'vue', 'svelte', 'angular', 'jquery', 'lodash', 'underscore', 'moment', 'axios',
  'express', 'flask', 'django', 'fastapi', 'requests', 'pillow', 'opencv', 'cv2',
  'transformers', 'langchain', 'openai', 'anthropic', 'redux', 'webpack', 'rollup',
  'vite', 'babel', 'eslint', 'prettier', 'jest', 'mocha', 'chai', 'pytest',
  'bootstrap', 'tailwind', 'chartjs', 'plotly', 'leaflet', 'mapbox', 'socketio',
]);

// A single-segment dotted token like "cytoscape.js" or "pandas.py" is frequently a LIBRARY
// reference, not a path to a missing project file. Suppress it when its bare stem matches a declared
// manifest dependency (so "cytoscape.js" with cytoscape in package.json is a lib, not a missing file);
// when no manifest exists, fall back to a curated well-known-library stem set. A token that carries a
// path segment (a slash) or whose stem is not a known library still fires as a real missing file.
function isDeclaredLibraryName(token, pkgNames, lockNames, pyNames) {
  if (hasSlash(token)) return false;
  const base = token.split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const stem = base.slice(0, dot).toLowerCase();
  if (!stem) return false;
  const hasManifest = pkgNames.size > 0 || lockNames.size > 0 || pyNames.size > 0;
  if (hasManifest) {
    for (const name of pkgNames) if (packageRoot(name).toLowerCase() === stem) return true;
    for (const name of lockNames) if (packageRoot(name).toLowerCase() === stem) return true;
    if (pyNames.has(stem)) return true;
    return false;
  }
  return WELL_KNOWN_LIBRARY_STEMS.has(stem);
}

export function detectHallucinations(tree, projectDir, opts = {}) {
  const hallucinations = [];
  if (!projectDir || !existsSync(projectDir)) {
    return { schemaVersion: SCHEMA_VERSION, verifiedAgainstWorkingTree: false, hallucinations, summary: emptySummary() };
  }

  const created = collectCreatedFiles(tree, projectDir);
  const pkgNames = readPackageNames(projectDir);
  const lockNames = readLockfilePackages(projectDir);
  const pyNames = readPyRequirements(projectDir);
  const hasManifest = pkgNames.size > 0 || lockNames.size > 0 || pyNames.size > 0;

  for (const ref of collectFileReferences(tree)) {
    if (created.has(ref.key)) continue;
    if (fileExists(projectDir, ref.token)) continue;
    if (isDeclaredLibraryName(ref.token, pkgNames, lockNames, pyNames)) continue;
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
    schemaVersion: SCHEMA_VERSION,
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
    schemaVersion: SCHEMA_VERSION,
    project: { name: opts.projectName || null, generatedAt: opts.generatedAt || null },
    verifiedAgainstWorkingTree: result.verifiedAgainstWorkingTree,
    manifestSeen: result.manifestSeen || false,
    summary: result.summary,
    hallucinations: result.hallucinations,
    note: 'File and path existence and import and package declaration are checked deterministically against the working tree and manifests. Per-symbol and per-API resolution inside a module is not attempted.',
  };
}
