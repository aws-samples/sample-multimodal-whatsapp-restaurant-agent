// Architecture diagram renderer for the installer.
//
// Renders the SAME topology as the published visualizer (repo-root index.html),
// fetched from the server's /topology.json endpoint, as a static SVG scene:
// cluster columns, faint context edges, and a node per architecture box. As
// each deploy layer runs, the installer lights the node(s) mapped to it in
// layers.json (nodes[]), so the operator sees WHERE in the architecture the
// current component sits.
//
// Pure SVG, no HTML overlays, so it scales with the <svg viewBox> and needs no
// resize handling. Icons are drawn as data-URI <image> elements (the icon SVG
// is self-contained with its own 0 0 80 80 viewBox), which avoids any SVG
// innerHTML namespace quirks.

const SVG_NS = 'http://www.w3.org/2000/svg';

let svgEl = null;
let nodeEls = new Map();      // node key -> <g> element
let topology = null;          // { nodes, clusters, edges, icons }

function elNS(name, attrs = {}) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function nodeCenter(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

// Quadratic curve between two node centers; `curve` bows the midpoint
// vertically. Matches the published visualizer's edgePath().
function edgePath(nodes, from, to, curve) {
  const a = nodeCenter(nodes[from]);
  const b = nodeCenter(nodes[to]);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 + (curve || 0);
  return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
}

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ''); }

// Fetch the diagram data and render it into `svg`. Returns true if a diagram
// was rendered, false if topology data is unavailable (caller falls back to
// the card-only view).
export async function initTopology(svg) {
  svgEl = svg;
  try {
    const res = await fetch('/topology.json');
    if (!res.ok) return false;
    topology = await res.json();
  } catch {
    return false;
  }
  if (!topology || !topology.nodes || Object.keys(topology.nodes).length === 0) return false;
  render();
  return true;
}

function render() {
  const { nodes, clusters, edges, icons } = topology;
  svgEl.innerHTML = '';
  nodeEls = new Map();

  const clustersG = elNS('g', { class: 'topo-clusters' });
  const edgesG = elNS('g', { class: 'topo-edges' });
  const boundariesG = elNS('g', { class: 'topo-boundaries' });
  const nodesG = elNS('g', { class: 'topo-nodes' });
  svgEl.append(clustersG, edgesG, boundariesG, nodesG);

  // Cluster columns (tier backgrounds).
  for (const c of clusters) {
    clustersG.appendChild(elNS('rect', {
      x: c.x, y: c.y, width: c.w, height: c.h, rx: 12,
      fill: c.color, 'fill-opacity': 0.04,
      stroke: c.color, 'stroke-opacity': 0.3, 'stroke-dasharray': '4 6', 'stroke-width': 1,
    }));
    const label = elNS('text', { x: c.x + 14, y: c.y + 16, class: 'topo-cluster-label', fill: c.color });
    label.textContent = c.label;
    clustersG.appendChild(label);
  }

  // Faint context edges so the topology reads as a connected system.
  for (const e of edges) {
    if (!nodes[e.from] || !nodes[e.to]) continue;
    const p = elNS('path', {
      d: edgePath(nodes, e.from, e.to, e.curve), class: 'topo-edge',
      stroke: e.color, fill: 'none',
    });
    if (e.dashed) p.setAttribute('stroke-dasharray', '6 6');
    edgesG.appendChild(p);
  }

  // Future extension point: draw labelled boundaries (e.g. the VPC that wraps
  // the call runtime + KVS TURN media path). renderBoundaries() is ready; pass
  // it boundary specs once the network layer should appear in the diagram, e.g.
  //   renderBoundaries([{ label: 'VPC', nodes: ['callRuntime', 'kvsTurn'], color: '#5aa4ff' }])
  svgEl._boundariesG = boundariesG;
  renderBoundaries([]);

  // Nodes: rect + icon + label, lightable by deploy state.
  for (const [key, n] of Object.entries(nodes)) {
    const g = elNS('g', { class: 'topo-node' });
    g.dataset.key = key;
    g.dataset.state = 'pending';

    g.appendChild(elNS('rect', {
      class: 'topo-rect', x: n.x, y: n.y, width: n.w, height: n.h, rx: 10,
    }));

    const iconSize = 30;
    const icon = icons[n.icon];
    if (icon) {
      const href = 'data:image/svg+xml;utf8,' + encodeURIComponent(icon);
      const img = elNS('image', {
        x: n.x + n.w / 2 - iconSize / 2, y: n.y + 9,
        width: iconSize, height: iconSize, preserveAspectRatio: 'xMidYMid meet',
      });
      img.setAttribute('href', href);
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
      g.appendChild(img);
    }

    const title = elNS('text', { class: 'topo-title', x: n.x + n.w / 2, y: n.y + n.h - 18, 'text-anchor': 'middle' });
    title.textContent = n.label;
    g.appendChild(title);

    const sub = elNS('text', { class: 'topo-sub', x: n.x + n.w / 2, y: n.y + n.h - 5, 'text-anchor': 'middle' });
    sub.textContent = stripTags(n.sub);
    g.appendChild(sub);

    nodesG.appendChild(g);
    nodeEls.set(key, g);
  }
}

/**
 * Draw labelled dashed boundaries around groups of nodes. Not used yet; this is
 * the hook for representing the VPC (and other enclosures) in the diagram.
 * @param {Array<{label:string, nodes:string[], color?:string}>} specs
 */
export function renderBoundaries(specs) {
  const g = svgEl && svgEl._boundariesG;
  if (!g) return;
  g.innerHTML = '';
  if (!topology || !Array.isArray(specs)) return;
  const pad = 14;
  for (const spec of specs) {
    const pts = (spec.nodes || []).map((k) => topology.nodes[k]).filter(Boolean);
    if (pts.length === 0) continue;
    const minX = Math.min(...pts.map((n) => n.x)) - pad;
    const minY = Math.min(...pts.map((n) => n.y)) - pad - 8;
    const maxX = Math.max(...pts.map((n) => n.x + n.w)) + pad;
    const maxY = Math.max(...pts.map((n) => n.y + n.h)) + pad;
    const color = spec.color || '#5aa4ff';
    g.appendChild(elNS('rect', {
      x: minX, y: minY, width: maxX - minX, height: maxY - minY, rx: 14,
      fill: 'none', stroke: color, 'stroke-opacity': 0.6, 'stroke-dasharray': '8 6', 'stroke-width': 1.5,
    }));
    const label = elNS('text', { x: minX + 10, y: minY + 16, class: 'topo-boundary-label', fill: color });
    label.textContent = spec.label || '';
    g.appendChild(label);
  }
}

/** True if the diagram has a node with this id. */
export function hasNode(key) { return nodeEls.has(key); }

/** Set the deploy state on one or more diagram nodes. */
export function setNodesState(keys, state) {
  for (const key of keys || []) {
    const g = nodeEls.get(key);
    if (g) g.dataset.state = state;
  }
}

/** Reset every node to the idle/pending state. */
export function resetNodeStates() {
  for (const g of nodeEls.values()) g.dataset.state = 'pending';
}
