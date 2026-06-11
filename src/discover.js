import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// Claude Code stores sessions under ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl
// where <munged-cwd> is the absolute project path with every non [A-Za-z0-9-]
// character replaced by "-" (case preserved). e.g. /home/dev/weatherapp -> -home-dev-weatherapp
export function mungePath(absPath) {
  return absPath.replace(/[^A-Za-z0-9-]/g, '-');
}

export function claudeProjectsRoot() {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : join(homedir(), '.claude', 'projects');
}

/**
 * Find Claude Code session files relevant to a project directory.
 *
 * A session "belongs" to the project if it was started from the project dir
 * itself OR any directory beneath it (Claude Code keys storage by exact cwd,
 * so a repo worked on from two subdirs produces two storage dirs).
 *
 * Returns [{ path, sessionId, sizeBytes, mtimeMs, storageDir }] sorted by mtime.
 */
export function discoverSessions(projectDir) {
  const root = claudeProjectsRoot();
  if (!existsSync(root)) return [];

  const abs = resolve(projectDir);
  const exact = mungePath(abs);
  const prefix = mungePath(abs + sep); // children share this prefix

  const sessions = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== exact && !entry.name.startsWith(prefix)) continue;
    const dir = join(root, entry.name);
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      // top-level session files only; subdirectories hold subagent/sidechain
      // transcripts which are agent-to-agent, not human lineage
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
