import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../lib/doctor.mjs';

const healthy = {
  secretsPresent: { accessToken: true, appSecret: true, verifyToken: true },
  phoneNumberId: '123456',
  webhookUrl: 'https://x.execute-api.us-east-1.amazonaws.com/prod/webhook',
  appSubscription: true,
  wabaSubscribed: true,
  handshake: { ok: true, status: 200 },
};

test('a fully healthy deployment passes every check', () => {
  const r = evaluate(healthy);
  assert.equal(r.ok, true);
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(r.checks.length, 6);
});

test('empty secrets fail the secrets check with the missing ones named', () => {
  const r = evaluate({ ...healthy, secretsPresent: { accessToken: false, appSecret: true, verifyToken: false } });
  const c = r.checks.find((x) => x.id === 'secrets');
  assert.equal(c.ok, false);
  assert.match(c.detail, /accessToken/);
  assert.match(c.detail, /verifyToken/);
  assert.ok(c.remediation);
  assert.equal(r.ok, false);
});

test('a failed handshake is reported with remediation and no secret leak', () => {
  const r = evaluate({ ...healthy, handshake: { ok: false, status: 403 } });
  const c = r.checks.find((x) => x.id === 'handshake');
  assert.equal(c.ok, false);
  assert.match(c.detail, /403/);
  assert.match(c.remediation, /Verify Token/);
  // detail/remediation never include a token value
  assert.doesNotMatch(JSON.stringify(r), /verify_token=/);
});

test('not-checked subscription/handshake are failing (incomplete) with a clear note', () => {
  const r = evaluate({
    secretsPresent: { accessToken: true, appSecret: true, verifyToken: true },
    phoneNumberId: '1', webhookUrl: 'https://x/webhook',
    appSubscription: null, wabaSubscribed: null, handshake: null,
  });
  assert.equal(r.ok, false);
  for (const id of ['app-sub', 'waba-sub', 'handshake']) {
    const c = r.checks.find((x) => x.id === id);
    assert.equal(c.ok, false);
    assert.match(c.detail, /not checked/);
  }
});

test('missing phone number id and webhook url fail their checks', () => {
  const r = evaluate({ ...healthy, phoneNumberId: '', webhookUrl: '' });
  assert.equal(r.checks.find((x) => x.id === 'phone').ok, false);
  assert.equal(r.checks.find((x) => x.id === 'webhook-url').ok, false);
});
