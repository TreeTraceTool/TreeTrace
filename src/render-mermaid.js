import { analyzeTree, isStrategicDirection, latestByTime } from './analyze.js';

// Relationship shown on the edge into each node, keyed by the child's kind. Mirrors
// the relationships emitted in render-json.js so the graph and the JSON agree.
const RELATIONSHIP_BY_KIND = {
  direction: 'refines',
  correction: 'corrects',
  'scope-change': 'expands',
  checkpoint: 'checkpoint',
  question: 'asks',
  root: 'refines',
};

const MAX_LABEL = 60;

// Above this many live (non-abandoned) nodes a full graph stops being legible, so the
// renderer automatically switches to summary mode: spine-only, with abandoned branches
// folded into a single dim stub and routine intermediate runs folded into counts.
const SUMMARY_THRESHOLD = 25;

// Brand init theme: dark Bark canvas, Sapwood text, Canopy edge lines, JetBrains Mono.
// edgeLabelBackground is the opaque Bark canvas color so an edge label occludes the spine
// line behind its glyphs (legible text) while staying visually invisible (no grey box).
// Text and nodes always read in front of the lines.
const INIT =
  "%%{init: {'theme':'base','themeVariables':{" +
  "'background':'#0B1210'," +
  "'primaryColor':'#121A17'," +
  "'primaryTextColor':'#EDF7F2'," +
  "'primaryBorderColor':'#0CA08A'," +
  "'lineColor':'#5BF0B8'," +
  "'tertiaryColor':'#0B1210'," +
  "'edgeLabelBackground':'#0B1210'," +
  "'fontFamily':'JetBrains Mono, ui-monospace, monospace'," +
  "'fontSize':'13px'" +
  "}}}%%";

// classDef block, brand-tuned. Loam surfaces, Sapwood text, teal strokes.
//   spine  = the steered teal progression (Rootstock #0CA08A stroke)
//   goal   = Rootstock root of the trace; result = Canopy #5BF0B8 steered tip
//   failure = amber #F0B86A, STRICTLY for failure / correction-chain flags
//   abandoned = Branch-Dim #34493F dashed, never recolored to an accent
const CLASS_DEFS = [
  'classDef node fill:#121A17,stroke:#243430,color:#EDF7F2;',
  'classDef spine fill:#121A17,stroke:#0CA08A,color:#EDF7F2;',
  'classDef goal fill:#0E1714,stroke:#0CA08A,stroke-width:2px,color:#EDF7F2;',
  'classDef result fill:#0F221C,stroke:#5BF0B8,stroke-width:2.5px,color:#5BF0B8;',
  'classDef failure fill:#1A140C,stroke:#F0B86A,color:#F0B86A;',
  'classDef correction fill:#121A17,stroke:#0CA08A,color:#EDF7F2;',
  'classDef abandoned fill:#0E1411,stroke:#34493F,color:#8FA8A0,stroke-dasharray:3 3;',
];

const KIND_CLASS = {
  root: 'spine',
  direction: 'spine',
  correction: 'correction',
  'scope-change': 'spine',
  question: 'spine',
  checkpoint: 'spine',
};

// Render a tree as a TreeTrace-branded Mermaid `flowchart TD`. The spine is the
// non-abandoned path that reached the result (the "good prompts"); abandoned explorations
// hang off it as dimmed dotted detours. Large projects collapse to a spine-only summary so
// the whole project still reads at a glance. Zero dependencies: pure string assembly.
//
// opts.summary forces summary mode; opts.full forces the full graph. Otherwise the renderer
// switches to summary automatically once the tree exceeds SUMMARY_THRESHOLD live nodes.
export function renderMermaid(tree, opts = {}) {
  const { nodes } = tree;
  const analysis = analyzeTree(tree);

  const root = nodes.find((n) => n.kind === 'root') || nodes[0] || null;
  const result = pickResult(nodes);

  const liveCount = nodes.filter((n) => n.status !== 'abandoned').length;
  const summary = opts.summary === true
    ? true
    : opts.full === true
      ? false
      : liveCount > SUMMARY_THRESHOLD;

  return summary
    ? renderSummary(tree, analysis, root, result)
    : renderFull(tree, analysis, root, result);
}

// Whether a tree of this size renders as a summary under the automatic threshold. Exposed
// so the CLI and tests can describe the behavior without re-deriving the rule.
export function isSummaryByDefault(tree) {
  const live = (tree.nodes || []).filter((n) => n.status !== 'abandoned').length;
  return live > SUMMARY_THRESHOLD;
}

export const SUMMARY_NODE_THRESHOLD = SUMMARY_THRESHOLD;

