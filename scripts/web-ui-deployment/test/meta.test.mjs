import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validatePreInput, runPreDeploy, runPostDeploy, preGate, postGate, WEBHOOK_FIELDS,
} from '../lib/meta.mjs';

// Secret values used across tests - assertions check these never leak.
const ACCESS = 'ACCESS-TOKEN-SECRET-zzz';
const APP_SECRET = 'APP-SECRET-SECRET-yyy';
const VERIFY = 'VERIFY-TOKEN-SECRET-xxx';

function fakeGraphOk(overrides = {}) {
  return {
    getMe: async () => ({ status: 200, body: { id: '111', name: 'Test' } }),
    getOwnedWabas: async () => ({ status: 200, body: { data: [{ id: 'W1', name: 'Acme' }] } }),
    getPhoneNumbers: async () => ({ status: 200, body: { data: [{ id: 'P1', display_phone_number: '+1 555 0100', verified_name: 'Acme' }] } }),
    getAppSubscriptions: async () => ({ status: 200, body: { data: [] } }),
    setAppSubscription: async () => ({ status: 200, body: { success: true } }),
    subscribeWaba: async () => ({ status: 200, body: { success: true } }),
    setCallingSettings: async () => ({ status: 200, body: {} }),
    getPhoneNumberSettings: async () => ({ status: 200, body: { calling: { status: 'ENABLED' } } }),
    ...overrides,
  };
}

function fakeSecrets(putCalls = []) {
  return {
    makeClient: () => ({}),
    checkSecretsExist: async () => ({ ok: true, missing: [] }),
    putSecret: async (_c, id, val) => { putCalls.push({ id, val }); return 'v1'; },
    getSecret: async (_c, id) => {
      if (id.endsWith('access-token')) return ACCESS;
      if (id.endsWith('verify-token')) return VERIFY;
      if (id.endsWith('app-secret')) return APP_SECRET;
      return '';
    },
  };
}

async function tmpRepo() {
  return mkdtemp(join(tmpdir(), 'waui-meta-'));
}

test('preGate / postGate expose educational fields without secrets', () => {
  const pre = preGate();
  assert.equal(pre.kind, 'meta-pre');
  const names = pre.fields.map((f) => f.name);
  for (const n of ['appId', 'appSecret', 'accessToken', 'verifyToken', 'wabaId', 'deploymentPrefix']) {
    assert.ok(names.includes(n), `missing field ${n}`);
  }
  // every field has help text (teach-as-you-go)
  for (const f of pre.fields) assert.ok(f.help && f.help.length > 0, `${f.name} needs help`);
  // secret fields are marked
  assert.ok(pre.fields.find((f) => f.name === 'appSecret').secret);
  assert.ok(pre.fields.find((f) => f.name === 'accessToken').secret);
  assert.equal(postGate().action, 'wire-webhook');
});

test('validatePreInput rejects missing required values', () => {
  assert.equal(validatePreInput({}).ok, false);
  assert.equal(validatePreInput({ appId: 'x', appSecret: 's', accessToken: 't', wabaId: '1' }).ok, false); // appId not numeric
  assert.equal(validatePreInput({ appId: '12', appSecret: 's', accessToken: 't' }).ok, false); // no waba/business
  assert.equal(validatePreInput({ appId: '12', appSecret: 's', accessToken: 't', wabaId: '9' }).ok, true);
});

test('runPreDeploy happy path validates, populates 3 secrets, writes non-secret config', async () => {
  const repoRoot = await tmpRepo();
  const putCalls = [];
  const logs = [];
  const res = await runPreDeploy(
    { appId: '12345', appSecret: APP_SECRET, accessToken: ACCESS, wabaId: 'W1', phoneNumberId: 'P1', deploymentPrefix: 'qsr-wa' },
    { repoRoot, region: 'us-east-1', onLog: (l) => logs.push(l), graph: fakeGraphOk(), secrets: fakeSecrets(putCalls) },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.config, { appId: '12345', wabaId: 'W1', phoneNumberId: 'P1', prefix: 'qsr-wa' });
  assert.equal(res.verifyTokenGenerated, true);
  assert.equal(putCalls.length, 3);
  // config file written with NO secret values
  const cfg = await readFile(join(repoRoot, '.deploy-tmp', 'whatsapp-config.env'), 'utf8');
  assert.ok(cfg.includes('WHATSAPP_APP_ID=12345'));
  for (const secret of [ACCESS, APP_SECRET, VERIFY]) assert.ok(!cfg.includes(secret), 'secret leaked into config file');
  // secret hygiene: no secret value in any log line
  for (const line of logs) for (const secret of [ACCESS, APP_SECRET]) assert.ok(!line.includes(secret), `secret leaked in log: ${line}`);
});

test('runPreDeploy reports invalid token', async () => {
  const res = await runPreDeploy(
    { appId: '1', appSecret: 's', accessToken: 'bad', wabaId: 'W1', phoneNumberId: 'P1' },
    { repoRoot: await tmpRepo(), graph: fakeGraphOk({ getMe: async () => ({ status: 401, body: { error: { code: 190, message: 'expired' } } }) }), secrets: fakeSecrets() },
  );
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'validate');
});

test('runPreDeploy returns a choice when multiple WABAs are discovered', async () => {
  const res = await runPreDeploy(
    { appId: '1', appSecret: 's', accessToken: ACCESS, businessId: 'B1' },
    {
      repoRoot: await tmpRepo(),
      graph: fakeGraphOk({ getOwnedWabas: async () => ({ status: 200, body: { data: [{ id: 'W1', name: 'A' }, { id: 'W2', name: 'B' }] } }) }),
      secrets: fakeSecrets(),
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.needChoice.kind, 'waba');
  assert.equal(res.needChoice.options.length, 2);
});

test('runPreDeploy reports missing secret containers', async () => {
  const res = await runPreDeploy(
    { appId: '1', appSecret: 's', accessToken: ACCESS, wabaId: 'W1', phoneNumberId: 'P1' },
    {
      repoRoot: await tmpRepo(),
      graph: fakeGraphOk(),
      secrets: { ...fakeSecrets(), checkSecretsExist: async () => ({ ok: false, missing: ['qsr-wa-wa-access-token'] }) },
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'secrets-missing');
});

test('runPostDeploy wires the webhook from outputs + secrets', async () => {
  const repoRoot = await tmpRepo();
  await mkdir(join(repoRoot, 'cdk-outputs'), { recursive: true });
  await writeFile(join(repoRoot, 'cdk-outputs', 'wa-webhook.json'), JSON.stringify({ WebhookStack: { WebhookUrl: 'https://example.test/webhook' } }), 'utf8');
  const logs = [];
  const res = await runPostDeploy(
    { appId: '12345', wabaId: 'W1', phoneNumberId: 'P1', deploymentPrefix: 'qsr-wa' },
    { repoRoot, onLog: (l) => logs.push(l), graph: fakeGraphOk(), secrets: fakeSecrets() },
  );
  assert.equal(res.ok, true);
  assert.ok(res.steps.find((s) => s.label === 'App webhook subscription' && s.ok));
  assert.ok(res.steps.find((s) => s.label === 'Subscribe WABA' && s.ok));
  // secret hygiene: secrets read from "Secrets Manager" never appear in logs
  for (const line of logs) for (const secret of [ACCESS, APP_SECRET, VERIFY]) assert.ok(!line.includes(secret), `secret leaked in post log: ${line}`);
});

test('WEBHOOK_FIELDS are messages + calls', () => {
  assert.deepEqual(WEBHOOK_FIELDS, ['messages', 'calls']);
});
