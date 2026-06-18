import { daySpan } from './util.js';

export function buildTree(sessions, nodes) {
  const byUuid = new Map();
  for (const node of nodes) if (node.uuid) byUuid.set(node.uuid, node);

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
    for (let i = 0; i < sNodes.length; i++) {
      const node = sNodes[i];
      if (!node.parent && i > 0) {
        node.parent = sNodes[i - 1];
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
  let rejections = 0;
  const rejectionsByKind = Object.create(null);
  const timestamps = [];
  for (const s of sessions) {
    for (const m of s.stats.models) models.add(m);
    for (const f of s.stats.filesTouched) filesTouched.add(f);
    toolUses += s.stats.toolUses;
    interruptions += s.stats.interruptions;
    rejections += s.stats.rejections || 0;
    if (s.stats.rejectionsByKind) {
      for (const [k, v] of Object.entries(s.stats.rejectionsByKind)) {
        rejectionsByKind[k] = (rejectionsByKind[k] || 0) + v;
      }
    }
    if (s.firstTs) timestamps.push(s.firstTs);
    if (s.lastTs) timestamps.push(s.lastTs);
  }

  const sortedTs = timestamps.length ? [...timestamps].sort() : [];
  return {
    promptCount: nodes.length,
    rawPromptCount: sessions.reduce((acc, s) => acc + (s.prompts ? s.prompts.length : 0), 0),
    sessionCount: sessions.filter((s) => s.prompts.length).length,
    byKind,
    corrections: byKind['correction'] || 0,
    scopeChanges: byKind['scope-change'] || 0,
    checkpoints: byKind['checkpoint'] || 0,
    rejections,
    rejectionsByKind: { ...rejectionsByKind },
    abandonedBranches: abandonedRoots.length,
    nudges: nodes.reduce((acc, n) => acc + n.nudges, 0),
    interruptions,
    toolUses,
    filesTouched: filesTouched.size,
    models: [...models],
    days: daySpan(timestamps),
    firstTs: sortedTs[0] ?? null,
    lastTs: sortedTs.at(-1) ?? null,
  };
}
