import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export function mungePath(absPath) {
  return absPath.replace(/[^A-Za-z0-9-]/g, '-');
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