// -- full graph ----------------------------------------------------------------
function renderFull(tree, analysis, root, result) {
  const { nodes } = tree;
  const lines = [];
  lines.push(INIT);
  lines.push('flowchart TD');
  for (const def of CLASS_DEFS) lines.push(`  ${def}`);
  lines.push('');

  // Node declarations.
  for (const n of nodes) {
    const id = nodeId(n);
    const label = mermaidLabel(nodeText(n, root, result));
    lines.push(`  ${id}${shapeOpen(n, root, result)}"${label}"${shapeClose(n, root, result)}`);
  }
  lines.push('');

  // Tree edges (parent -> child), labelled by relationship. Abandoned edges are dotted.
  for (const n of nodes) {
    if (!n.parent) continue;
    const rel = RELATIONSHIP_BY_KIND[n.kind] || 'refines';
    const abandoned = n.status === 'abandoned';
    const arrow = abandoned ? '-.->' : '-->';
    lines.push(`  ${nodeId(n.parent)} ${arrow}|${rel}| ${nodeId(n)}`);
  }
  lines.push('');

  // Correction-chain overlay: failure -.-> correction, amber, labelled with the failure
  // type + confidence so the diagram carries the real signal, not just topology.
  const chains = analysis.correctionChains || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chainEdges = [];
  const failureIds = new Set();
  for (const chain of chains) {
    const from = byId.get(chain.failureNodeId);
    const to = byId.get(chain.correctionNodeId);
    if (!from || !to || from === to) continue;
    failureIds.add(from.id);
    const conf = confLabel(from);
    const lbl = conf ? `${chain.failureType} ${conf}` : 'fixes';
    chainEdges.push(`  ${nodeId(from)} -.->|"${mermaidLabel(lbl)}"| ${nodeId(to)}`);
  }
  if (chainEdges.length) {
    lines.push('  %% correction chains (failure -> correction), amber flag');
    lines.push(...chainEdges);
    lines.push('');
  }

  // Class assignments. A node can carry several (kind + spine + goal/result + failure).
  const assigns = [];
  for (const n of nodes) {
    const classes = classesFor(n, root, result, failureIds);
    if (classes.length) assigns.push(`  class ${nodeId(n)} ${classes.join(',')};`);
  }
  lines.push(...assigns);
  lines.push('');

  // Amber failure-flag chain edges first (they follow the tree edges in declaration
  // order), then the brighter Canopy spine.
  const treeEdgeCount = nodes.filter((n) => n.parent).length;
  if (chainEdges.length) {
    const chainIdx = chainEdges.map((_, i) => treeEdgeCount + i);
    lines.push(`  linkStyle ${chainIdx.join(',')} stroke:#F0B86A,stroke-width:1.5px;`);
  }
  const spineLinks = spineLinkIndexes(nodes);
  if (spineLinks.length) {
    lines.push(`  linkStyle ${spineLinks.join(',')} stroke:#5BF0B8,stroke-width:2.5px;`);
  }

  return trimTrailing(lines).join('\n');
}

