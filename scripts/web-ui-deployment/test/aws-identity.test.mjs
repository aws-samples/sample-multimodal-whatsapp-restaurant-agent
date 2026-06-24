import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdentityArn, classifyStsError, shapeIdentity } from '../lib/aws-identity.mjs';

test('parseIdentityArn extracts a friendly principal', () => {
  assert.equal(parseIdentityArn('arn:aws:sts::123456789012:assumed-role/Admin/sess'), 'role Admin');
  assert.equal(parseIdentityArn('arn:aws:iam::123456789012:user/jane'), 'user jane');
  assert.equal(parseIdentityArn('arn:aws:iam::123456789012:root'), 'account root');
  assert.equal(parseIdentityArn(''), 'unknown');
});

test('classifyStsError detects expired vs missing credentials', () => {
  assert.deepEqual(classifyStsError('An error occurred (ExpiredToken) ...', 255), { expired: true, missing: false });
  assert.deepEqual(classifyStsError('The security token included in the request is expired', 255).expired, true);
  assert.deepEqual(classifyStsError('Unable to locate credentials', 255), { expired: false, missing: true });
  assert.deepEqual(classifyStsError('some other error', 1), { expired: false, missing: false });
});

test('shapeIdentity maps get-caller-identity JSON', () => {
  const s = shapeIdentity({ Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/Admin/x', UserId: 'AROA:x' });
  assert.equal(s.ok, true);
  assert.equal(s.account, '123456789012');
  assert.equal(s.display, 'role Admin');
  assert.equal(s.expired, false);
});
