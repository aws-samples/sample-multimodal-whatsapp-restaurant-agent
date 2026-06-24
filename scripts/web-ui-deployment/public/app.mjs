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

// ---- Reusable busy banner ------------------------------------------------
// Shown on actions that wait on the backend (loading a gate form, seeding,
// re-checking credentials, re-applying a layer). Hidden by the concluding SSE
// event (gate/done/identity/layer). An idle failsafe clears it if no event
// arrives; each streamed log line re-arms it so a long seed keeps it visible.
const BUSY_IDLE_MS = 45000;
let busyTimer = null;
let busyKind = null;
function armBusyTimer() {
  clearTimeout(busyTimer);
  busyTimer = setTimeout(hideBusy, BUSY_IDLE_MS);
}
function showBusy(text, kind) {
  const b = q('#busyBanner');
  b.querySelector('.busy-text').textContent = text || 'Working...';
  b.hidden = false;
  busyKind = kind || null;
  armBusyTimer();
}
function hideBusy() {
  clearTimeout(busyTimer);
  busyTimer = null;
  busyKind = null;
  const b = q('#busyBanner');
  if (b) b.hidden = true;
}
function bumpBusy() {
  if (!q('#busyBanner').hidden) armBusyTimer();
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
    const data = JSON.parse(e.data);
    const { layers, mock, states, progress, classification, availableModes } = data;
    if (mock) q('#mockBadge').hidden = false;
    if (data.identity) renderIdentity(data.identity);
    latestLayers = layers || [];
    setStep(data.identity && !data.identity.ok ? 'credentials' : 'deploy');
    renderLayers(layers, (layer) => { selectedLayerKey = layer.key; q('#applyLayerBtn').hidden = false; showDetail(layer); });
    initTopology(document.getElementById('archSvg')).then((ok) => {
      if (!ok) {
        document.getElementById('diagramWrap').classList.add('no-diagram');
        document.getElementById('diagramFallback').hidden = false;
      }
      // Pre-paint already-deployed layers onto the diagram (resume).
      if (states) {
        for (const [key, st] of Object.entries(states)) {
          if (st !== 'done') continue;
          const meta = getLayerMeta(key);
          if (meta && meta.nodes && meta.nodes.length) setTopoNodes(meta.nodes, 'done');
        }
      }
    });
    // Pre-paint cards + the progress line from the resumed state.
    if (states) for (const [key, st] of Object.entries(states)) if (st === 'done') setLayerState(key, 'done');
    if (progress) setProgress(progress.done, progress.total, null);
    logLine('Connected. Click "Start deployment" to begin.', 'muted');
    // If an existing deployment is detected, ask what to do.
    if (classification && classification !== 'not-started' && availableModes && availableModes.length) {
      renderModeChooser(data);
    }
  });

  es.addEventListener('layer', (e) => {
    const { key, state } = JSON.parse(e.data);
    hideBusy();
    const vs = VIZ_STATE[state];
    if (vs) setLayerState(key, vs);
    const meta = getLayerMeta(key);
    if (meta) {
      // Light the matching architecture node(s). Layers with no diagram node
      // (e.g. the VPC and the order notifier) just animate their card.
      if (vs && meta.nodes && meta.nodes.length) setTopoNodes(meta.nodes, vs);
      if (state === 'start') showDetail(meta);
    }
    if (state === 'start') setStep('deploy');
    if (state === 'fail') showFailBanner(key);
  });

  es.addEventListener('build', (e) => {
    const { key, phase } = JSON.parse(e.data);
    const meta = getLayerMeta(key);
    const name = (meta && meta.name) || key;
    if (phase === 'building') q('#progressLabel').textContent = `Building ${name} container (this can take a few minutes)...`;
    logLine(`[build] ${name}: ${phase}`, 'muted');
  });

  es.addEventListener('log', (e) => {
    const { line } = JSON.parse(e.data);
    bumpBusy();
    logLine(line);
  });

  es.addEventListener('progress', (e) => {
    const { done, total, activeKey } = JSON.parse(e.data);
    setProgress(done, total, activeKey);
  });

  es.addEventListener('done', (e) => {
    const { ok, summary } = JSON.parse(e.data);
    hideBusy();
    hideGate();
    if (ok) { setStep('done'); hideFailBanner(); }
    setFinal(ok, summary);
    logLine(summary, ok ? 'muted' : 'err');
    q('#startBtn').disabled = false;
    q('#startBtn').textContent = ok ? 'Deploy again' : 'Retry deployment';
  });

  es.addEventListener('gate', (e) => {
    const g = JSON.parse(e.data);
    hideBusy();
    setStep(g.kind === 'synthetic-data' ? 'data' : 'whatsapp');
    renderGate(g);
  });

  es.addEventListener('secretStatus', () => {
    logLine('Secrets populated in AWS Secrets Manager (values never shown).', 'muted');
  });

  es.addEventListener('identity', (e) => { if (busyKind === 'recheck') hideBusy(); renderIdentity(JSON.parse(e.data)); });

  es.onerror = () => { hideBusy(); logLine('connection lost (the installer may have exited)', 'muted'); };
}

