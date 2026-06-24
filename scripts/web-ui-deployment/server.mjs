#!/usr/bin/env node
// Local web UI installer server for the WhatsApp Restaurant AI Host.
//
// Zero-dependency: Node built-ins only. Binds to loopback (127.0.0.1) on an
// ephemeral port, serves the single-page UI, and exposes a control channel:
//   - GET  /events?token=...   Server-Sent Events stream (server -> browser)
//   - POST /command?token=...  commands (browser -> server): start, exit
// The control channel requires the per-launch session token so no other local
// process can drive a deploy. Static UI assets and the layer manifest are
// served on loopback without the token (they are not sensitive).
//
// Control channel is SSE + POST rather than WebSocket so the installer stays
// dependency-free (no WebSocket framing, no `ws` package). The logical event
// schema matches the design's control-channel contract.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { extractTopology, EMPTY_TOPOLOGY } from './lib/topology-source.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));     // scripts/web-ui-deployment
const SCRIPTS_DIR = join(HERE, '..');                     // scripts/
const REPO_ROOT = join(SCRIPTS_DIR, '..');                // repo root
const DEPLOY_SCRIPT = join(SCRIPTS_DIR, 'deploy-all.sh');
const PUBLIC_DIR = join(HERE, 'public');
const LAYERS_PATH = join(HERE, 'layers.json');
const INDEX_HTML = join(REPO_ROOT, 'index.html');         // the published architecture diagram

const args = process.argv.slice(2);
const MOCK = args.includes('--mock');

const SESSION_TOKEN = randomBytes(24).toString('hex');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const STATIC_FILES = new Set(['index.html', 'app.mjs', 'viz.mjs', 'topology.mjs', 'styles.css']);

const sseClients = new Set();
let deploying = false;

// Meta onboarding is loaded lazily (only when a gate runs) so the deploy and
// --mock paths stay dependency-free; meta.mjs pulls in the AWS SDK via the
// whatsapp-setup secrets lib.
let metaMod = null;
async function loadMeta() {
  if (!metaMod) metaMod = await import('./lib/meta.mjs');
  return metaMod;
}

let syntheticMod = null;
async function loadSynthetic() {
  if (!syntheticMod) syntheticMod = await import('./lib/synthetic.mjs');
  return syntheticMod;
}