// -- summary graph -------------------------------------------------------------
// "Track the WHOLE project" even when it is large: render the steered spine only, collapse
// each abandoned branch into a single dim "N abandoned steps" stub, keep every failure-
// flagged node, and fold routine intermediate steps (plain direction/checkpoint/question
// runs with no signal) into a single "N steps" stub so the spine stays readable.
function renderSummary(tree, analysis, root, result) {
  const { nodes } = tree;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();
  for (const n of nodes) {
    if (!n.parent) continue;
    const arr = childrenOf.get(n.parent.id) || [];
    arr.push(n);
    childrenOf.set(n.parent.id, arr);
  }

  // Failure-flagged nodes (kept individually so the signal survives collapse).
  const chains = analysis.correctionChains || [];
  const failureIds = new Set();
  const chainTarget = new Map(); // failureId -> { to, type }
  for (const chain of chains) {
    const from = byId.get(chain.failureNodeId);
    const to = byId.get(chain.correctionNodeId);
    if (!from || !to || from === to) continue;
    failureIds.add(from.id);
    chainTarget.set(from.id, { to, type: chain.failureType });
  }

  // A spine node is kept verbatim if it is the goal, the result, a strategic turn
  // (direction/scope-change/correction), or a failure-flagged node. Everything else on the
  // live path is "routine" and gets folded into a count.
  const isKept = (n) =>
    n === root ||
    (result && n === result) ||
    failureIds.has(n.id) ||
    n.kind === 'direction' ||
    n.kind === 'scope-change' ||
    n.kind === 'correction';

  const lines = [];
  lines.push(INIT);
  lines.push('flowchart TD');
  for (const def of CLASS_DEFS) lines.push(`  ${def}`);
  lines.push('');

  const nodeDecls = [];
  const edges = []; // { fromId, toId, rel, dotted, spine }
  const assigns = [];
  const stubAssigns = [];
  let stubSeq = 0;

  const liveChildren = (n) =>
    (childrenOf.get(n.id) || []).filter((c) => c.status !== 'abandoned');
  const abandonedChildren = (n) =>
    (childrenOf.get(n.id) || []).filter((c) => c.status === 'abandoned');

  const emittedNode = new Set();
  const emitNode = (n) => {
    if (emittedNode.has(n.id)) return;
    emittedNode.add(n.id);
    const label = mermaidLabel(nodeText(n, root, result));
    nodeDecls.push(`  ${nodeId(n)}${shapeOpen(n, root, result)}"${label}"${shapeClose(n, root, result)}`);
    const classes = classesFor(n, root, result, failureIds);
    if (classes.length) assigns.push(`  class ${nodeId(n)} ${classes.join(',')};`);
  };

  // Count the whole abandoned subtree hanging off a live node, then emit one dim stub.
  const sizeOfSubtree = (n) => {
    let count = 1;
    for (const c of childrenOf.get(n.id) || []) count += sizeOfSubtree(c);
    return count;
  };
  const emitAbandonedStub = (liveParent) => {
    const roots = abandonedChildren(liveParent);
    if (!roots.length) return;
    let total = 0;
    for (const r of roots) total += sizeOfSubtree(r);
    const stubId = `A${stubSeq++}`;
    const label = `${total} abandoned ${total === 1 ? 'step' : 'steps'}`;
    nodeDecls.push(`  ${stubId}["${label}"]`);
    stubAssigns.push(`  class ${stubId} abandoned;`);
    edges.push({ fromId: nodeId(liveParent), toId: stubId, rel: 'dropped', dotted: true, spine: false });
  };

  emitNode(root);
  emitAbandonedStub(root);

  // Descend the live spine from an anchor. Fold any linear run of routine live nodes into
  // a single "N steps" count stub, then continue from the next kept anchor.
  const visitFrom = (anchor) => {
    const kids = liveChildren(anchor);
    if (!kids.length) return;

    // Partition direct live children into routine vs kept.
    const keptKids = kids.filter((c) => isKept(c));
    const routineKids = kids.filter((c) => !isKept(c));

    // Fold each routine child (and its linear routine continuation) into a count stub.
    for (const start of routineKids) {
      const routine = [];
      let cur = start;
      let keptNext = null;
      while (cur && !isKept(cur)) {
        routine.push(cur);
        emitAbandonedStub(cur);
        const ck = liveChildren(cur);
        const nextKept = ck.find((c) => isKept(c));
        if (nextKept) { keptNext = nextKept; break; }
        cur = ck.length === 1 ? ck[0] : null;
        if (!cur && ck.length > 1) {
          // Multiple routine forks: stop folding here, draw them from this stub.
          break;
        }
      }
      const count = routine.length;
      const stubId = `S${stubSeq++}`;
      const label = `${count} ${count === 1 ? 'step' : 'steps'}`;
      nodeDecls.push(`  ${stubId}["${label}"]`);
      stubAssigns.push(`  class ${stubId} node;`);
      edges.push({ fromId: nodeId(anchor), toId: stubId, rel: 'then', dotted: false, spine: true });
      if (keptNext) {
        emitNode(keptNext);
        emitAbandonedStub(keptNext);
        edges.push({
          fromId: stubId,
          toId: nodeId(keptNext),
          rel: RELATIONSHIP_BY_KIND[keptNext.kind] || 'refines',
          dotted: false,
          spine: true,
        });
        visitFrom(keptNext);
      }
    }

    // Draw kept children directly off the anchor and recurse.
    for (const child of keptKids) {
      emitNode(child);
      emitAbandonedStub(child);
      edges.push({
        fromId: nodeId(anchor),
        toId: nodeId(child),
        rel: RELATIONSHIP_BY_KIND[child.kind] || 'refines',
        dotted: false,
        spine: true,
      });
      visitFrom(child);
    }
  };
  visitFrom(root);

  // Correction-chain overlay among kept failure nodes (amber).
  const chainEdges = [];
  for (const fid of failureIds) {
    const from = byId.get(fid);
    const t = chainTarget.get(fid);
    if (!from || !t || !emittedNode.has(from.id) || !emittedNode.has(t.to.id)) continue;
    const conf = confLabel(from);
    const lbl = conf ? `${t.type} ${conf}` : 'fixes';
    chainEdges.push({ fromId: nodeId(from), toId: nodeId(t.to), label: mermaidLabel(lbl) });
  }

  lines.push(...nodeDecls);
  lines.push('');

  for (const e of edges) {
    const arrow = e.dotted ? '-.->' : '-->';
    lines.push(`  ${e.fromId} ${arrow}|${e.rel}| ${e.toId}`);
  }
  for (const e of chainEdges) {
    lines.push(`  ${e.fromId} -.->|"${e.label}"| ${e.toId}`);
  }
  lines.push('');

  lines.push(...assigns);
  lines.push(...stubAssigns);
  lines.push('');

  // Style amber chain edges (declared after the tree edges) and the Canopy spine.
  if (chainEdges.length) {
    const chainIdx = chainEdges.map((_, i) => edges.length + i);
    lines.push(`  linkStyle ${chainIdx.join(',')} stroke:#F0B86A,stroke-width:1.5px;`);
  }
  const spineIdx = edges.map((e, i) => (e.spine ? i : -1)).filter((i) => i >= 0);
  if (spineIdx.length) {
    lines.push(`  linkStyle ${spineIdx.join(',')} stroke:#5BF0B8,stroke-width:2.5px;`);
  }

  return trimTrailing(lines).join('\n');
}

