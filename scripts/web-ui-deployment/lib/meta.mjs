// Meta/WhatsApp onboarding adapter for the web UI installer.
//
// Drives the EXISTING whatsapp-setup logic (scripts/whatsapp-setup/lib) in
// process: token validation, WABA/Phone Number discovery, Verify Token
// generation, Secrets Manager population, and webhook wiring. No Meta logic is
// reimplemented here - this module only sequences the existing lib functions
// and maps each step to installer events.
//
// Why in-process (not spawning whatsapp-setup.mjs): that CLI's post-deploy flow
// has an ungated interactive confirm() for the optional template, which would
// hang when run headless. Calling the lib directly gives full control and no
// TTY dependency.
//
// SECURITY: secret values (access token, App Secret, Verify Token) are held
// only in the arguments passed to these functions. They are NEVER passed to the
// onLog callback, never returned, and never written to disk except into AWS
// Secrets Manager via the existing secrets lib. Callers must keep them out of
// any streamed event.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));     // scripts/web-ui-deployment/lib
const WHATSAPP_LIB = join(HERE, '..', '..', 'whatsapp-setup', 'lib');

export const WEBHOOK_FIELDS = ['messages', 'calls'];
export const DEFAULT_PREFIX = 'qsr-wa';

// Lazily load the whatsapp-setup lib modules. pure + graph are dependency-free;
// secrets pulls in the AWS SDK, so we only touch it when actually populating or
// reading secrets. Tests inject fakes via `opts` so neither the SDK nor the
// network is loaded. Imports use file URLs for cross-platform safety.
async function loadDeps(opts = {}) {
  const imp = (name) => import(pathToFileURL(join(WHATSAPP_LIB, name)).href);
  const pure = opts.pure || (await imp('pure.mjs'));
  const graph = opts.graph || (await imp('graph.mjs'));
  const secrets = opts.secrets || (await imp('secrets.mjs'));
  return { pure, graph, secrets };
}

// ---------------------------------------------------------------------------
// Gate descriptors (what the UI renders). All educational copy lives here so
// the form teaches what each value is and where to get it (R6, R7.7, R13.3).
// ---------------------------------------------------------------------------

// The pre-deploy gate: collect Meta values, with inline help + which console
// page each comes from. `urlKey` maps to a key resolvable by resolveConsoleUrl.
// `prefill` pre-fills the NON-SECRET fields (App ID / WABA ID / Phone Number ID /
// prefix) from the saved config; secrets are never prefilled.
export function preGate(prefill = {}) {
  const def = (k, fb = '') => (prefill[k] != null && String(prefill[k]).trim() !== '' ? String(prefill[k]) : fb);
  return {
    kind: 'meta-pre',
    title: 'Connect your WhatsApp (Meta) app',
    help:
      'You must already have created a Meta app and added the WhatsApp product in the Meta console - ' +
      'no API can create the app for you. Open the apps page below to find or create it, then fill in the values.',
    consoleUrls: ['apps'],
    fields: [
      {
        name: 'appId', label: 'App ID', type: 'text', required: true, default: def('appId'),
        urlKey: 'appDashboard',
        help: 'Meta App Dashboard -> App Settings -> Basic -> "App ID" (a numeric id).',
      },
      {
        name: 'appSecret', label: 'App Secret', type: 'password', secret: true, reveal: true, required: true,
        urlKey: 'appDashboard',
        help:
          'App Settings -> Basic -> "App Secret" -> Show. This is NOT the access token - it is used ' +
          'to verify that incoming webhooks really came from Meta (signature check). Click the eye to load ' +
          'the value already stored in AWS Secrets Manager.',
      },
      {
        name: 'accessToken', label: 'Access Token', type: 'password', secret: true, reveal: true, required: true,
        urlKey: 'whatsappApiSetup',
        help:
          'WhatsApp -> API Setup: the temporary 24-hour token, or a long-lived System User token. ' +
          'Used to send messages and call the Graph API. Click the eye to load the value already stored in ' +
          'AWS Secrets Manager (e.g. to keep it and only change something else).',
      },
      {
        name: 'businessId', label: 'Business (portfolio) ID', type: 'text', required: false,
        help:
          'Optional. If given, the installer auto-discovers your WABA and deep-links the console. ' +
          'Provide this OR the WABA ID below.',
      },
      {
        name: 'wabaId', label: 'WhatsApp Business Account (WABA) ID', type: 'text', required: false, default: def('wabaId'),
        help:
          'Optional if you gave a Business ID above (it will be auto-discovered when you have exactly one). ' +
          'Numeric.',
      },
      {
        name: 'phoneNumberId', label: 'Phone Number ID', type: 'text', required: false, default: def('phoneNumberId'),
        help: 'Optional - auto-discovered from the WABA when there is exactly one number. Numeric.',
      },
      {
        name: 'verifyToken', label: 'Verify Token', type: 'password', secret: true, reveal: true, required: false,
        help:
          'You INVENT this value - it is not from Meta. It is only a shared secret for the webhook ' +
          'handshake: Meta echoes it back and our Lambda checks it matches. Leave blank to auto-generate ' +
          '(recommended), or click the eye to load the value already stored.',
      },
      {
        name: 'deploymentPrefix', label: 'Deployment prefix', type: 'text', required: false,
        default: def('deploymentPrefix', DEFAULT_PREFIX),
        help: 'Resource-name prefix; must match the deploy (default qsr-wa).',
      },
    ],
  };
}

