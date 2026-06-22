// Thin Graph API wrappers for the WhatsApp setup CLI (Task 26).
//
// All network I/O is isolated here so the pure logic in pure.mjs stays testable
// and so every request goes through one place that NEVER logs the access token
// or any secret. Uses the Node 18+ global `fetch` (no axios). Node 24 is the
// repo runtime.
//
// The access token is sent in the Authorization header (not the query string)
// so it never lands in any URL that could be logged by an intermediary.

export const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Low-level request. Returns { status, body } where body is parsed JSON (or {}).
// `token` is the bearer access token - it is placed in the Authorization header
// ONLY and is never interpolated into the URL or logged.
async function graphRequest(method, path, { token, query, form, json } = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers = { Authorization: `Bearer ${token}` };
  let bodyInit;
  if (json !== undefined) {
    // Nested-object bodies (e.g. the calling settings object) must be JSON; a
    // urlencoded form cannot represent them.
    headers['Content-Type'] = 'application/json';
    bodyInit = JSON.stringify(json);
  } else if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    bodyInit = params.toString();
  }
  const resp = await fetch(url, { method, headers, body: bodyInit });
  let body = {};
  try {
    body = await resp.json();
  } catch {
    body = {};
  }
  return { status: resp.status, body };
}

// GET /me - cheapest token-validation probe. Returns { status, body }.
export function getMe(token) {
  return graphRequest('GET', '/me', { token, query: { fields: 'id,name' } });
}

// GET /{app-id} - confirms the token can see the app.
export function getApp(token, appId) {
  return graphRequest('GET', `/${appId}`, { token, query: { fields: 'id,name' } });
}

// GET /{waba-id}/phone_numbers - discover phone numbers under a WABA.
export function getPhoneNumbers(token, wabaId) {
  return graphRequest('GET', `/${wabaId}/phone_numbers`, {
    token,
    query: { fields: 'id,display_phone_number,verified_name' },
  });
}

// GET /{business-id}/owned_whatsapp_business_accounts - discover WABAs owned by
// the business behind the token. Some setups expose shared WABAs instead; the
// caller can also accept a WABA id directly.
export function getOwnedWabas(token, businessId) {
  return graphRequest('GET', `/${businessId}/owned_whatsapp_business_accounts`, {
    token,
    query: { fields: 'id,name' },
  });
}

// GET /{app-id}/subscriptions - read existing webhook subscriptions (for the
// idempotent no-op check).
export function getAppSubscriptions(token, appId) {
  return graphRequest('GET', `/${appId}/subscriptions`, { token });
}

// POST /{app-id}/subscriptions - set the webhook callback URL + verify token +
// fields for the whatsapp_business_account object. The verify_token is a secret;
// it travels in the POST body (form), never the URL, and is never logged.
export function setAppSubscription(token, appId, { callbackUrl, verifyToken, fields }) {
  return graphRequest('POST', `/${appId}/subscriptions`, {
    token,
    form: {
      object: 'whatsapp_business_account',
      callback_url: callbackUrl,
      verify_token: verifyToken,
      fields: fields.join(','),
    },
  });
}

// POST /{waba-id}/subscribed_apps - subscribe the app to the WABA so Meta
// delivers that WABA's events to the configured callback URL.
export function subscribeWaba(token, wabaId) {
  return graphRequest('POST', `/${wabaId}/subscribed_apps`, { token });
}

// GET /{waba-id}/subscribed_apps - read current WABA app subscription (idempotency).
export function getSubscribedApps(token, wabaId) {
  return graphRequest('GET', `/${wabaId}/subscribed_apps`, { token });
}

// POST /{waba-id}/message_templates - create a Utility template (optional).
export function createMessageTemplate(token, wabaId, template) {
  return graphRequest('POST', `/${wabaId}/message_templates`, {
    token,
    form: {
      name: template.name,
      language: template.language,
      category: 'UTILITY',
      components: JSON.stringify(template.components),
    },
  });
}

// GET /{phone-number-id}/settings - read the number's settings, including the
// `calling` object (status, call_hours, codecs, ...). Used to confirm calling
// enablement.
export function getPhoneNumberSettings(token, phoneNumberId) {
  return graphRequest('GET', `/${phoneNumberId}/settings`, { token });
}

// POST /{phone-number-id}/settings - enable (or update) the WhatsApp Calling API
// on the number. Calling is OFF by default on every number; this turns it on so
// customers can place inbound (user-initiated) calls. Body is JSON with a nested
// `calling` object. Pass extra fields (call_hours, audio.additional_codecs,
// callback_permission_status, ...) by overriding `calling`.
export function setCallingSettings(token, phoneNumberId, calling = { status: 'ENABLED' }) {
  return graphRequest('POST', `/${phoneNumberId}/settings`, { token, json: { calling } });
}