q('#startBtn').addEventListener('click', () => {
  q('#startBtn').disabled = true;
  q('#startBtn').textContent = 'Deploying...';
  hideFailBanner();
  setStep('deploy');
  showBusy('Starting deployment...', 'deploy');
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
let selectedLayerKey = null;
let latestLayers = [];

// ---- Guided step rail ----
const STEP_ORDER = ['credentials', 'deploy', 'whatsapp', 'data', 'done'];
function setStep(name) {
  const idx = STEP_ORDER.indexOf(name);
  if (idx < 0) return;
  for (const li of document.querySelectorAll('#stepRail li')) {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('active', i === idx);
    li.classList.toggle('step-done', i < idx);
  }
}

// ---- Failure banner (root cause hint + exact re-run command) ----
function showFailBanner(key) {
  const meta = getLayerMeta(key);
  const name = (meta && meta.name) || key;
  selectedLayerKey = key;
  q('#applyLayerBtn').hidden = false;
  const b = q('#failBanner');
  b.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'fb-title';
  h.textContent = `${name} failed`;
  const p = document.createElement('div');
  p.textContent = 'The cause is in the log below. Fix it, then click "Re-apply this layer", or re-run in a terminal:';
  const cmd = document.createElement('code');
  cmd.className = 'fb-cmd';
  cmd.textContent = `./scripts/deploy-all.sh --only ${key}`;
  b.append(h, p, cmd);
  b.hidden = false;
}
function hideFailBanner() { q('#failBanner').hidden = true; }

// ---- Deploy options (layer subset + skip kitchen simulator) ----
function openOptions() {
  const wrap = q('#optLayers');
  wrap.innerHTML = '';
  for (const l of latestLayers) {
    const lab = document.createElement('label');
    lab.className = 'opt-layer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = l.key;
    cb.checked = true;
    lab.append(cb, document.createTextNode(' ' + l.name));
    wrap.appendChild(lab);
  }
  q('#options').hidden = false;
}
function startWithOptions() {
  const selectedLayers = [...document.querySelectorAll('#optLayers input:checked')].map((c) => c.value);
  const options = { skipKitchenSimulator: q('#optSkipKitchen').checked };
  q('#options').hidden = true;
  hideFailBanner();
  setStep('deploy');
  q('#startBtn').disabled = true;
  q('#startBtn').textContent = 'Deploying...';
  showBusy('Starting deployment...', 'deploy');
  command({ cmd: 'start', selectedLayers, options });
}
q('#optionsBtn').addEventListener('click', openOptions);
q('#optionsCancel').addEventListener('click', () => { q('#options').hidden = true; });
q('#optionsStart').addEventListener('click', startWithOptions);

const MODE_LABELS = {
  fresh: 'Fresh install',
  resume: 'Resume',
  changes: 'Re-deploy changes',
  previous: 'Re-deploy with previous parameters',
  rebrand: 'Re-deploy with new brand parameters',
};

function renderModeChooser(data) {
  q('#modesHelp').textContent = data.classification === 'partial'
    ? `A previous deploy reached ${data.progress.done} of ${data.progress.total} layers. Resume to finish it (completed layers are skipped).`
    : 'Everything is already deployed and configured. Choose what you want to do.';
  const list = q('#modesList');
  list.innerHTML = '';
  for (const mode of data.availableModes || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mode-btn';
    const title = document.createElement('div');
    title.className = 'mode-title';
    title.textContent = MODE_LABELS[mode] || mode;
    const desc = document.createElement('div');
    desc.className = 'mode-desc';
    desc.textContent = (data.modeDescriptions && data.modeDescriptions[mode]) || '';
    b.append(title, desc);
    b.addEventListener('click', () => { showBusy('Loading...', 'mode'); command({ cmd: 'mode', path: mode }); q('#modes').hidden = true; });
    list.appendChild(b);
  }
  q('#modes').hidden = false;
}

function gateFormVal(name) {
  const el = document.querySelector(`#gateForm [name="${name}"]`);
  return el ? el.value.trim() : '';
}

function openConsole(which) {
  command({ cmd: 'openUrl', which, appId: gateFormVal('appId'), businessId: gateFormVal('businessId') });
}

// Eye toggle for secret fields: reveal/hide the typed value, and if the field
// is empty and revealable, fetch the stored value from Secrets Manager first.
async function toggleReveal(inp, f, eye) {
  if (inp.type === 'password') {
    if (!inp.value && f.reveal) {
      eye.textContent = '...';
      try {
        const r = await fetch(`/reveal?which=${encodeURIComponent(f.name)}&token=${encodeURIComponent(TOKEN)}`);
        const j = await r.json();
        if (j.value) inp.value = j.value;
        else logLine(`No stored value for ${f.label} yet - enter one.`, 'muted');
      } catch (e) {
        logLine(`Could not load ${f.label}: ${e.message}`, 'err');
      }
    }
    inp.type = 'text';
    eye.textContent = 'hide';
  } else {
    inp.type = 'password';
    eye.textContent = 'show';
  }
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
      if (f.secret) {
        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'eye-btn';
        eye.title = 'Show / load the stored value';
        eye.textContent = 'show';
        eye.addEventListener('click', () => toggleReveal(inp, f, eye));
        row.appendChild(eye);
      }
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
  const isData = currentGate && currentGate.kind === 'synthetic-data';
  const cmd = isData ? 'submitData' : 'submitMeta';
  showBusy(isData ? 'Seeding demo data...' : 'Saving WhatsApp settings...', isData ? 'synthetic' : 'meta');
  command({ cmd, values });
  // Clear secret + sensitive (PII) inputs from the DOM immediately after submit.
  for (const el of document.querySelectorAll('#gateForm [data-secret], #gateForm [data-sensitive]')) el.value = '';
  hideGate();
}

function hideGate() { q('#gate').hidden = true; currentGate = null; }

q('#gateSubmit').addEventListener('click', submitGate);
q('#gateSkip').addEventListener('click', () => { showBusy('Finishing up...', 'skip'); command({ cmd: 'skip' }); hideGate(); });
q('#metaBtn').addEventListener('click', () => { showBusy('Loading WhatsApp configuration...', 'meta'); command({ cmd: 'metaOnly' }); });
q('#dataBtn').addEventListener('click', () => { showBusy('Preparing demo-data form...', 'synthetic'); command({ cmd: 'syntheticOnly' }); });
q('#recheckBtn').addEventListener('click', () => { showBusy('Checking AWS credentials...', 'recheck'); command({ cmd: 'recheckIdentity' }); });

// Render the AWS credential status chip (account, principal, valid/expired).
function renderIdentity(id) {
  const wrap = q('#identity');
  const dot = wrap.querySelector('.id-dot');
  const text = wrap.querySelector('.id-text');
  wrap.hidden = false;
  if (id && id.ok) {
    wrap.dataset.state = 'ok';
    const acct = id.account ? `acct ${id.account}` : 'account ?';
    text.textContent = `${acct} - ${id.display || 'identity'}${id.mock ? ' (mock)' : ''} - valid`;
    dot.title = id.arn || '';
  } else {
    wrap.dataset.state = 'bad';
    const why = id && id.expired ? 'EXPIRED' : id && id.missing ? 'NO CREDENTIALS' : 'INVALID';
    text.textContent = `AWS credentials ${why} - refresh in terminal, then recheck`;
    dot.title = (id && id.reason) || '';
  }
}
q('#applyLayerBtn').addEventListener('click', () => {
  if (selectedLayerKey) {
    const meta = getLayerMeta(selectedLayerKey);
    showBusy(`Re-applying ${(meta && meta.name) || selectedLayerKey}...`, 'applyLayer');
    command({ cmd: 'applyLayer', key: selectedLayerKey, force: true });
  }
});

// ---- Light/dark theme toggle (persisted; defaults to OS preference) ----
const THEME_KEY = 'waui-theme';
function applyTheme(t) {
  const light = t === 'light';
  document.documentElement.dataset.theme = light ? 'light' : '';
  const btn = q('#themeBtn');
  if (btn) btn.textContent = light ? 'Dark mode' : 'Light mode';
}
function initTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch { /* storage may be blocked */ }
  if (!t) t = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  applyTheme(t);
}
q('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  applyTheme(next);
});
initTheme();

if (!TOKEN) {
  logLine('Missing session token. Relaunch with ./scripts/deploy-all.sh --interactive-web-ui', 'err');
} else {
  connect();
}