// Load the NON-SECRET Meta config (App ID / WABA ID / Phone Number ID / prefix)
// the pre-deploy step wrote to .deploy-tmp/whatsapp-config.env, so a re-open can
// prefill those fields. Returns {} when absent. Never returns a secret.
export async function loadMetaConfig(repoRoot, opts = {}) {
  try {
    const { pure } = await loadDeps(opts);
    const cfgPath = join(repoRoot, '.deploy-tmp', 'whatsapp-config.env');
    if (!existsSync(cfgPath)) return {};
    const cfg = pure.parseConfigEnv(await readFile(cfgPath, 'utf8'));
    return {
      appId: cfg.WHATSAPP_APP_ID || '',
      wabaId: cfg.WHATSAPP_WABA_ID || '',
      phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID || '',
      deploymentPrefix: cfg.WHATSAPP_DEPLOYMENT_PREFIX || '',
    };
  } catch {
    return {};
  }
}

// The post-deploy gate is informational: the values were captured pre-deploy
// (and read back from Secrets Manager), so this step just confirms wiring the
// webhook in Meta. No secret fields.
export function postGate() {
  return {
    kind: 'meta-post',
    title: 'Wire the webhook in Meta',
    help:
      'Now that the webhook endpoint is deployed, the installer points your Meta app at it ' +
      '(callback URL + Verify Token + the messages and calls fields), subscribes your WhatsApp Business ' +
      'Account, and enables the Calling API on the number. Uses the values you already provided - nothing ' +
      'to re-enter.',
    consoleUrls: [],
    fields: [],
    action: 'wire-webhook',
  };
}

// Resolve a Meta console URL by key, using whatever ids we know. Pure-derived
// (no secrets). `which` is 'apps' | 'appDashboard' | 'whatsappApiSetup'.
export async function resolveConsoleUrl(which, { appId, businessId } = {}, opts = {}) {
  const { pure } = await loadDeps(opts);
  const urls = pure.metaConsoleUrls({ appId, businessId });
  return urls[which] || urls.apps || 'https://developers.facebook.com/apps/';
}

// Read one stored secret value from Secrets Manager on explicit operator
// request (the UI "eye" reveal). `which` is 'accessToken' | 'appSecret' |
// 'verifyToken'. Returns '' if unset. The value is only ever returned to the
// loopback caller; it is never logged.
export async function getStoredSecret(repoRoot, which, opts = {}) {
  if (!['accessToken', 'appSecret', 'verifyToken'].includes(which)) return '';
  const { pure, secrets } = await loadDeps(opts);
  const cfg = await loadMetaConfig(repoRoot, opts);
  const prefix = opts.prefix || cfg.deploymentPrefix || DEFAULT_PREFIX;
  const name = pure.secretNamesForPrefix(prefix)[which];
  if (!name) return '';
  const client = secrets.makeClient(opts.region || process.env.AWS_REGION || 'us-east-1');
  return (await secrets.getSecret(client, name)) || '';
}

