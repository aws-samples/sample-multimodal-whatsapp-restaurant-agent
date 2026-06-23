// Minimal architecture visualization for the installer.
//
// Phase 2 renders each deploy layer from the manifest as a state card
// (pending -> deploying -> done / skipped / failed) and animates transitions.
// A later phase can swap this for the full node/edge engine from the repo-root
// index.html; the public API (renderLayers / setLayerState / setProgress) stays
// the same so the app wiring does not change.

const el = (sel) => document.querySelector(sel);
const cards = new Map(); // key -> { card, stateEl }
let layersMeta = new Map(); // key -> manifest entry

const STATE_LABEL = {
  pending: 'pending', deploying: 'deploying...', done: 'deployed',
  skipped: 'already deployed', failed: 'failed',
};

export function renderLayers(layers, onSelect) {
  layersMeta = new Map(layers.map((l) => [l.key, l]));
  const container = el('#layers');
  container.innerHTML = '';
  cards.clear();
  for (const l of layers) {
    const card = document.createElement('div');
    card.className = 'layer';
    card.dataset.state = 'pending';
    card.dataset.key = l.key;
    card.innerHTML = `<div class="name"><span class="pip"></span>${escapeHtml(l.name)}</div><div class="state">pending</div>`;
    card.addEventListener('click', () => onSelect?.(l));
    container.appendChild(card);
    cards.set(l.key, { card, stateEl: card.querySelector('.state') });
  }
}

export function setLayerState(key, state) {
  const c = cards.get(key);
  if (!c) return;
  c.card.dataset.state = state;
  c.stateEl.textContent = STATE_LABEL[state] || state;
}

export function setProgress(done, total, activeKey) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  el('#progressInner').style.width = pct + '%';
  const active = activeKey ? layersMeta.get(activeKey)?.name || activeKey : null;
  el('#progressLabel').textContent = active
    ? `Deploying ${active} (${done}/${total})`
    : `${done} of ${total} components deployed`;
}

export function showDetail(layer) {
  el('#detail').innerHTML = `<span class="dname">${escapeHtml(layer.name)}</span>${escapeHtml(layer.why)}`;
}

export function setFinal(ok, summary) {
  el('#progressLabel').textContent = summary;
  el('#progressInner').style.background = ok
    ? 'linear-gradient(90deg, var(--ok), #6ee7b7)'
    : 'linear-gradient(90deg, var(--fail), #fb7185)';
}

export function getLayerMeta(key) { return layersMeta.get(key); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
