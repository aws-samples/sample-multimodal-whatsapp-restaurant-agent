import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPermissionError } from '../lib/pure.mjs';

test('detects permission error codes', () => {
  assert.equal(isPermissionError({ error: { code: 10 } }), true);
  assert.equal(isPermissionError({ error: { code: 200 } }), true);
  assert.equal(isPermissionError({ error: { code: 803 } }), true);
});

test('detects OAuth permission/scope messages', () => {
  assert.equal(isPermissionError({ error: { type: 'OAuthException', message: 'Requires whatsapp_business_management permission' } }), true);
  assert.equal(isPermissionError({ error: { type: 'OAuthException', message: 'missing scope' } }), true);
});

test('does not flag normal responses or unrelated errors', () => {
  assert.equal(isPermissionError({ data: [{ id: 'W1' }] }), false);
  assert.equal(isPermissionError({}), false);
  assert.equal(isPermissionError(null), false);
  assert.equal(isPermissionError({ error: { code: 100, message: 'Unknown path' } }), false);
});
