// Installer UI controller: connects the SSE control channel and drives the viz.
import { renderLayers, setLayerState, setProgress, showDetail, setFinal, getLayerMeta } from './viz.mjs';
import { initTopology, setNodesState as setTopoNodes } from './topology.mjs';

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const q = (s) => document.querySelector(s);

// Map a deploy-layer state to a viz card state.
const VIZ_STATE = { start: 'deploying', done: 'done', skipped: 'skipped', fail: 'failed' };

function logLine(line, cls) {
  const log = q('#log');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = line;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function command(cmd) {
  await fetch(`/command?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  }).catch((e) => logLine(`command failed: ${e.message}`, 'err'));
}

function connect() {
  const es = new EventSource(`/events?token=${encodeURIComponent(TOKEN)}`);

  es.addEventListener('hello', (e) => {
    const { layers, mock } = JSON.parse(e.data);
    if (mock) q('#mockBadge').hidden = false;
    renderLayers(layers, (layer) => showDetail(layer));
    initTopology(document.getElementById('archSvg')).then((ok) => {
      if (!ok) {
        document.getElementById('diagramWrap').classList.add('no-diagram');
        document.getElementById('diagramFallback').hidden = false;
      }
    });
    logLine('Connected. Click "Start deployment" to begin.', 'muted');
  });

  es.addEventListener('layer', (e) => {
    const { key, state } = JSON.parse(e.data);
    const vs = VIZ_STATE[state];
    if (vs) setLayerState(key, vs);
    const meta = getLayerMeta(key);
    if (meta) {
      // Light the matching architecture node(s). Layers with no diagram node
      // (e.g. the VPC and the order notifier) just animate their card.
      if (vs && meta.nodes && meta.nodes.length) setTopoNodes(meta.nodes, vs);
      if (state === 'start') showDetail(meta);
    }
  });

  es.addEventListener('build', (e) => {
    const { key, phase } = JSON.parse(e.data);
    logLine(`[build] ${key}: ${phase}`, 'muted');
  });

  es.addEventListener('log', (e) => {
    const { line } = JSON.parse(e.data);
    logLine(line);
  });

  es.addEventListener('progress', (e) => {
    const { done, total, activeKey } = JSON.parse(e.data);
    setProgress(done, total, activeKey);
  });

  es.addEventListener('done', (e) => {
    const { ok, summary } = JSON.parse(e.data);
    setFinal(ok, summary);
    logLine(summary, ok ? 'muted' : 'err');
    q('#startBtn').disabled = false;
    q('#startBtn').textContent = ok ? 'Deploy again' : 'Retry deployment';
  });

  es.onerror = () => logLine('connection lost (the installer may have exited)', 'muted');
}

q('#startBtn').addEventListener('click', () => {
  q('#startBtn').disabled = true;
  q('#startBtn').textContent = 'Deploying...';
  command({ cmd: 'start' });
});
q('#exitBtn').addEventListener('click', () => command({ cmd: 'exit' }));

if (!TOKEN) {
  logLine('Missing session token. Relaunch with ./scripts/deploy-all.sh --interactive-web-ui', 'err');
} else {
  connect();
}
