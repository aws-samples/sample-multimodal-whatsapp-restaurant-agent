// Post-setup health check ("doctor") for the WhatsApp Restaurant AI Host.
//
// Read-only end-to-end readiness check, shared by the whatsapp-setup CLI
// (--doctor) and the web installer ("Verify configuration"). It answers the one
// question that mattered in the field incident: "will the agent actually reply,
// and if not, exactly why?"
//
// Checks: the three Meta secrets hold values, the Phone Number ID is set, the
// webhook URL exists, the Meta app subscription includes the callback URL + the
// messages field, the WABA is subscribed, and the live verify-handshake echoes
// our challenge. Performs NO mutation and NEVER prints or returns a secret value
// (only presence/length and non-secret identifiers).
//
// `evaluate(obs)` is pure (testable); `runDoctor(opts)` does the I/O and feeds it.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));   // scripts/whatsapp-setup/lib

async function loadDeps(opts = {}) {
  const imp = (n) => import(pathToFileURL(join(HERE, n)).href);
  return {
    pure: opts.pure || (await imp('pure.mjs')),
    graph: opts.graph || (await imp('graph.mjs')),
    secrets: opts.secrets || (await imp('secrets.mjs')),
  };
}

// Pure: turn raw observations into a structured report. A check is ok=false when
// it failed OR could not be run (a missing prerequisite); detail explains which.
export function evaluate(obs) {
  const o = obs || {};
  const sp = o.secretsPresent || {};
  const checks = [];
  const add = (id, label, ok, detail, remediation) => checks.push({ id, label, ok: !!ok, detail: detail || '', ...(ok ? {} : { remediation }) });

  const missingSecrets = ['accessToken', 'appSecret', 'verifyToken'].filter((k) => !sp[k]);
  add('secrets', 'Meta secrets populated', missingSecrets.length === 0,
    missingSecrets.length ? `empty: ${missingSecrets.join(', ')}` : 'access token, app secret, verify token all set',
    'Run the WhatsApp setup pre-deploy step to populate them (cd scripts/whatsapp-setup && node whatsapp-setup.mjs, choose Pre-deploy).');

  add('phone', 'Phone Number ID set', !!o.phoneNumberId,
    o.phoneNumberId ? 'set' : 'not set',
    'Provide the Phone Number ID and redeploy the webhook layer (it is a stack parameter).');

  add('webhook-url', 'Webhook endpoint deployed', !!o.webhookUrl,
    o.webhookUrl ? o.webhookUrl : 'cdk-outputs/wa-webhook.json missing or has no WebhookUrl',
    'Deploy the wa-webhook layer (./scripts/deploy-all.sh --only wa-webhook --with-deps).');

  if (o.appSubscription === null || o.appSubscription === undefined) {
    add('app-sub', 'Meta app webhook subscription', false, 'not checked (needs App ID, App Secret, and a webhook URL)',
      'Provide App ID + App Secret and deploy the webhook, then run the post-deploy step.');
  } else {
    add('app-sub', 'Meta app webhook subscription', o.appSubscription,
      o.appSubscription ? 'callback URL + messages field configured' : 'callback URL or messages field not configured in Meta',
      'Run the WhatsApp post-deploy step to set the callback URL + Verify Token + messages field.');
  }

  if (o.wabaSubscribed === null || o.wabaSubscribed === undefined) {
    add('waba-sub', 'WABA subscribed to the app', false, 'not checked (needs Access Token + WABA ID)',
      'Run the post-deploy step to subscribe your WhatsApp Business Account.');
  } else {
    add('waba-sub', 'WABA subscribed to the app', o.wabaSubscribed,
      o.wabaSubscribed ? 'subscribed' : 'the WABA is not subscribed to this app',
      'Run the post-deploy step to subscribe your WhatsApp Business Account.');
  }

  const hs = o.handshake;
  if (!hs) {
    add('handshake', 'Live webhook verify handshake', false, 'not checked (needs the webhook URL + a stored Verify Token)',
      'Deploy the webhook and populate the Verify Token, then re-run this check.');
  } else {
    add('handshake', 'Live webhook verify handshake', hs.ok,
      hs.ok ? 'Meta verification GET returns 200 and echoes the challenge'
            : `verification GET did not echo the challenge (http ${hs.status ?? '?'})`,
      'Token mismatch or missing subscription: re-run the post-deploy step so Meta and the deployment use the same Verify Token.');
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// Read-only live verify handshake against our own webhook. The Verify Token
// travels in the query (exactly as Meta sends it) to our endpoint only; it is
// never logged and never placed in the returned report.
async function doHandshake(webhookUrl, verifyToken, fetchImpl) {
  const f = fetchImpl || fetch;
  const challenge = 'wa-doctor-' + randomBytes(6).toString('hex');
  let u;
  try { u = new URL(webhookUrl); } catch { return { ok: false, status: 0 }; }
  u.searchParams.set('hub.mode', 'subscribe');
  u.searchParams.set('hub.verify_token', verifyToken);
  u.searchParams.set('hub.challenge', challenge);
  try {
    const resp = await f(u, { method: 'GET' });
    const text = (await resp.text()).trim();
    return { ok: resp.status === 200 && text === challenge, status: resp.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Gather observations (secrets presence, ids, subscription, handshake) and
// evaluate. opts: { repoRoot, region, prefix?, pure/graph/secrets (test fakes),
// fetchImpl (test) }. Returns { ok, checks }.
export async function runDoctor(opts = {}) {
  const region = opts.region || process.env.AWS_REGION || 'us-east-1';
  const repoRoot = opts.repoRoot || join(HERE, '..', '..', '..');
  const { pure, graph, secrets } = await loadDeps(opts);

  // Non-secret config.
  let cfg = {};
  const cfgPath = join(repoRoot, '.deploy-tmp', 'whatsapp-config.env');
  if (existsSync(cfgPath)) { try { cfg = pure.parseConfigEnv(await readFile(cfgPath, 'utf8')); } catch { cfg = {}; } }
  const prefix = String(opts.prefix || cfg.WHATSAPP_DEPLOYMENT_PREFIX || 'qsr-wa').trim();
  const appId = String(cfg.WHATSAPP_APP_ID || '').trim();
  const wabaId = String(cfg.WHATSAPP_WABA_ID || '').trim();
  const phoneNumberId = String(cfg.WHATSAPP_PHONE_NUMBER_ID || '').trim();

  // Secret values (presence only is reported; values are used locally for the
  // app token + handshake and never returned/logged).
  const names = pure.secretNamesForPrefix(prefix);
  const client = secrets.makeClient(region);
  const accessToken = String((await secrets.getSecret(client, names.accessToken)) || '');
  const appSecret = String((await secrets.getSecret(client, names.appSecret)) || '');
  const verifyToken = String((await secrets.getSecret(client, names.verifyToken)) || '');
  const secretsPresent = {
    accessToken: !!accessToken, appSecret: !!appSecret, verifyToken: !!verifyToken,
  };

  // Webhook URL from cdk-outputs.
  let webhookUrl = '';
  const outPath = join(repoRoot, 'cdk-outputs', 'wa-webhook.json');
  if (existsSync(outPath)) {
    try {
      const outputs = JSON.parse(await readFile(outPath, 'utf8'));
      for (const stack of Object.values(outputs || {})) {
        if (stack && typeof stack === 'object' && stack.WebhookUrl) { webhookUrl = stack.WebhookUrl; break; }
      }
    } catch { /* leave empty */ }
  }

  // App subscription (needs app token + webhook URL).
  let appSubscription = null;
  if (appId && appSecret && webhookUrl) {
    try {
      const appToken = pure.appAccessToken(appId, appSecret);
      const existing = await graph.getAppSubscriptions(appToken, appId);
      appSubscription = pure.isAppSubscriptionConfigured(existing.body, { callbackUrl: webhookUrl, fields: ['messages'] });
    } catch { appSubscription = false; }
  }

  // WABA subscribed (needs access token + WABA id).
  let wabaSubscribed = null;
  if (accessToken && wabaId) {
    try {
      const subs = await graph.getSubscribedApps(accessToken, wabaId);
      const data = (subs.body && Array.isArray(subs.body.data)) ? subs.body.data : [];
      wabaSubscribed = data.length > 0;
    } catch { wabaSubscribed = false; }
  }

  // Live verify handshake (needs webhook URL + verify token).
  let handshake = null;
  if (webhookUrl && verifyToken) handshake = await doHandshake(webhookUrl, verifyToken, opts.fetchImpl);

  return evaluate({ secretsPresent, phoneNumberId, webhookUrl, appSubscription, wabaSubscribed, handshake });
}