export function validatePreInput(values, opts = {}) {
  const errors = [];
  const v = values || {};
  if (!/^\d+$/.test(String(v.appId || '').trim())) errors.push('App ID is required and numeric.');
  if (!String(v.appSecret || '').trim()) errors.push('App Secret is required.');
  if (!String(v.accessToken || '').trim()) errors.push('Access Token is required.');
  if (!String(v.wabaId || '').trim() && !String(v.businessId || '').trim()) {
    errors.push('Provide either a WABA ID or a Business ID (to auto-discover the WABA).');
  }
  const prefix = String(v.deploymentPrefix || '').trim() || DEFAULT_PREFIX;
  // Mirror the prefix rule without importing pure synchronously.
  if (!/^[a-z][a-z0-9-]{1,19}$/.test(prefix)) {
    errors.push('Deployment prefix must be 1-20 chars, lowercase, starting with a letter.');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Pre-deploy: validate token, discover ids, populate the three secrets.
// Returns a structured result; never returns or logs secret values.
//   { ok, stage, reason?, needChoice?, config?, verifyTokenGenerated? }
// `needChoice` = { kind:'waba'|'phone', options:[{id,label}] } when discovery
// found multiple candidates and the operator must pick (the UI re-submits with
// the chosen id).
// ---------------------------------------------------------------------------
export async function runPreDeploy(values, opts = {}) {
  const onLog = opts.onLog || (() => {});
  const region = opts.region || process.env.AWS_REGION || 'us-east-1';
  const repoRoot = opts.repoRoot || join(HERE, '..', '..', '..');
  const v = values || {};

  const pre = validatePreInput(v);
  if (!pre.ok) return { ok: false, stage: 'input', reason: pre.errors.join(' ') };

  const { pure, graph, secrets } = await loadDeps(opts);
  const accessToken = String(v.accessToken).trim();
  const appSecret = String(v.appSecret).trim();
  const appId = String(v.appId).trim();
  const prefix = String(v.deploymentPrefix || '').trim() || DEFAULT_PREFIX;

  // 1) Validate the access token.
  onLog('Validating the access token against the Graph API...');
  const me = await graph.getMe(accessToken);
  const verdict = pure.interpretTokenValidation(me.status, me.body);
  if (!verdict.valid) {
    onLog(`Token validation failed (${verdict.reason}).`);
    return { ok: false, stage: 'validate', reason: verdict.reason };
  }
  onLog('Access token is valid.');

  // 2) Resolve the WABA id (given, or auto-discover via the business id).
  let wabaId = String(v.wabaId || '').trim();
  if (!wabaId) {
    const businessId = String(v.businessId || '').trim();
    onLog('Discovering your WhatsApp Business Account...');
    const owned = await graph.getOwnedWabas(accessToken, businessId);
    const wabas = pure.parseWabas(owned.body);
    const pick = pure.selectSingleOrChoose(wabas);
    if (pick.mode === 'auto') {
      wabaId = pick.value.id;
      onLog(`Found one WABA (${pick.value.name || wabaId}).`);
    } else if (pick.mode === 'choose') {
      return {
        ok: false, stage: 'discover-waba',
        needChoice: { kind: 'waba', options: wabas.map((w) => ({ id: w.id, label: w.name || w.id })) },
      };
    } else {
      return { ok: false, stage: 'discover-waba', reason: 'no_waba_found_for_business_id' };
    }
  }

  // 3) Resolve the phone number id (given, or auto-discover under the WABA).
  let phoneNumberId = String(v.phoneNumberId || '').trim();
  if (!phoneNumberId) {
    onLog('Discovering the WhatsApp phone number...');
    const phones = pure.parsePhoneNumbers((await graph.getPhoneNumbers(accessToken, wabaId)).body);
    const pick = pure.selectSingleOrChoose(phones);
    if (pick.mode === 'auto') {
      phoneNumberId = pick.value.id;
      onLog(`Found one phone number (${pick.value.displayPhoneNumber || phoneNumberId}).`);
    } else if (pick.mode === 'choose') {
      return {
        ok: false, stage: 'discover-phone',
        needChoice: {
          kind: 'phone',
          options: phones.map((p) => ({ id: p.id, label: `${p.displayPhoneNumber} ${p.verifiedName}`.trim() })),
        },
      };
    } else {
      return { ok: false, stage: 'discover-phone', reason: 'no_phone_number_found' };
    }
  }

  // 4) Verify Token: use the supplied one, else generate.
  const suppliedVerify = String(v.verifyToken || '').trim();
  const verifyToken = suppliedVerify || pure.generateVerifyToken();
  const verifyTokenGenerated = !suppliedVerify;
  onLog(verifyTokenGenerated ? 'Generated a random Verify Token.' : 'Using the supplied Verify Token.');

  // 5) Populate the three secret containers (must already exist from wa-webhook).
  const names = pure.secretNamesForPrefix(prefix);
  const client = secrets.makeClient(region);
  onLog('Checking the secret containers created by the webhook stack...');
  const exists = await secrets.checkSecretsExist(client, [names.accessToken, names.appSecret, names.verifyToken]);
  if (!exists.ok) {
    onLog(`Secret containers missing: ${exists.missing.join(', ')}. Deploy the webhook layer first.`);
    return { ok: false, stage: 'secrets-missing', reason: exists.missing.join(', ') };
  }
  onLog('Writing the three secret values to AWS Secrets Manager (values are never shown)...');
  await secrets.putSecret(client, names.accessToken, accessToken);
  await secrets.putSecret(client, names.appSecret, appSecret);
  await secrets.putSecret(client, names.verifyToken, verifyToken);
  onLog('Secrets populated.');

  // 6) Persist the NON-SECRET config so post-deploy and "previous parameters"
  //    can reuse it. No secret value is written here.
  try {
    const tmpDir = join(repoRoot, '.deploy-tmp');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'whatsapp-config.env'),
      pure.renderConfigEnv({ prefix, phoneNumberId, wabaId, appId }),
      'utf8',
    );
    onLog('Wrote non-secret config to .deploy-tmp/whatsapp-config.env (gitignored).');
  } catch (err) {
    onLog(`Warning: could not write non-secret config (${err.message}).`);
  }

  return { ok: true, stage: 'done', config: { appId, wabaId, phoneNumberId, prefix }, verifyTokenGenerated };
}

