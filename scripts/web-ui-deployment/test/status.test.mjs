import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  layerStates, detectStatus, loadParams, saveParams, checkSecretsPopulated, PARAMS_FILE,
} from '../lib/status.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const layers = JSON.parse(readFileSync(join(here, '..', 'layers.json'), 'utf8')).layers;

async function tmpRepo() { return mkdtemp(join(tmpdir(), 'waui-status-')); }
async function writeState(repoRoot, components) {
  await writeFile(join(repoRoot, '.deployment-state.json'), JSON.stringify({ version: '1.0', components }), 'utf8');
}

test('layerStates maps deployed flags to done/pending and counts', () => {
  const { states, done, total } = layerStates(layers, { components: { 'wa-network': { deployed: true }, 'wa-ddb': { deployed: true } } });
  assert.equal(total, layers.length);
  assert.equal(done, 2);
  assert.equal(states['wa-network'], 'done');
  assert.equal(states['wa-gateway'], 'pending');
});

test('detectStatus: not-started when no state file', async () => {
  const r = await detectStatus({ repoRoot: await tmpRepo(), layers });
  assert.equal(r.classification, 'not-started');
  assert.deepEqual(r.availableModes, ['fresh']);
});

test('detectStatus: partial when some layers done', async () => {
  const repo = await tmpRepo();
  await writeState(repo, { 'wa-network': { deployed: true }, 'wa-ddb': { deployed: true } });
  const r = await detectStatus({ repoRoot: repo, layers });
  assert.equal(r.classification, 'partial');
  assert.deepEqual(r.availableModes, ['resume']);
  assert.equal(r.progress.done, 2);
});

test('detectStatus: fully-deployed when all layers done -> reconfigure modes', async () => {
  const repo = await tmpRepo();
  const all = {};
  for (const l of layers) all[l.key] = { deployed: true };
  await writeState(repo, all);
  const r = await detectStatus({ repoRoot: repo, layers });
  assert.equal(r.classification, 'fully-deployed');
  assert.deepEqual(r.availableModes, ['changes', 'previous', 'rebrand']);
});

test('saveParams persists only non-secret whitelisted keys (drops phone + secrets)', async () => {
  const repo = await tmpRepo();
  await saveParams(repo, {
    deploymentPrefix: 'qsr-wa', businessName: 'burgers', companyName: 'Example Cafe', location: 'Dallas, TX',
    userPhone: '+1 212 555 0100', accessToken: 'SECRET', appSecret: 'SECRET', userName: 'Jane Doe',
  });
  const raw = await readFile(join(repo, PARAMS_FILE), 'utf8');
  assert.ok(raw.includes('burgers') && raw.includes('Dallas, TX'));
  for (const leak of ['+1 212 555 0100', 'SECRET', 'Jane Doe']) assert.ok(!raw.includes(leak), `persisted file leaked ${leak}`);
  const loaded = await loadParams(repo);
  assert.deepEqual(loaded, { deploymentPrefix: 'qsr-wa', businessName: 'burgers', companyName: 'Example Cafe', location: 'Dallas, TX' });
});

test('loadParams returns {} when no file', async () => {
  assert.deepEqual(await loadParams(await tmpRepo()), {});
});

test('checkSecretsPopulated: true when all three have values, false when empty, null without deps', async () => {
  const pure = { secretNamesForPrefix: (p) => ({ accessToken: `${p}-a`, appSecret: `${p}-s`, verifyToken: `${p}-v` }) };
  const full = { makeClient: () => ({}), getSecret: async () => 'value' };
  const empty = { makeClient: () => ({}), getSecret: async () => '' };
  assert.equal(await checkSecretsPopulated({ secrets: full, pure, prefix: 'qsr-wa' }), true);
  assert.equal(await checkSecretsPopulated({ secrets: empty, pure, prefix: 'qsr-wa' }), false);
  assert.equal(await checkSecretsPopulated({}), null);
});
