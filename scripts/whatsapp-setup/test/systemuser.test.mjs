import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSystemUser } from '../lib/systemuser.mjs';
import { appSecretProof } from '../lib/pure.mjs';

const base = { adminToken: 'admin', businessId: 'B', appId: '123', appSecret: 'sec', wabaId: 'W' };
const tmp = () => mkdtemp(join(tmpdir(), 'su-'));

function fakeGraph(over = {}) {
  return {
    getSystemUsers: async () => ({ status: 200, body: { data: [] } }),
    createSystemUser: async () => ({ status: 200, body: { id: 'SU1' } }),
    assignSystemUserToWaba: async () => ({ status: 200, body: { success: true } }),
    createSystemUserToken: async () => ({ status: 200, body: { access_token: 'LONGLIVED-TOKEN' } }),
    ...over,
  };
}
function fakeSecrets(calls) {
  return { makeClient: () => ({}), putSecret: async (_c, n, v) => { calls.push([n, v]); } };
}

test('appSecretProof is deterministic 64-char hex and input-sensitive', () => {
  const a = appSecretProof('tok', 'secret');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, appSecretProof('tok', 'secret'));
  assert.notEqual(a, appSecretProof('tok2', 'secret'));
});

test('happy path creates the system user, stores the token, never returns it', async () => {
  const calls = [];
  const res = await runSystemUser(base, { repoRoot: await tmp(), region: 'us-east-1', graph: fakeGraph(), secrets: fakeSecrets(calls), onLog: () => {} });
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.ok(calls.some(([n, v]) => n.endsWith('-wa-access-token') && v === 'LONGLIVED-TOKEN'));
  assert.doesNotMatch(JSON.stringify(res), /LONGLIVED-TOKEN/);
});

test('reuses an existing system user by name', async () => {
  const calls = [];
  let createCalled = false;
  const g = fakeGraph({
    getSystemUsers: async () => ({ status: 200, body: { data: [{ id: 'SU9', name: 'qsr-wa-system-user' }] } }),
    createSystemUser: async () => { createCalled = true; return { status: 200, body: { id: 'X' } }; },
  });
  const res = await runSystemUser(base, { repoRoot: await tmp(), graph: g, secrets: fakeSecrets(calls), onLog: () => {} });
  assert.equal(res.ok, true);
  assert.equal(res.created, false);
  assert.equal(createCalled, false);
});

test('permission error on listing falls back with a clear reason and no put', async () => {
  const calls = [];
  const g = fakeGraph({ getSystemUsers: async () => ({ status: 200, body: { error: { code: 10 } } }) });
  const res = await runSystemUser(base, { repoRoot: await tmp(), graph: g, secrets: fakeSecrets(calls), onLog: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.reason, /admin token cannot manage|business_management|manually/);
  assert.equal(calls.length, 0);
});

test('token-mint failure reports a recoverable reason', async () => {
  const calls = [];
  const g = fakeGraph({ createSystemUserToken: async () => ({ status: 400, body: { error: { code: 100, message: 'bad param' } } }) });
  const res = await runSystemUser(base, { repoRoot: await tmp(), graph: g, secrets: fakeSecrets(calls), onLog: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.reason, /could not generate|manually/);
});

test('missing inputs short-circuits without any graph call', async () => {
  let touched = false;
  const g = fakeGraph({ getSystemUsers: async () => { touched = true; return { status: 200, body: { data: [] } }; } });
  const res = await runSystemUser({ adminToken: 'x' }, { repoRoot: await tmp(), graph: g, secrets: fakeSecrets([]), onLog: () => {} });
  assert.equal(res.ok, false);
  assert.equal(touched, false);
});