// ---------------------------------------------------------------------------
// Post-deploy: wire the webhook in Meta. Reads the access/verify/app-secret
// from Secrets Manager (populated by pre-deploy) and the webhook URL from
// cdk-outputs. Returns { ok, steps:[{label, ok, detail?}], reason? }.
// ---------------------------------------------------------------------------
export async function runPostDeploy(values, opts = {}) {
  const onLog = opts.onLog || (() => {});
  const region = opts.region || process.env.AWS_REGION || 'us-east-1';
  const repoRoot = opts.repoRoot || join(HERE, '..', '..', '..');
  const v = values || {};

  const { pure, graph, secrets } = await loadDeps(opts);

  // Config: prefer explicit values, else the persisted non-secret config.
  let cfg = {};
  const cfgPath = join(repoRoot, '.deploy-tmp', 'whatsapp-config.env');
  if (existsSync(cfgPath)) {
    try { cfg = pure.parseConfigEnv(await readFile(cfgPath, 'utf8')); } catch { cfg = {}; }
  }
  const prefix = String(v.deploymentPrefix || cfg.WHATSAPP_DEPLOYMENT_PREFIX || DEFAULT_PREFIX).trim();
  const appId = String(v.appId || cfg.WHATSAPP_APP_ID || '').trim();
  const wabaId = String(v.wabaId || cfg.WHATSAPP_WABA_ID || '').trim();
  const phoneNumberId = String(v.phoneNumberId || cfg.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  if (!appId || !wabaId) {
    return { ok: false, reason: 'missing_app_or_waba_id' };
  }

  // Secrets from Secrets Manager (populated by pre-deploy).
  const names = pure.secretNamesForPrefix(prefix);
  const client = secrets.makeClient(region);
  const accessToken = String(v.accessToken || (await secrets.getSecret(client, names.accessToken)) || '');
  const verifyToken = String(v.verifyToken || (await secrets.getSecret(client, names.verifyToken)) || '');
  const appSecret = String(v.appSecret || (await secrets.getSecret(client, names.appSecret)) || '');
  if (!accessToken || !verifyToken || !appSecret) {
    return { ok: false, reason: 'missing_secrets - run pre-deploy first' };
  }

  // Webhook URL from cdk-outputs.
  const outPath = join(repoRoot, 'cdk-outputs', 'wa-webhook.json');
  if (!existsSync(outPath)) return { ok: false, reason: 'webhook_outputs_not_found' };
  let webhookUrl = '';
  try {
    const outputs = JSON.parse(await readFile(outPath, 'utf8'));
    for (const stack of Object.values(outputs || {})) {
      if (stack && typeof stack === 'object' && 'WebhookUrl' in stack) { webhookUrl = stack.WebhookUrl; break; }
    }
  } catch { /* fall through */ }
  if (!webhookUrl) return { ok: false, reason: 'webhook_url_missing_in_outputs' };
  onLog(`Webhook URL: ${webhookUrl}`);

  const steps = [];
  const appToken = pure.appAccessToken(appId, appSecret);

  // App subscription (idempotent). App-level endpoint requires the APP token.
  const existing = await graph.getAppSubscriptions(appToken, appId);
  const desired = { callbackUrl: webhookUrl, fields: WEBHOOK_FIELDS };
  if (pure.isAppSubscriptionConfigured(existing.body, desired)) {
    onLog('App subscription already configured (no-op).');
    steps.push({ label: 'App webhook subscription', ok: true, detail: 'already configured' });
  } else {
    const res = await graph.setAppSubscription(appToken, appId, { callbackUrl: webhookUrl, verifyToken, fields: WEBHOOK_FIELDS });
    const ok = res.status >= 200 && res.status < 300;
    onLog(`Set app webhook subscription: ${ok ? 'ok' : 'FAILED'}.`);
    steps.push({ label: 'App webhook subscription', ok, detail: ok ? '' : graphError(res) });
  }

  // Subscribe the WABA (uses the user/access token).
  const sub = await graph.subscribeWaba(accessToken, wabaId);
  const subOk = sub.status >= 200 && sub.status < 300;
  onLog(`Subscribe WABA to the app: ${subOk ? 'ok' : 'FAILED'}.`);
  steps.push({ label: 'Subscribe WABA', ok: subOk, detail: subOk ? '' : graphError(sub) });

  // Enable inbound Calling on the number (best-effort; may require messaging tier).
  if (phoneNumberId) {
    const calling = await graph.setCallingSettings(accessToken, phoneNumberId, { status: 'ENABLED' });
    const settings = await graph.getPhoneNumberSettings(accessToken, phoneNumberId).catch(() => ({}));
    const status = settings?.body?.calling?.status;
    const callOk = status === 'ENABLED' || (calling.status >= 200 && calling.status < 300);
    onLog(status ? `Calling status on the number: ${status}.` : 'Calling could not be confirmed (may require the messaging tier on a production number).');
    steps.push({ label: 'Enable Calling API', ok: callOk, detail: status ? `status ${status}` : graphError(calling) });
  }

  const allOk = steps.every((s) => s.ok);
  return { ok: allOk, steps };
}

function graphError(res) {
  const err = (res && res.body && res.body.error) || {};
  return `http ${res?.status}${err.code ? ` code ${err.code}` : ''}${err.message ? ` ${err.message}` : ''}`.trim();
}
