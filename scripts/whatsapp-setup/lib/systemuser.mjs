// EXPERIMENTAL: Meta System User + long-lived token automation, shared by the
// whatsapp-setup CLI and the web installer. Creates (or reuses) a System User,
// assigns it to the WABA, mints a NON-EXPIRING token scoped to WhatsApp, and
// stores it as the deployment Access Token. Idempotent (reuse by name). NEVER
// returns or logs the token. Degrades to a clear error so the caller can fall
// back to manual token paste.
//
// Graph contract field names flagged as version-sensitive (see graph.mjs):
// create uses `system_user_role`; token-mint uses `business_app` + omits the
// expiry flag. The whole flow is best-effort and validated only against the
// documented contract - it has not been exercised against a live Meta app.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));   // scripts/whatsapp-setup/lib
const DEFAULT_PREFIX = 'qsr-wa';

async function loadDeps(opts = {}) {
  const imp = (n) => import(pathToFileURL(join(HERE, n)).href);
  return {
    pure: opts.pure || (await imp('pure.mjs')),
    graph: opts.graph || (await imp('graph.mjs')),
    secrets: opts.secrets || (await imp('secrets.mjs')),
  };
}

function graphError(res) {
  const err = (res && res.body && res.body.error) || {};
  return `http ${res ? res.status : '?'}${err.code ? ` code ${err.code}` : ''}${err.message ? ` ${err.message}` : ''}`.trim();
}

export async function runSystemUser(values, opts = {}) {
  const onLog = opts.onLog || (() => {});
  const region = opts.region || process.env.AWS_REGION || 'us-east-1';
  const repoRoot = opts.repoRoot || join(HERE, '..', '..', '..');
  const v = values || {};
  const adminToken = String(v.adminToken || '').trim();
  const businessId = String(v.businessId || '').trim();
  const appId = String(v.appId || '').trim();
  const appSecret = String(v.appSecret || '').trim();
  const wabaId = String(v.wabaId || '').trim();
  const name = String(v.systemUserName || '').trim() || 'qsr-wa-system-user';
  const prefix = String(v.deploymentPrefix || '').trim() || DEFAULT_PREFIX;

  if (!adminToken || !businessId || !appId || !appSecret || !wabaId) {
    return { ok: false, reason: 'System User automation needs an admin token, Business ID, App ID, App Secret, and WABA ID. Skip this and paste an Access Token manually instead.' };
  }

  const { pure, graph, secrets } = await loadDeps(opts);
  const permMsg = 'your admin token cannot manage System Users. Use a Business admin token with business_management, or skip and paste an Access Token manually.';

  // 1) Find or create (idempotent by name).
  onLog('Looking for an existing System User...');
  const list = await graph.getSystemUsers(adminToken, businessId);
  if (pure.isPermissionError(list.body)) return { ok: false, reason: permMsg };
  let su = ((list.body && list.body.data) || []).find((u) => u.name === name);
  let created = false;
  if (!su) {
    onLog(`Creating System User "${name}"...`);
    const res = await graph.createSystemUser(adminToken, businessId, name);
    if (!(res.body && res.body.id)) return { ok: false, reason: `could not create the System User (${graphError(res)}). ${permMsg}` };
    su = { id: res.body.id, name };
    created = true;
  } else {
    onLog(`Reusing existing System User "${name}".`);
  }

  // 2) Assign to the WABA (best-effort).
  onLog('Assigning the System User to your WhatsApp Business Account...');
  const asg = await graph.assignSystemUserToWaba(adminToken, wabaId, su.id, ['MANAGE']);
  const asgOk = (asg.status >= 200 && asg.status < 300) || (asg.body && asg.body.success);
  if (!asgOk) onLog('Note: could not confirm the asset assignment (it may already exist, or require setting it in Business Settings).');

  // 3) Mint the long-lived token.
  onLog('Generating a long-lived System User access token...');
  const proof = pure.appSecretProof(adminToken, appSecret);
  const tok = await graph.createSystemUserToken(adminToken, su.id, {
    appId, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], appsecretProof: proof,
  });
  const token = tok.body && tok.body.access_token;
  if (!token) {
    return { ok: false, reason: `could not generate the System User token (${graphError(tok)}). Ensure the app is assigned to the System User in Business Settings, then retry - or paste an Access Token manually.` };
  }

  // 4) Store as the deployment Access Token + App Secret (never logged).
  const names = pure.secretNamesForPrefix(prefix);
  const client = secrets.makeClient(region);
  try {
    await secrets.putSecret(client, names.accessToken, token);
    await secrets.putSecret(client, names.appSecret, appSecret);
  } catch (err) {
    return { ok: false, reason: `minted the token but could not store it (${err.message}). Is the webhook layer deployed (secret containers exist)?` };
  }
  onLog('Stored the long-lived token as the deployment Access Token (value never shown).');

  // Persist non-secret config (preserve an existing phone number id if present).
  try {
    let phoneNumberId = '';
    const cfgPath = join(repoRoot, '.deploy-tmp', 'whatsapp-config.env');
    if (existsSync(cfgPath)) {
      const cfg = pure.parseConfigEnv(await readFile(cfgPath, 'utf8'));
      phoneNumberId = cfg.WHATSAPP_PHONE_NUMBER_ID || '';
    }
    await mkdir(join(repoRoot, '.deploy-tmp'), { recursive: true });
    await writeFile(join(repoRoot, '.deploy-tmp', 'whatsapp-config.env'),
      pure.renderConfigEnv({ prefix, phoneNumberId, wabaId, appId }), 'utf8');
  } catch { /* best-effort */ }

  return { ok: true, systemUserId: su.id, created, tokenStored: true };
}
