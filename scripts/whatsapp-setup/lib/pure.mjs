// Pure, side-effect-free logic for the WhatsApp setup CLI (Task 26).
//
// Everything in this module is deterministic and free of network / AWS / prompt
// I/O so it can be unit-tested (Task 26.3) by feeding plain JS values. The thin
// I/O wrappers live in graph.mjs (Graph API) and secrets.mjs (Secrets Manager);
// the orchestration lives in whatsapp-setup.mjs.
//
// SECURITY: nothing here logs. Secret values are only ever passed through and
// returned, never printed. The `redact` helper exists so callers can show a
// safe hint without leaking the value (R11.6, R1.6).

import { randomBytes, createHmac } from 'node:crypto';

// The deployment prefix pattern shared by every CDK app in this repo
// (^[a-z][a-z0-9-]{1,19}$). Re-validated here so the CLI fails fast before it
// ever calls AWS with a name the stacks would reject.
export const DEPLOYMENT_PREFIX_REGEX = /^[a-z][a-z0-9-]{1,19}$/;

// The webhook stack (Task 3.2) creates three EMPTY Secrets Manager containers
// with these deterministic, deployment-prefixed names. The CLI populates these
// exact names - it never creates new secrets and never renames.
export function secretNamesForPrefix(prefix) {
  return {
    accessToken: `${prefix}-wa-access-token`,
    appSecret: `${prefix}-wa-app-secret`,
    verifyToken: `${prefix}-wa-verify-token`,
  };
}

// Generate a Verify Token: 24 random bytes -> 48 lowercase hex chars. Used for
// the Meta webhook subscription handshake (the operator may also supply one).
export function generateVerifyToken() {
  return randomBytes(24).toString('hex');
}

// Mask a secret for safe display: keep a tiny prefix length hint, never the
// value. Returns e.g. "set (24 chars)" so the operator gets feedback without a
// leak. NEVER returns any portion of the actual secret.
export function redact(value) {
  if (value === undefined || value === null || value === '') {
    return 'not set';
  }
  const len = String(value).length;
  return `set (${len} chars)`;
}

// Interpret a Graph API token-validation response. `status` is the HTTP status,
// `body` is the parsed JSON. Returns { valid, reason }. A 200 with an `id` means
// the token authenticates; a 190 error subcode means expired/invalid.
export function interpretTokenValidation(status, body) {
  if (status === 200 && body && typeof body.id === 'string') {
    return { valid: true, reason: 'ok' };
  }
  const err = (body && body.error) || {};
  if (err.code === 190 || status === 401) {
    return {
      valid: false,
      reason: 'expired_or_invalid',
    };
  }
  return {
    valid: false,
    reason: err.message ? `graph_error: ${err.message}` : `http_${status}`,
  };
}

// Detect a Graph permission/authorization error (insufficient scopes, or no
// access to the business object) from a parsed response body, so the caller can
// tell the operator to use a business-scoped token instead of showing a generic
// "not found". Token-expired (190) is interpreted separately.
export function isPermissionError(body) {
  const err = (body && body.error) || {};
  if ([10, 200, 272, 803].includes(err.code)) return true;
  if (err.type === 'OAuthException' && /permission|scope|whatsapp_business_management|business_management/i.test(err.message || '')) return true;
  return false;
}

// Given the JSON from GET /{waba-id}/phone_numbers, return the list of
// { id, displayPhoneNumber, verifiedName } entries (defensive against shape).
export function parsePhoneNumbers(body) {
  const data = (body && Array.isArray(body.data)) ? body.data : [];
  return data.map((p) => ({
    id: p.id,
    displayPhoneNumber: p.display_phone_number || '',
    verifiedName: p.verified_name || '',
  }));
}

// Given a list of WABAs (from GET /{business-id}/owned_whatsapp_business_accounts
// or the app's shared WABAs), return { id, name } entries.
export function parseWabas(body) {
  const data = (body && Array.isArray(body.data)) ? body.data : [];
  return data.map((w) => ({ id: w.id, name: w.name || '' }));
}