// -- shared helpers ------------------------------------------------------------
function classesFor(node, root, result, failureIds) {
  if (node.status === 'abandoned') return ['abandoned'];
  const out = [];
  out.push(KIND_CLASS[node.kind] || 'spine');
  if (failureIds && failureIds.has(node.id)) out.push('failure');
  if (node === root) out.push('goal');
  if (result && node === result) out.push('result');
  return out;
}

// Pick the "result": the latest live, strategic forward direction -- the same node the
// agent-memory "Next:" line resolves to. Degrades to the last non-abandoned node, and to
// null if the tree is empty, so the caller can label it neutrally.
function pickResult(nodes) {
  const live = nodes.filter((n) => n.status !== 'abandoned');
  if (!live.length) return null;
  const strategic = live.filter(
    (n) =>
      (n.kind === 'root' || n.kind === 'direction' || n.kind === 'scope-change') &&
      isStrategicDirection(n)
  );
  const latest = latestByTime(strategic);
  if (latest) return latest;
  return live[live.length - 1];
}

function confLabel(node) {
  const sig = (node.failureSignals || [])[0];
  if (!sig || typeof sig.confidence !== 'number') return '';
  return sig.confidence.toFixed(2);
}

function nodeText(node, root, result) {
  let prefix = '';
  if (node === root) prefix = 'GOAL: ';
  else if (result && node === result) prefix = 'RESULT: ';
  return prefix + truncateWord(node.title || node.text || node.id, MAX_LABEL);
}

// Truncate on a WORD boundary so labels never end mid-word ("forecast f..."). Collapse
// whitespace, and if over budget back off to the last full word that fits (leaving room
// for the single-char ellipsis). Falls back to a hard cut only for one long token.
function truncateWord(s, n = MAX_LABEL) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  const budget = n - 1;
  const slice = one.slice(0, budget);
  const lastSpace = slice.lastIndexOf(' ');
  const head = lastSpace > Math.floor(budget * 0.5) ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}

// Stable, Mermaid-safe node id derived from the tree id (node_001 -> N001).
function nodeId(node) {
  const m = /(\d+)\s*$/.exec(String(node.id || ''));
  return m ? `N${m[1]}` : `N_${String(node.id || 'x').replace(/[^A-Za-z0-9_]/g, '')}`;
}

// Escape characters that break Mermaid node labels. Labels are wrapped in double quotes,
// so the main hazards are the quote itself and the HTML-ish chars Mermaid interprets.
function mermaidLabel(text) {
  return String(text == null ? '' : text)
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, '&#39;')
    .replace(/[<]/g, '&lt;')
    .replace(/[>]/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/`/g, '&#96;')
    .replace(/[{}]/g, (m) => (m === '{' ? '&#123;' : '&#125;'))
    .replace(/\s+/g, ' ')
    .trim();
}

// GOAL (root) and RESULT (final) get stadium terminals ([...]) so the trace endpoints
// read as distinct vs. the rectangular intermediate steps. Endpoint terminals win over
// kind-shape (question/checkpoint).
function shapeOpen(node, root, result) {
  if (node === root || (result && node === result)) return '([';
  if (node.kind === 'question') return '{{';
  if (node.kind === 'checkpoint') return '[/';
  return '[';
}
function shapeClose(node, root, result) {
  if (node === root || (result && node === result)) return '])';
  if (node.kind === 'question') return '}}';
  if (node.kind === 'checkpoint') return '/]';
  return ']';
}

// Indexes (0-based, in tree-edge declaration order) of edges whose CHILD is on the spine
// AND whose parent is non-abandoned -- i.e. the contiguous winning progression.
function spineLinkIndexes(nodes) {
  const idxs = [];
  let edgeIndex = 0;
  for (const n of nodes) {
    if (!n.parent) continue;
    const onSpine = n.status !== 'abandoned' && n.parent.status !== 'abandoned';
    if (onSpine) idxs.push(edgeIndex);
    edgeIndex++;
  }
  return idxs;
}

// Drop trailing blank lines so the document never ends on a stray newline group.
function trimTrailing(lines) {
  const out = lines.slice();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
