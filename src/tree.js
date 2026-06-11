import { daySpan } from './util.js';

/**
 * Build the lineage tree from classified prompt nodes + session topology.
 *
 * Claude Code records form a DAG via parentUuid: rewinds and forks create
 * real branches. The "main path" of a session is the ancestor chain of its
 * final record; prompts off that chain were abandoned (rewound away).
 */
export function buildTree(sessions, nodes) {
  const byUuid = new Map();
  for (const node of nodes) if (node.uuid) byUuid.set(node.uuid, node);

  // Per-session main-path sets (uuids of records that "made it" to the end).
  // The last `last-prompt` record's leafUuid is the authoritative live-branch
  // tip; the last addressable record is the fallback.
  const mainPaths = new Map();
  for (const session of sessions) {
    const main = new Set();
    let cur =
      (session.activeLeafUuid && session.index.has(session.activeLeafUuid)
        ? session.activeLeafUuid
        : session.leafUuid) || null;
    let guard = 0;
    while (cur && guard++ < 1_000_000) {
      main.add(cur);
      cur = session.index.get(cur)?.parentUuid || null;
    }
    mainPaths.set(session.sessionId, main);
  }

  // Parent resolution: walk up the record chain to the nearest prompt node.
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));
  for (const node of nodes) {
    node.parent = null;
    if (!node.uuid) continue;
    const session = sessionById.get(node.sessionId);
    if (!session) continue;
    let cur = node.parentUuid;
    let guard = 0;
    while (cur && guard++ < 1_000_000) {
      const hit = byUuid.get(cur);
      if (hit) {
        node.parent = hit;
        break;
      }
      cur = session.index.get(cur)?.parentUuid || null;
    }
  }

  // Session ordering by first activity, then chain sessions together:
  // the first parentless node of a session hangs off the previous session's
  // last main-path node.
  const ordered = [...sessions].sort((a, b) =>
    String(a.firstTs || '').localeCompare(String(b.firstTs || ''))
  );
  const nodesBySession = new Map();
  for (const node of nodes) {
    if (!nodesBySession.has(node.sessionId)) nodesBySession.set(node.sessionId, []);
    nodesBySession.get(node.sessionId).push(node);
  }

  let prevTail = null;
  for (const session of ordered) {
    const sNodes = nodesBySession.get(session.sessionId) || [];
    if (!sNodes.length) continue;
    for (const node of sNodes) {
      if (!node.parent && node !== sNodes[0]) {
        // orphan mid-session (uuid chain broken) — chain linearly
        node.parent = sNodes[sNodes.indexOf(node) - 1];
      }
    }
    if (!sNodes[0].parent && prevTail) {
      sNodes[0].parent = prevTail;
      sNodes[0].sessionBoundary = true;
    } else if (!sNodes[0].parent) {
      sNodes[0].sessionBoundary = true;
    }
    const main = mainPaths.get(session.sessionId) || new Set();
    const tail = [...sNodes].reverse().find((n) => !n.uuid || main.has(n.uuid));
    prevTail = tail || sNodes[sNodes.length - 1];
  }

  // Status: a prompt is abandoned only if it sits on a dead side-branch of a
  // REAL fork — i.e. walking up its record chain reaches a node that IS on the
  // session's main path while the prompt itself is not. parentUuid chains can
  // reset mid-file (bridge events, compaction); a broken chain is not a fork,
  // so prompts above a break stay accepted.
  for (const node of nodes) {
    if (!node.uuid) continue;
    const main = mainPaths.get(node.sessionId);
    const session = sessionById.get(node.sessionId);
    if (!main || !main.size || !session || main.has(node.uuid)) continue;
    let cur = node.parentUuid;
    let guard = 0;
    while (cur && guard++ < 1_000_000) {
      if (main.has(cur)) {
        node.status = 'abandoned';
        break;
      }
      cur = session.index.get(cur)?.parentUuid || null;
    }
  }

  // ids + children
  nodes.forEach((n, i) => {
    n.id = `node_${String(i + 1).padStart(3, '0')}`;
    n.children = [];
  });
  const roots = [];
  for (const node of nodes) {
    if (node.parent) node.parent.children.push(node);
    else roots.push(node);
  }

  return { roots, nodes, sessions: ordered, stats: computeStats(ordered, nodes) };
}

function computeStats(sessions, nodes) {
  const byKind = {};
  for (const node of nodes) byKind[node.kind] = (byKind[node.kind] || 0) + 1;

  const abandonedRoots = nodes.filter(
    (n) => n.status === 'abandoned' && (!n.parent || n.parent.status !== 'abandoned')
  );

  const models = new Set();
  const filesTouched = new Set();
  let toolUses = 0;
  let interruptions = 0;
  const timestamps = [];
  for (const s of sessions) {
    for (const m of s.stats.models) models.add(m);
    for (const f of s.stats.filesTouched) filesTouched.add(f);
    toolUses += s.stats.toolUses;
    interruptions += s.stats.interruptions;
    if (s.firstTs) timestamps.push(s.firstTs);
    if (s.lastTs) timestamps.push(s.lastTs);
  }

  return {
    promptCount: nodes.length,
    sessionCount: sessions.filter((s) => s.prompts.length).length,
    byKind,
    corrections: byKind['correction'] || 0,
    scopeChanges: byKind['scope-change'] || 0,
    checkpoints: byKind['checkpoint'] || 0,
    abandonedBranches: abandonedRoots.length,
    nudges: nodes.reduce((acc, n) => acc + n.nudges, 0),
    interruptions,
    toolUses,
    filesTouched: filesTouched.size,
    models: [...models],
    days: daySpan(timestamps),
    firstTs: timestamps.length ? timestamps.slice().sort()[0] : null,
    lastTs: timestamps.length ? timestamps.slice().sort().at(-1) : null,
  };
}
