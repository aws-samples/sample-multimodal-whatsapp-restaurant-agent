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
    hideGate();
    setFinal(ok, summary);
    logLine(summary, ok ? 'muted' : 'err');
    q('#startBtn').disabled = false;
    q('#startBtn').textContent = ok ? 'Deploy again' : 'Retry deployment';
  });

  es.addEventListener('gate', (e) => {
    renderGate(JSON.parse(e.data));
  });

  es.addEventListener('secretStatus', () => {
    logLine('Secrets populated in AWS Secrets Manager (values never shown).', 'muted');
  });

  es.onerror = () => logLine('connection lost (the installer may have exited)', 'muted');
}

q('#startBtn').addEventListener('click', () => {
  q('#startBtn').disabled = true;
  q('#startBtn').textContent = 'Deploying...';
  command({ cmd: 'start' });
});
q('#exitBtn').addEventListener('click', () => command({ cmd: 'exit' }));

// ---- Meta onboarding gate (form rendered from a `gate` event) ----
const CONSOLE_LABELS = {
  apps: 'Open Meta apps page',
  appDashboard: 'Open App Dashboard',
  whatsappApiSetup: 'Open WhatsApp API Setup',
};

let currentGate = null;

function gateFormVal(name) {
  const el = document.querySelector(`#gateForm [name="${name}"]`);
  return el ? el.value.trim() : '';
}

function openConsole(which) {
  command({ cmd: 'openUrl', which, appId: gateFormVal('appId'), businessId: gateFormVal('businessId') });
}

function renderGate(data) {
  currentGate = data;
  q('#gateTitle').textContent = data.title || 'WhatsApp setup';
  q('#gateHelp').textContent = data.help || '';
  const errEl = q('#gateError');
  if (data.error) { errEl.textContent = data.error; errEl.hidden = false; } else { errEl.hidden = true; }

  const con = q('#gateConsole');
  con.innerHTML = '';
  for (const which of data.consoleUrls || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn';
    b.textContent = CONSOLE_LABELS[which] || 'Open Meta console';
    b.addEventListener('click', () => openConsole(which));
    con.appendChild(b);
  }

  const form = q('#gateForm');
  form.innerHTML = '';

  if (data.choice) {
    // Discovery found multiple candidates - let the operator pick one.
    const field = data.choice.kind === 'waba' ? 'wabaId' : 'phoneNumberId';
    const wrap = document.createElement('div');
    wrap.className = 'gate-field';
    const lab = document.createElement('label');
    lab.textContent = `Choose a ${data.choice.kind === 'waba' ? 'WhatsApp Business Account' : 'phone number'}`;
    const sel = document.createElement('select');
    sel.name = field;
    for (const opt of data.choice.options || []) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label || opt.id;
      sel.appendChild(o);
    }
    wrap.append(lab, sel);
    form.appendChild(wrap);
  } else {
    for (const f of data.fields || []) {
      const wrap = document.createElement('div');
      wrap.className = 'gate-field';
      if (f.type === 'checkbox') {
        const cbLabel = document.createElement('label');
        cbLabel.className = 'gate-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.name = f.name;
        cbLabel.append(cb, document.createTextNode(' ' + f.label));
        const help = document.createElement('div');
        help.className = 'gate-fieldhelp';
        help.textContent = f.help || '';
        wrap.append(cbLabel, help);
        form.appendChild(wrap);
        continue;
      }
      const lab = document.createElement('label');
      lab.textContent = f.label + (f.required ? ' *' : ' (optional)');
      const row = document.createElement('div');
      row.className = 'gate-input-row';
      const inp = document.createElement('input');
      inp.name = f.name;
      inp.type = (f.secret || f.type === 'password') ? 'password' : 'text';
      inp.autocomplete = 'off';
      if (f.default) inp.value = f.default;
      if (f.secret) inp.dataset.secret = '1';
      if (f.sensitive) inp.dataset.sensitive = '1';
      row.appendChild(inp);
      if (f.urlKey) {
        const wb = document.createElement('button');
        wb.type = 'button';
        wb.className = 'where-btn';
        wb.textContent = 'Where?';
        wb.title = 'Open the Meta console page for this value';
        wb.addEventListener('click', () => openConsole(f.urlKey));
        row.appendChild(wb);
      }
      const help = document.createElement('div');
      help.className = 'gate-fieldhelp';
      help.textContent = f.help || '';
      wrap.append(lab, row, help);
      form.appendChild(wrap);
    }
  }

  q('#gateSubmit').textContent = data.submitLabel || (data.action === 'wire-webhook' ? 'Wire webhook' : 'Continue');
  q('#gate').hidden = false;
}

function submitGate() {
  const values = {};
  for (const el of document.querySelectorAll('#gateForm [name]')) {
    if (el.type === 'checkbox') values[el.name] = el.checked;
    else if (el.value.trim() !== '') values[el.name] = el.value.trim();
  }
  const cmd = currentGate && currentGate.kind === 'synthetic-data' ? 'submitData' : 'submitMeta';
  command({ cmd, values });
  // Clear secret + sensitive (PII) inputs from the DOM immediately after submit.
  for (const el of document.querySelectorAll('#gateForm [data-secret], #gateForm [data-sensitive]')) el.value = '';
  hideGate();
}

function hideGate() { q('#gate').hidden = true; currentGate = null; }

q('#gateSubmit').addEventListener('click', submitGate);
q('#gateSkip').addEventListener('click', () => { command({ cmd: 'skip' }); hideGate(); });
q('#metaBtn').addEventListener('click', () => command({ cmd: 'metaOnly' }));
q('#dataBtn').addEventListener('click', () => command({ cmd: 'syntheticOnly' }));

if (!TOKEN) {
  logLine('Missing session token. Relaunch with ./scripts/deploy-all.sh --interactive-web-ui', 'err');
} else {
  connect();
}