// Selection helper: when exactly one candidate exists, auto-pick it; when many,
// signal that the caller must prompt; when none, signal not-found. Pure so the
// prompt path is testable. Returns { mode: 'auto'|'choose'|'none', value? }.
export function selectSingleOrChoose(candidates) {
  if (!candidates || candidates.length === 0) {
    return { mode: 'none' };
  }
  if (candidates.length === 1) {
    return { mode: 'auto', value: candidates[0] };
  }
  return { mode: 'choose' };
}

// Idempotent no-op detection for the app subscription. `existing` is the parsed
// GET /{app-id}/subscriptions response; we consider the whatsapp_business_account
// object subscribed with the desired fields a no-op. Returns true when already
// configured with at least the desired fields and matching callback URL.
export function isAppSubscriptionConfigured(existing, desired) {
  const data = (existing && Array.isArray(existing.data)) ? existing.data : [];
  const wba = data.find((d) => d.object === 'whatsapp_business_account');
  if (!wba) return false;
  if (wba.callback_url !== desired.callbackUrl) return false;
  const have = new Set(
    (wba.fields || []).map((f) => (typeof f === 'string' ? f : f.name)),
  );
  return desired.fields.every((f) => have.has(f));
}

// Render the copy-pasteable deploy-all.sh invocation for the non-secret config.
// Secret values are NEVER included here (they go to Secrets Manager only).
export function renderDeployCommand({ prefix, phoneNumberId, wabaId, appId }) {
  return [
    './scripts/deploy-all.sh \\',
    `  --deploymentPrefix ${prefix} \\`,
    `  --phone-number-id ${phoneNumberId} \\`,
    `  --waba-id ${wabaId} \\`,
    `  --app-id ${appId}`,
  ].join('\n');
}

// Render a dotenv-style block for the non-secret config the operator can source
// before running deploy-all. No secrets here.
export function renderConfigEnv({ prefix, phoneNumberId, wabaId, appId }) {
  return [
    '# WhatsApp non-secret config emitted by whatsapp-setup (no secrets here).',
    '# Secrets live only in AWS Secrets Manager, populated by this CLI.',
    `WHATSAPP_DEPLOYMENT_PREFIX=${prefix}`,
    `WHATSAPP_PHONE_NUMBER_ID=${phoneNumberId}`,
    `WHATSAPP_WABA_ID=${wabaId}`,
    `WHATSAPP_APP_ID=${appId}`,
    '',
  ].join('\n');
}

// Build a Meta APP access token from the app id + app secret: "app_id|app_secret".
// The app-level Graph endpoints (notably POST /{app-id}/subscriptions) reject a
// user / System User token with error code 15 and require this app token. It is
// only ever sent in the Authorization header, never logged.
export function appAccessToken(appId, appSecret) {
  return `${appId}|${appSecret}`;
}

// Compute appsecret_proof for a Graph call: HMAC-SHA256 of the access token used
// on the call, keyed by the app secret, hex-encoded. Required for server-side
// calls when the app enforces proof (and for System User token generation).
export function appSecretProof(accessToken, appSecret) {
  return createHmac('sha256', String(appSecret)).update(String(accessToken)).digest('hex');
}

// Build the Meta dashboard URLs that help an operator find each value, given
// what we know so far. Pure: the app-specific links are only produced once the
// App ID is known, and business_id is appended only when supplied (it makes the
// links land more directly but is optional). The CLI prints these (and can open
// them) right before the matching prompt, so the operator is never hunting the
// console blind.
export function metaConsoleUrls({ appId, businessId } = {}) {
  const apps = 'https://developers.facebook.com/apps/';
  let appDashboard = '';
  let whatsappApiSetup = '';
  if (appId) {
    const bizQ = businessId ? `?business_id=${businessId}` : '';
    appDashboard = `https://developers.facebook.com/apps/${appId}/dashboard/${bizQ}`;
    const base =
      `https://developers.facebook.com/apps/${appId}/use_cases/customize/wa-dev-console/` +
      '?use_case_enum=WHATSAPP_BUSINESS_MESSAGING&selected_tab=wa-dev-console&product_route=whatsapp-business';
    whatsappApiSetup = businessId ? `${base}&business_id=${businessId}` : base;
  }
  return { apps, appDashboard, whatsappApiSetup };
}
// object. Blank lines and `#` comments are ignored; only the first `=` splits a
// line (values may contain `=`). Pure, so the post-deploy auto-load is testable
// without touching the filesystem.
export function parseConfigEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