// A "gate" pauses the deploy and waits for the browser to POST a command
// (submitMeta / skipMeta / a discovery choice). One gate is open at a time.
let pendingGate = null;
function awaitGate() {
  return new Promise((resolve) => { pendingGate = { resolve }; });
}
function resolveGate(payload) {
  if (!pendingGate) return false;
  const { resolve } = pendingGate;
  pendingGate = null;
  resolve(payload);
  return true;
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function tokenFromUrl(url) {
  return new URL(url, 'http://127.0.0.1').searchParams.get('token');
}

function sse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// Bridge a deploy/mock event onto the SSE control-channel schema.
function onDeployEvent(ev) {
  if (ev.kind === 'marker') {
    const e = ev.event;
    if (e.type === 'layer') sse('layer', { key: e.key, state: e.state });
    else if (e.type === 'build') sse('build', { key: e.key, phase: e.phase });
  } else if (ev.kind === 'log') {
    sse('log', { key: ev.key, line: ev.line });
  }
}

async function loadLayers() {
  const manifest = JSON.parse(await readFile(LAYERS_PATH, 'utf8'));
  return manifest.layers;
}

// Diagram data is extracted once from the published index.html and cached. If
// that file is missing or its structure changed, we serve an empty topology so
// the UI degrades gracefully to the card-only view.
let topologyCache = null;
async function loadTopology() {
  if (topologyCache) return topologyCache;
  try {
    topologyCache = await extractTopology(INDEX_HTML);
  } catch (err) {
    console.error(`  (architecture diagram unavailable: ${err.message} - using card view)`);
    topologyCache = EMPTY_TOPOLOGY;
  }
  return topologyCache;
}

function spawnLayerProc(key) {
  return new Promise((resolve) => {
    const child = spawn('bash', [DEPLOY_SCRIPT, '--only', key, '--yes', '--skip-preflight'], {
      cwd: REPO_ROOT,
      env: { ...process.env, WAUI: '1' },
    });
    const pump = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line === '') continue;
        // Inline classify to avoid a second import here; markers start with the prefix.
        const idx = line.indexOf('@@WAUI@@');
        if (idx !== -1) {
          try {
            const e = JSON.parse(line.slice(idx + 8).trim());
            onDeployEvent({ kind: 'marker', event: e });
            continue;
          } catch { /* fall through to log */ }
        }
        onDeployEvent({ kind: 'log', key, line });
      }
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', (err) => {
      onDeployEvent({ kind: 'log', key, line: `installer: spawn failed: ${err.message}` });
      onDeployEvent({ kind: 'marker', event: { type: 'layer', key, state: 'fail' } });
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}

function mockLayerProc(key) {
  return new Promise((resolve) => {
    onDeployEvent({ kind: 'marker', event: { type: 'layer', key, state: 'start' } });
    const logs = [`[mock] synthesizing ${key}`, `[mock] deploying ${key}`, `[mock] ${key} UPDATE_COMPLETE`];
    let i = 0;
    const tick = () => {
      if (i < logs.length) { onDeployEvent({ kind: 'log', key, line: logs[i++] }); setTimeout(tick, 400); }
      else { onDeployEvent({ kind: 'marker', event: { type: 'layer', key, state: 'done' } }); resolve(0); }
    };
    setTimeout(tick, 400);
  });
}

// ---- Meta/WhatsApp onboarding gates -------------------------------------
// A gate emits a `gate` SSE event and awaits the browser's reply. Secrets in
// the reply are passed to meta.mjs and NEVER logged or echoed.

function metaLog(line) { sse('log', { key: 'meta', line }); }

// Pre-deploy: collect Meta values, validate, discover ids, populate secrets.
// Loops on a discovery choice or a recoverable error until success or skip.
async function runMetaPre() {
  const m = await loadMeta();
  let extra = {};
  for (;;) {
    sse('gate', { ...m.preGate(), ...extra });
    const reply = await awaitGate();
    if (!reply || (reply.cmd && reply.cmd.startsWith('skip'))) { metaLog('Skipped WhatsApp onboarding.'); return { skipped: true }; }
    const values = reply.values || {};
    if (MOCK) {
      metaLog('[mock] validated token, discovered WABA + phone number, populated 3 secrets.');
      return { ok: true, mock: true, config: { appId: values.appId || 'mock', wabaId: values.wabaId || 'mock', phoneNumberId: values.phoneNumberId || 'mock', prefix: values.deploymentPrefix || 'qsr-wa' } };
    }
    let res;
    try {
      res = await m.runPreDeploy(values, { region: process.env.AWS_REGION, repoRoot: REPO_ROOT, onLog: metaLog });
    } catch (err) {
      res = { ok: false, reason: err.message };
    }
    if (res.ok) {
      metaLog(`WhatsApp pre-deploy complete${res.verifyTokenGenerated ? ' (Verify Token auto-generated)' : ''}.`);
      sse('secretStatus', { populated: true });
      return res;
    }
    extra = res.needChoice ? { choice: res.needChoice } : { error: res.reason || res.stage || 'unknown error' };
    metaLog(res.needChoice ? `Multiple ${res.needChoice.kind}s found - choose one.` : `WhatsApp setup needs attention: ${extra.error}.`);
  }
}

// Post-deploy: wire the webhook in Meta using the values already captured.
async function runMetaPost(config) {
  const m = await loadMeta();
  sse('gate', m.postGate());
  const reply = await awaitGate();
  if (!reply || (reply.cmd && reply.cmd.startsWith('skip'))) { metaLog('Skipped webhook wiring.'); return { skipped: true }; }
  if (MOCK) {
    metaLog('[mock] wired webhook subscription + subscribed WABA + enabled Calling API.');
    return { ok: true, mock: true };
  }
  let res;
  try {
    res = await m.runPostDeploy({ ...(config || {}), ...(reply.values || {}) }, { region: process.env.AWS_REGION, repoRoot: REPO_ROOT, onLog: metaLog });
  } catch (err) {
    res = { ok: false, reason: err.message };
  }
  if (!res.ok && res.reason) metaLog(`Webhook wiring incomplete: ${res.reason}.`);
  return res;
}

// Run both Meta gates back to back (used after a deploy and as the standalone
// "configure / update WhatsApp" rotation entry).
async function runMetaGates() {
  const pre = await runMetaPre();
  if (pre.skipped) return;
  await runMetaPost(pre.config);
}

// Standalone rotation/reconfigure entry: re-open the Meta gates without
// redeploying. PutSecretValue overwrites in place, so this rotates tokens.
async function runMetaOnly() {
  if (deploying) return;
  deploying = true;
  try {
    await runMetaGates();
    sse('done', { ok: true, summary: 'WhatsApp configuration updated.' });
  } catch (err) {
    sse('log', { key: 'meta', line: `WhatsApp configuration error: ${err.message}` });
    sse('done', { ok: false, summary: 'WhatsApp configuration stopped on an error.' });
  } finally {
    deploying = false;
  }
}

// ---- Synthetic data seeding gate ----------------------------------------
function dataLog(line) { sse('log', { key: 'data', line }); }

// Present the seeding form; on submit, validate and spawn the generator.
// Loops on a validation/seed error until success or skip. The phone number is
// redacted from streamed output inside runSynthetic (never logged here either).
async function runSyntheticGate() {
  const s = await loadSynthetic();
  let extra = {};
  for (;;) {
    sse('gate', { ...s.syntheticGate(), ...extra });
    const reply = await awaitGate();
    if (!reply || (reply.cmd && reply.cmd.startsWith('skip'))) { dataLog('Skipped synthetic data seeding.'); return { skipped: true }; }
    const values = reply.values || {};
    if (MOCK) {
      dataLog('[mock] seeded locations + menu' + (values.anonymous ? ' (anonymous demo).' : ' + a loyalty customer.'));
      return { ok: true, mock: true };
    }
    const check = s.validateSyntheticInput(values);
    if (!check.ok) { extra = { error: check.errors.join(' ') }; continue; }
    const code = await s.runSynthetic(values, { repoRoot: REPO_ROOT, onLog: dataLog });
    if (code === 0) { dataLog('Synthetic data seeding complete.'); return { ok: true }; }
    extra = { error: `Seeding exited with code ${code}. Check the log above and retry, or skip.` };
  }
}

// Standalone re-seed entry (reconfigure path foundation).
async function runSyntheticOnly() {
  if (deploying) return;
  deploying = true;
  try {
    await runSyntheticGate();
    sse('done', { ok: true, summary: 'Synthetic data step finished.' });
  } catch (err) {
    sse('log', { key: 'data', line: `Synthetic data error: ${err.message}` });
    sse('done', { ok: false, summary: 'Synthetic data step stopped on an error.' });
  } finally {
    deploying = false;
  }
}

// Open a Meta console page (resolved from known ids; never an arbitrary URL).
async function openMetaUrl(cmd) {
  try {
    const m = await loadMeta();
    const url = await m.resolveConsoleUrl(cmd.which || 'apps', { appId: cmd.appId, businessId: cmd.businessId });
    openBrowser(url);
  } catch { /* best-effort */ }
}

async function runDeploy() {
  if (deploying) return;
  deploying = true;
  let ok = true;
  try {
    const layers = await loadLayers();
    sse('progress', { done: 0, total: layers.length, activeKey: null });
    let done = 0;
    for (const layer of layers) {
      sse('progress', { done, total: layers.length, activeKey: layer.key });
      const code = MOCK ? await mockLayerProc(layer.key) : await spawnLayerProc(layer.key);
      if (code !== 0) { ok = false; break; }
      done += 1;
      sse('progress', { done, total: layers.length, activeKey: null });
    }
    if (ok) {
      await runMetaGates();
      await runSyntheticGate();
    }
  } catch (err) {
    ok = false;
    sse('log', { key: null, line: `installer error: ${err.message}` });
  } finally {
    deploying = false;
    sse('done', { ok, summary: ok ? 'Deployment complete.' : 'Deployment stopped on a failure.' });
  }
}

const server = http.createServer(async (req, res) => {
  if (!isLoopback(req)) { res.writeHead(403).end('forbidden'); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  // ---- static assets (no token; loopback-only, not sensitive) ----
  if (req.method === 'GET' && (path === '/' || STATIC_FILES.has(basename(path)))) {
    const file = path === '/' ? 'index.html' : basename(path);
    if (!STATIC_FILES.has(file)) { res.writeHead(404).end('not found'); return; }
    try {
      const body = await readFile(join(PUBLIC_DIR, file));
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
    return;
  }
  if (req.method === 'GET' && path === '/layers') {
    try {
      const body = await readFile(LAYERS_PATH);
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.json'] });
      res.end(body);
    } catch { res.writeHead(500).end('manifest error'); }
    return;
  }
  if (req.method === 'GET' && path === '/topology.json') {
    const t = await loadTopology();
    res.writeHead(200, { 'content-type': CONTENT_TYPES['.json'] });
    res.end(JSON.stringify(t));
    return;
  }

  // ---- control channel (requires the session token) ----
  if (tokenFromUrl(req.url) !== SESSION_TOKEN) { res.writeHead(401).end('unauthorized'); return; }

  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    loadLayers().then((layers) => {
      res.write(`event: hello\ndata: ${JSON.stringify({ layers, mock: MOCK })}\n\n`);
    });
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && path === '/command') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let cmd = {};
      try { cmd = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.json'] });
      res.end(JSON.stringify({ ok: true }));
      if (cmd.cmd === 'start') runDeploy();
      else if (cmd.cmd === 'exit') shutdown();
      else if (cmd.cmd === 'metaOnly') runMetaOnly();
      else if (cmd.cmd === 'syntheticOnly') runSyntheticOnly();
      else if (cmd.cmd === 'submitMeta' || cmd.cmd === 'submitData' || (cmd.cmd && cmd.cmd.startsWith('skip'))) resolveGate(cmd);
      else if (cmd.cmd === 'openUrl') openMetaUrl(cmd);
    });
    return;
  }

  res.writeHead(404).end('not found');
});

function openBrowser(url) {
  if (process.env.WAUI_NO_OPEN) return; // headless/CI: skip launching a browser
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
}

function shutdown() {
  for (const res of sseClients) { try { res.end(); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/?token=${SESSION_TOKEN}`;
  console.log('');
  console.log('  WhatsApp Restaurant AI Host - web installer');
  console.log(`  Open: ${url}`);
  if (MOCK) console.log('  (mock mode: no AWS resources will be deployed)');
  console.log('');
  openBrowser(url);
});
