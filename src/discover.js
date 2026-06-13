import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export function mungePath(absPath) {
  return absPath.replace(/[^A-Za-z0-9-]/g, '-');
}

const CWD_PROBE_BYTES = 65536;
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export function recordedCwd(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(CWD_PROBE_BYTES);
    const bytes = readSync(fd, buf, 0, CWD_PROBE_BYTES, 0);
    const head = buf.toString('utf8', 0, bytes);
    const m = head.match(CWD_RE);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {

      }
    }
  }
}

export function claudeProjectsRoot() {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : join(homedir(), '.claude', 'projects');
}

export function discoverSessions(projectDir) {
  const root = claudeProjectsRoot();
  if (!existsSync(root)) return [];

  const abs = resolve(projectDir);
  const exact = mungePath(abs);
  const prefix = mungePath(abs + sep);

  const sessions = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== exact && !entry.name.startsWith(prefix)) continue;
    const dir = join(root, entry.name);
    for (const f of readdirSync(dir, { withFileTypes: true })) {

      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const path = join(dir, f.name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const cwd = recordedCwd(path);
      if (cwd && resolve(cwd) !== abs) continue;
      sessions.push({
        path,
        sessionId: f.name.replace(/\.jsonl$/, ''),
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        storageDir: entry.name,
      });
    }
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return sessions;
}
