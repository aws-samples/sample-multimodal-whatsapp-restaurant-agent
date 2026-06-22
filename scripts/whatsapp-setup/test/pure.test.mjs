// Unit tests for the WhatsApp setup CLI pure logic (Task 26.3).
//
// Pure-logic only: no live Meta account, no live AWS. Feeds plain JS values to
// the functions in lib/pure.mjs and asserts the decisions. Run with `npm test`
// (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEPLOYMENT_PREFIX_REGEX,
  secretNamesForPrefix,
  generateVerifyToken,
  redact,
  interpretTokenValidation,
  parsePhoneNumbers,
  parseWabas,
  selectSingleOrChoose,
  isAppSubscriptionConfigured,
  renderDeployCommand,
  renderConfigEnv,
  parseConfigEnv,
  appAccessToken,
  metaConsoleUrls,
} from '../lib/pure.mjs';

test('secret names are deterministic and prefixed (match the webhook stack)', () => {
  assert.deepEqual(secretNamesForPrefix('qsr-wa'), {
    accessToken: 'qsr-wa-wa-access-token',
    appSecret: 'qsr-wa-wa-app-secret',
    verifyToken: 'qsr-wa-wa-verify-token',
  });
});

test('deployment prefix regex matches the CDK pattern', () => {
  assert.ok(DEPLOYMENT_PREFIX_REGEX.test('qsr-wa'));
  assert.ok(!DEPLOYMENT_PREFIX_REGEX.test('Qsr'));
  assert.ok(!DEPLOYMENT_PREFIX_REGEX.test('1abc'));
  assert.ok(!DEPLOYMENT_PREFIX_REGEX.test('this-is-way-too-long-a-prefix'));
});

test('generateVerifyToken produces 48 lowercase hex chars', () => {
  const t = generateVerifyToken();
  assert.match(t, /^[0-9a-f]{48}$/);
  assert.notEqual(generateVerifyToken(), t); // randomness
});

test('redact never reveals the value', () => {
  assert.equal(redact(''), 'not set');
  assert.equal(redact(undefined), 'not set');
  const masked = redact('super-secret-token-value');
  assert.ok(!masked.includes('super-secret'));
  assert.equal(masked, 'set (24 chars)');
});

test('token validation: valid, expired, other error', () => {
  assert.deepEqual(interpretTokenValidation(200, { id: '123', name: 'App' }), {
    valid: true,
    reason: 'ok',
  });
  assert.equal(interpretTokenValidation(401, { error: { code: 190 } }).valid, false);
  assert.equal(interpretTokenValidation(200, { error: { code: 190 } }).reason, 'expired_or_invalid');
  const other = interpretTokenValidation(400, { error: { message: 'bad thing' } });
  assert.equal(other.valid, false);
  assert.match(other.reason, /bad thing/);
});

test('parsePhoneNumbers + parseWabas tolerate shape and map fields', () => {
  const phones = parsePhoneNumbers({
    data: [
      { id: '111', display_phone_number: '+1 212 555 0100', verified_name: 'Demo' },
      { id: '222' },
    ],
  });
  assert.equal(phones.length, 2);
  assert.equal(phones[0].displayPhoneNumber, '+1 212 555 0100');
  assert.equal(phones[1].displayPhoneNumber, '');
  assert.deepEqual(parsePhoneNumbers({}), []);

  const wabas = parseWabas({ data: [{ id: 'w1', name: 'Resto' }] });
  assert.deepEqual(wabas, [{ id: 'w1', name: 'Resto' }]);
});

test('selectSingleOrChoose: none / auto / choose', () => {
  assert.equal(selectSingleOrChoose([]).mode, 'none');
  assert.deepEqual(selectSingleOrChoose([{ id: 'x' }]), { mode: 'auto', value: { id: 'x' } });
  assert.equal(selectSingleOrChoose([{ id: 'a' }, { id: 'b' }]).mode, 'choose');
});

test('isAppSubscriptionConfigured: idempotent no-op detection', () => {
  const desired = { callbackUrl: 'https://abc.execute-api.us-east-1.amazonaws.com/prod/webhook', fields: ['messages', 'calls'] };

  // Already configured with both fields + matching URL -> no-op.
  const configured = {
    data: [
      {
        object: 'whatsapp_business_account',
        callback_url: desired.callbackUrl,
        fields: [{ name: 'messages' }, { name: 'calls' }],
      },
    ],
  };
  assert.equal(isAppSubscriptionConfigured(configured, desired), true);

  // Missing a field -> not configured.
  const partial = {
    data: [
      { object: 'whatsapp_business_account', callback_url: desired.callbackUrl, fields: ['messages'] },
    ],
  };
  assert.equal(isAppSubscriptionConfigured(partial, desired), false);

  // Different callback URL -> not configured.
  const wrongUrl = {
    data: [
      { object: 'whatsapp_business_account', callback_url: 'https://old/webhook', fields: ['messages', 'calls'] },
    ],
  };
  assert.equal(isAppSubscriptionConfigured(wrongUrl, desired), false);

  // No subscription at all -> not configured.
  assert.equal(isAppSubscriptionConfigured({ data: [] }, desired), false);
});

test('renderDeployCommand + renderConfigEnv contain only non-secret config', () => {
  const cfg = { prefix: 'qsr-wa', phoneNumberId: '111', wabaId: 'w1', appId: '999' };
  const cmd = renderDeployCommand(cfg);
  assert.match(cmd, /--deploymentPrefix qsr-wa/);
  assert.match(cmd, /--phone-number-id 111/);
  assert.match(cmd, /--waba-id w1/);
  assert.match(cmd, /--app-id 999/);

  const env = renderConfigEnv(cfg);
  assert.match(env, /WHATSAPP_PHONE_NUMBER_ID=111/);
  // No secret-bearing keys in the rendered config.
  assert.ok(!/TOKEN=|SECRET=/.test(env));
});

test('parseConfigEnv round-trips renderConfigEnv (post-deploy auto-load)', () => {
  const cfg = { prefix: 'qsr-wa', phoneNumberId: '111', wabaId: '222', appId: '333' };
  const parsed = parseConfigEnv(renderConfigEnv(cfg));
  assert.equal(parsed.WHATSAPP_DEPLOYMENT_PREFIX, 'qsr-wa');
  assert.equal(parsed.WHATSAPP_PHONE_NUMBER_ID, '111');
  assert.equal(parsed.WHATSAPP_WABA_ID, '222');
  assert.equal(parsed.WHATSAPP_APP_ID, '333');
});

test('parseConfigEnv ignores comments/blanks and keeps "=" in values', () => {
  const parsed = parseConfigEnv('# comment\n\nWHATSAPP_APP_ID=42\nFOO=a=b=c\n');
  assert.equal(parsed.WHATSAPP_APP_ID, '42');
  assert.equal(parsed.FOO, 'a=b=c');
  assert.equal('# comment' in parsed, false);
});

test('parseConfigEnv tolerates empty / undefined input', () => {
  assert.deepEqual(parseConfigEnv(''), {});
  assert.deepEqual(parseConfigEnv(undefined), {});
});

test('appAccessToken builds the app_id|app_secret app token (for /subscriptions)', () => {
  assert.equal(appAccessToken('123', 'abc'), '123|abc');
});

test('metaConsoleUrls builds app + WhatsApp links and includes business_id when known', () => {
  const u = metaConsoleUrls({ appId: '123', businessId: '456' });
  assert.equal(u.apps, 'https://developers.facebook.com/apps/');
  assert.ok(u.appDashboard.startsWith('https://developers.facebook.com/apps/123/dashboard/'));
  assert.ok(u.appDashboard.includes('business_id=456'));
  assert.ok(u.whatsappApiSetup.includes('/apps/123/use_cases/customize/wa-dev-console/'));
  assert.ok(u.whatsappApiSetup.includes('use_case_enum=WHATSAPP_BUSINESS_MESSAGING'));
  assert.ok(u.whatsappApiSetup.includes('business_id=456'));
});

test('metaConsoleUrls omits app-specific links without appId and business_id when unknown', () => {
  const none = metaConsoleUrls({});
  assert.equal(none.appDashboard, '');
  assert.equal(none.whatsappApiSetup, '');
  assert.equal(none.apps, 'https://developers.facebook.com/apps/');

  const noBiz = metaConsoleUrls({ appId: '123' });
  assert.equal(noBiz.appDashboard, 'https://developers.facebook.com/apps/123/dashboard/');
  assert.ok(!noBiz.whatsappApiSetup.includes('business_id'));
});
