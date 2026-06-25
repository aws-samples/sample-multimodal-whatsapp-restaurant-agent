#!/usr/bin/env node
// Interactive Meta/WhatsApp setup CLI (Task 26).
//
// Automates everything the Graph API allows in the Meta/WhatsApp onboarding so
// the only manual step left is the one that genuinely cannot be scripted:
// creating the Meta Developer App + adding the WhatsApp product in the console
// (no public API creates an app - it is a credential bootstrap).
//
// Two flows, selected by the operator:
//   pre-deploy : collect 3 console values, validate the token, auto-discover the
//                WABA + Phone Number IDs, generate a Verify Token, populate the
//                three Secrets Manager containers, and print the deploy-all
//                command + write a non-secret config env file.
//   post-deploy: read the deployed webhook URL, set the app webhook subscription
//                (callback URL + verify token + fields), subscribe the WABA, and
//                optionally create Utility templates. Idempotent + re-runnable.
//
// SECURITY: no secret value (access token, App Secret, Verify Token) is ever
// printed or logged. Secrets go to AWS Secrets Manager only; non-secret config
// goes to stdout / a gitignored env file (R11.6, R1.6).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { input, password, select, confirm } from '@inquirer/prompts';

import {
  DEPLOYMENT_PREFIX_REGEX,
  secretNamesForPrefix,
  generateVerifyToken,
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
} from './lib/pure.mjs';
import * as graph from './lib/graph.mjs';
import { makeClient, checkSecretsExist, putSecret, getSecret } from './lib/secrets.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { runSystemUser } from './lib/systemuser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// repo root is two levels up from scripts/whatsapp-setup/
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WEBHOOK_FIELDS = ['messages', 'calls'];

function log(msg = '') {
  process.stdout.write(`${msg}\n`);
}
function section(title) {
  log(`\n=== ${title} ===`);
}

// Best-effort: open a URL in the operator's default browser. Cross-platform,
// detached, and never throws - if it fails the URL is still printed so the
// operator can click/paste it. Used only in interactive mode when the operator
// opts in.
function openUrl(url) {
  try {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best-effort: the URL is printed regardless */
  }
}

// Print a "where to get this" URL right before the matching prompt and, when the
// operator opted in, open it in the browser. `show` gates it (we skip when the
// value already came from an env var, so there is nothing to go fetch).
function maybeShowUrl(show, openUrls, label, url) {
  if (!show || !url) return;
  log(`\n${label}:\n  ${url}`);
  if (openUrls) openUrl(url);
}

// --- environment-variable fallbacks -----------------------------------------
// The CLI is interactive by default, but every value can also come from an
// environment variable so it can run non-interactively (CI) or avoid the shell
// history. Secrets set via `export FOO=...` do NOT land in command history the
// way a `--flag` value would. Set WHATSAPP_NONINTERACTIVE=1 (or pass
// --non-interactive) to turn a missing required value into a hard error instead
// of a prompt.
const NON_INTERACTIVE =
  process.env.WHATSAPP_NONINTERACTIVE === '1' || process.argv.includes('--non-interactive');

function envOr(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : '';
}

// Return the env var when set (logging only that it was used, never the value),
// otherwise run the interactive prompt - or fail in non-interactive mode.
async function valueFrom(name, label, promptFn) {
  const fromEnv = envOr(name);
  if (fromEnv) {
    log(`Using ${label} from $${name}.`);
    return fromEnv;
  }
  if (NON_INTERACTIVE) {
    throw new Error(`${name} is required in non-interactive mode (${label}).`);
  }
  return promptFn();
}

// Resolve a value with a config-env fallback layer: env var -> the value read
// from .deploy-tmp/whatsapp-config.env -> interactive prompt (or fail in
// non-interactive mode). Used by post-deploy so it never re-asks for values
// pre-deploy already captured. Logs only the SOURCE, never the value.
async function resolveValue(envName, cfgValue, label, promptFn) {
  const fromEnv = envOr(envName);
  if (fromEnv) {
    log(`Using ${label} from $${envName}.`);
    return fromEnv;
  }
  if (cfgValue && String(cfgValue).trim()) {
    log(`Using ${label} from .deploy-tmp/whatsapp-config.env.`);
    return String(cfgValue).trim();
  }
  if (NON_INTERACTIVE) {
    throw new Error(`${envName} is required in non-interactive mode (${label}).`);
  }
  return promptFn();
}

// Load the non-secret config env file pre-deploy writes (App ID / WABA ID /
// prefix / phone number id). Returns {} when it does not exist yet.
async function loadConfigEnv() {
  const p = path.join(REPO_ROOT, '.deploy-tmp', 'whatsapp-config.env');
  if (!existsSync(p)) return {};
  try {
    return parseConfigEnv(await readFile(p, 'utf8'));
  } catch {
    return {};
  }
}

async function promptPrefix() {
  return valueFrom('WHATSAPP_DEPLOYMENT_PREFIX', 'deployment prefix', () =>
    input({
      message: 'Deployment prefix (must match ^[a-z][a-z0-9-]{1,19}$):',
      default: 'qsr-wa',
      validate: (v) =>
        DEPLOYMENT_PREFIX_REGEX.test(v) || 'must be 1-20 chars, lowercase, start with a letter',
    }),
  );
}

// ----- pre-deploy flow ------------------------------------------------------
async function preDeploy() {
  section('Pre-deploy: collect, validate, discover, populate secrets');
  log('Provide values interactively, or set them as env vars (App Secret/token');
  log('via `export` so they stay out of shell history). The app itself must be');
  log('created in the console first - no API can do that.\n');

  // Optional Business (portfolio) ID - not required, but when supplied it makes
  // the Meta console links below land directly on the right business.
  const businessId = envOr('WHATSAPP_BUSINESS_ID');

  // Offer to open the relevant Meta console page in the browser right before
  // each value is needed, so the operator is never hunting the dashboard blind.
  let openUrls = false;
  if (!NON_INTERACTIVE) {
    openUrls = await confirm({
      message: 'Open the relevant Meta dashboard pages in your browser as we go?',
      default: true,
    });
  }

  // Create / find your app (no app id needed yet).
  maybeShowUrl(
    !NON_INTERACTIVE && !envOr('WHATSAPP_APP_ID'),
    openUrls,
    'Create or find your Meta app here',
    metaConsoleUrls({ businessId }).apps,
  );
  const appId = await valueFrom('WHATSAPP_APP_ID', 'App ID', () =>
    input({
      message: 'App ID (Meta App Dashboard -> App Settings -> Basic -> "App ID"):',
      validate: (v) => /^\d+$/.test(v.trim()) || 'App ID is numeric',
    }),
  );

  // Now that the App ID is known, build the app-specific console links.
  const urls = metaConsoleUrls({ appId, businessId });

  maybeShowUrl(
    !NON_INTERACTIVE && !envOr('WHATSAPP_APP_SECRET'),
    openUrls,
    'App Secret is on the App Dashboard (Settings -> Basic -> App Secret -> Show)',
    urls.appDashboard,
  );
  const appSecret = await valueFrom('WHATSAPP_APP_SECRET', 'App Secret', () =>
    password({
      message:
        'App Secret (Meta App Dashboard -> App Settings -> Basic -> "App Secret" -> Show). NOT the access token. Used to verify webhook signatures:',
      mask: '*',
    }),
  );
  const token = await valueFrom('WHATSAPP_ACCESS_TOKEN', 'access token', () => {
    maybeShowUrl(
      !NON_INTERACTIVE,
      openUrls,
      'Access token is under WhatsApp -> API Setup (temporary 24h token, or generate a System User token)',
      urls.whatsappApiSetup,
    );
    return password({
      message:
        'Access token (Meta App Dashboard -> WhatsApp -> API Setup: the temporary 24h token, OR a long-lived System User token). Used to send messages + call the Graph API:',
      mask: '*',
    });
  });

  // Validate the token.
  section('Validating token against the Graph API');
  const me = await graph.getMe(token);
  const verdict = interpretTokenValidation(me.status, me.body);
  if (!verdict.valid) {
    log(`Token validation failed: ${verdict.reason}.`);
    log('Get a fresh token at https://developers.facebook.com/ -> your app -> WhatsApp -> API Setup.');
    process.exitCode = 1;
    return;
  }
  log('Token OK.');

  // Discover or accept the WABA id.
  section('Discovering WhatsApp Business Account (WABA)');
  let wabaId = envOr('WHATSAPP_WABA_ID');
  if (wabaId) {
    log('Using WABA ID from $WHATSAPP_WABA_ID.');
  } else if (!NON_INTERACTIVE) {
    const businessId = await input({
      message: 'Business (portfolio) ID for WABA discovery (leave blank to enter the WABA ID directly):',
      default: '',
    });
    if (businessId.trim()) {
      const owned = await graph.getOwnedWabas(token, businessId.trim());
      const wabas = parseWabas(owned.body);
      const pick = selectSingleOrChoose(wabas);
      if (pick.mode === 'auto') {
        wabaId = pick.value.id;
        log(`Found one WABA: ${wabaId} (${pick.value.name}).`);
      } else if (pick.mode === 'choose') {
        wabaId = await select({
          message: 'Multiple WABAs found - choose one:',
          choices: wabas.map((w) => ({ name: `${w.id} (${w.name})`, value: w.id })),
        });
      } else {
        log('No WABAs discovered for that business id.');
      }
    }
  }
  if (!wabaId) {
    if (NON_INTERACTIVE) {
      throw new Error('WHATSAPP_WABA_ID is required in non-interactive mode.');
    }
    wabaId = await input({
      message: 'WhatsApp Business Account (WABA) ID:',
      validate: (v) => /^\d+$/.test(v.trim()) || 'WABA ID is numeric',
    });
  }

  // Discover or accept the phone number id.
  section('Discovering the phone number');
  let phoneNumberId = envOr('WHATSAPP_PHONE_NUMBER_ID');
  if (phoneNumberId) {
    log('Using Phone Number ID from $WHATSAPP_PHONE_NUMBER_ID.');
  } else {
    const phones = parsePhoneNumbers((await graph.getPhoneNumbers(token, wabaId)).body);
    const phonePick = selectSingleOrChoose(phones);
    if (phonePick.mode === 'auto') {
      phoneNumberId = phonePick.value.id;
      log(`Found one phone number: ${phoneNumberId} (${phonePick.value.displayPhoneNumber}).`);
    } else if (phonePick.mode === 'choose' && !NON_INTERACTIVE) {
      phoneNumberId = await select({
        message: 'Multiple phone numbers found - choose one:',
        choices: phones.map((p) => ({
          name: `${p.id} (${p.displayPhoneNumber} ${p.verifiedName})`,
          value: p.id,
        })),
      });
    } else if (!NON_INTERACTIVE) {
      phoneNumberId = await input({
        message: 'Phone Number ID (none auto-discovered):',
        validate: (v) => /^\d+$/.test(v.trim()) || 'Phone Number ID is numeric',
      });
    } else {
      throw new Error('WHATSAPP_PHONE_NUMBER_ID is required in non-interactive mode (none auto-discovered).');
    }
  }

  // Verify token: env, then prompt (blank -> generate).
  let verifyToken = envOr('WHATSAPP_VERIFY_TOKEN');
  if (verifyToken) {
    log('Using Verify Token from $WHATSAPP_VERIFY_TOKEN.');
  } else if (NON_INTERACTIVE) {
    verifyToken = generateVerifyToken();
    log('Generated a random Verify Token (48 hex).');
  } else {
    const supplied = await input({
      message:
        'Verify Token - you INVENT this; it is only a shared secret for the webhook handshake (Meta echoes it back, our Lambda checks it matches). Leave BLANK to auto-generate (recommended):',
      default: '',
    });
    verifyToken = supplied.trim() || generateVerifyToken();
    log(supplied.trim() ? 'Using supplied Verify Token.' : 'Generated a random Verify Token (48 hex).');
  }

  // Populate the three Secrets Manager containers.
  section('Populating AWS Secrets Manager');
  const prefix = await promptPrefix();
  const names = secretNamesForPrefix(prefix);
  const region = process.env.AWS_REGION || 'us-east-1';
  const client = makeClient(region);

  const exists = await checkSecretsExist(client, [
    names.accessToken,
    names.appSecret,
    names.verifyToken,
  ]);
  if (!exists.ok) {
    log(`These secret containers do not exist yet: ${exists.missing.join(', ')}.`);
    log('Deploy the webhook stack first (it creates the empty containers), then re-run pre-deploy.');
    process.exitCode = 1;
    return;
  }

  await putSecret(client, names.accessToken, token);
  await putSecret(client, names.appSecret, appSecret);
  await putSecret(client, names.verifyToken, verifyToken);
  log('Wrote 3 secret values (access token, App Secret, Verify Token). Values are not printed.');

  // Emit non-secret config (no secrets here).
  section('Next: deploy with the non-secret config');
  const cmd = renderDeployCommand({ prefix, phoneNumberId, wabaId, appId });
  log(cmd);

  const tmpDir = path.join(REPO_ROOT, '.deploy-tmp');
  await mkdir(tmpDir, { recursive: true });
  const envPath = path.join(tmpDir, 'whatsapp-config.env');
  await writeFile(envPath, renderConfigEnv({ prefix, phoneNumberId, wabaId, appId }), 'utf8');
  log(`\nNon-secret config also written to ${path.relative(REPO_ROOT, envPath)} (gitignored).`);
  log('NOTE: the --phone-number-id/--waba-id/--app-id deploy-all flags are the intended');
  log('contract; wire them into deploy-all.sh (or source the env file) when deploying.');
}

// ----- post-deploy flow -----------------------------------------------------
async function postDeploy() {
  section('Post-deploy: wire the webhook in Meta (Phase B)');
  log('Pulling config from .deploy-tmp/whatsapp-config.env and the Access/Verify');
  log('tokens from AWS Secrets Manager (populated by pre-deploy), so you should');
  log('not need to re-enter anything.\n');

  const cfg = await loadConfigEnv();
  const prefix =
    envOr('WHATSAPP_DEPLOYMENT_PREFIX') || cfg.WHATSAPP_DEPLOYMENT_PREFIX || (await promptPrefix());
  const region = process.env.AWS_REGION || 'us-east-1';
  const client = makeClient(region);
  const names = secretNamesForPrefix(prefix);

  // App ID + WABA ID: env -> config env -> prompt.
  const appId = await resolveValue('WHATSAPP_APP_ID', cfg.WHATSAPP_APP_ID, 'App ID', () =>
    input({ message: 'App ID:', validate: (v) => /^\d+$/.test(v.trim()) || 'App ID is numeric' }),
  );
  const wabaId = await resolveValue('WHATSAPP_WABA_ID', cfg.WHATSAPP_WABA_ID, 'WABA ID', () =>
    input({ message: 'WABA ID:', validate: (v) => /^\d+$/.test(v.trim()) || 'WABA ID is numeric' }),
  );

  // Access token + Verify Token: env -> Secrets Manager -> prompt (interactive).
  // The whole point of this flow is that pre-deploy already stored both, so the
  // operator never has to know or re-type the Verify Token.
  let token = envOr('WHATSAPP_ACCESS_TOKEN');
  if (token) {
    log('Using access token from $WHATSAPP_ACCESS_TOKEN.');
  } else {
    token = await getSecret(client, names.accessToken);
    if (token) log(`Read access token from Secrets Manager (${names.accessToken}).`);
  }
  let verifyToken = envOr('WHATSAPP_VERIFY_TOKEN');
  if (verifyToken) {
    log('Using Verify Token from $WHATSAPP_VERIFY_TOKEN.');
  } else {
    verifyToken = await getSecret(client, names.verifyToken);
    if (verifyToken) log(`Read Verify Token from Secrets Manager (${names.verifyToken}).`);
  }
  if (!token && !NON_INTERACTIVE) {
    token = await password({ message: 'Access token (System User token recommended):', mask: '*' });
  }
  if (!verifyToken && !NON_INTERACTIVE) {
    verifyToken = await password({
      message: 'Verify Token (the value populated into Secrets Manager):',
      mask: '*',
    });
  }
  if (!token || !verifyToken) {
    log(
      'Missing access token and/or Verify Token. Run the pre-deploy flow first ' +
        'to populate the secrets, or set $WHATSAPP_ACCESS_TOKEN / $WHATSAPP_VERIFY_TOKEN.',
    );
    process.exitCode = 1;
    return;
  }

  // The app-level POST /{app-id}/subscriptions endpoint requires an APP access
  // token (app_id|app_secret), NOT the user / System User token (which returns
  // error code 15 there). Read the App Secret (env -> Secrets Manager -> prompt)
  // and build the app token for that one call. The WABA /subscribed_apps call
  // below still uses the user/system token.
  let appSecret = envOr('WHATSAPP_APP_SECRET');
  if (appSecret) {
    log('Using App Secret from $WHATSAPP_APP_SECRET.');
  } else {
    appSecret = await getSecret(client, names.appSecret);
    if (appSecret) log(`Read App Secret from Secrets Manager (${names.appSecret}).`);
  }
  if (!appSecret && !NON_INTERACTIVE) {
    appSecret = await password({ message: 'App Secret (to build the app access token):', mask: '*' });
  }
  if (!appSecret) {
    log(
      'Missing App Secret - cannot build the app access token required by ' +
        '/subscriptions. Run pre-deploy first or set $WHATSAPP_APP_SECRET.',
    );
    process.exitCode = 1;
    return;
  }
  const appToken = appAccessToken(appId, appSecret);

  // Read the deployed webhook URL.
  const outPath = path.join(REPO_ROOT, 'cdk-outputs', 'wa-webhook.json');
  if (!existsSync(outPath)) {
    log(`Webhook outputs not found at ${path.relative(REPO_ROOT, outPath)}.`);
    log('Deploy the webhook stack first, then re-run post-deploy.');
    process.exitCode = 1;
    return;
  }
  const outputs = JSON.parse(await readFile(outPath, 'utf8'));
  // cdk --outputs-file writes { "<StackName>": { "WebhookUrl": "..." } }
  const webhookUrl = findOutput(outputs, 'WebhookUrl');
  if (!webhookUrl) {
    log('Could not find WebhookUrl in cdk-outputs/wa-webhook.json.');
    process.exitCode = 1;
    return;
  }
  log(`Webhook URL: ${webhookUrl}`);

  // Idempotency: is the app subscription already configured?
  section('Setting the app webhook subscription');
  const existing = await graph.getAppSubscriptions(appToken, appId);
  const desired = { callbackUrl: webhookUrl, fields: WEBHOOK_FIELDS };
  if (isAppSubscriptionConfigured(existing.body, desired)) {
    log('App subscription already configured with the desired callback URL + fields (no-op).');
  } else {
    const res = await graph.setAppSubscription(appToken, appId, {
      callbackUrl: webhookUrl,
      verifyToken,
      fields: WEBHOOK_FIELDS,
    });
    reportGraph('set app subscription', res);
  }

  section('Subscribing the WABA to the app');
  const sub = await graph.subscribeWaba(token, wabaId);
  reportGraph('subscribe WABA', sub);

  section('Calling API');
  // Enable INBOUND (user-initiated) voice calls on the number so customers can
  // tap "Call" in the chat. Calling is OFF by default on every WhatsApp number;
  // a single POST to the number's settings turns it on - no console step. (The
  // 2,000/day messaging-tier prerequisite is waived for test numbers; for a
  // production number it must be met first or this call returns an error.)
  const phoneNumberId = await resolveValue(
    'WHATSAPP_PHONE_NUMBER_ID',
    cfg.WHATSAPP_PHONE_NUMBER_ID,
    'Phone Number ID',
    () =>
      input({
        message: 'Phone Number ID (to enable calling):',
        validate: (v) => /^\d+$/.test(v.trim()) || 'Phone Number ID is numeric',
      }),
  );
  const calling = await graph.setCallingSettings(token, phoneNumberId, { status: 'ENABLED' });
  reportGraph('enable Calling API', calling);
  // Read the settings back so the operator sees the live status (and so a silent
  // partial failure surfaces). Best-effort: a read failure does not fail setup.
  const settings = await graph.getPhoneNumberSettings(token, phoneNumberId);
  const callStatus = settings?.body?.calling?.status;
  if (callStatus) {
    log(`Calling status on the number is now: ${callStatus}.`);
  } else if (calling.status < 200 || calling.status >= 300) {
    log('Calling could not be enabled via the API. The usual cause is the number');
    log('not yet meeting the messaging tier (>=2,000/day) required for calling on a');
    log('production number; test numbers are exempt. The inbound call channel will');
    log('not work until calling shows ENABLED here.');
  }

  const wantTemplate = await confirm({
    message: 'Create a sample Utility order-confirmation template now?',
    default: false,
  });
  if (wantTemplate) {
    const res = await graph.createMessageTemplate(token, wabaId, {
      name: 'order_confirmation',
      language: 'en_US',
      components: [
        {
          type: 'BODY',
          text: 'Your order {{1}} is confirmed. Status: {{2}}.',
          example: { body_text: [['A1B2C3', 'preparing']] },
        },
      ],
    });
    reportGraph('create Utility template', res);
  }

  section('Done');
  log('The Graph API cannot do these - finish them in the console when you go to production:');
  log('  - create the app, business verification, App Review, production number + display name.');
  log('  See the "Going to production" section of meta-whatsapp-setup-guide.html (#production).');
}

// Find an output value by key across the cdk --outputs-file shape
// { "<StackName>": { "<Key>": "<value>" } }.
function findOutput(outputs, key) {
  for (const stack of Object.values(outputs || {})) {
    if (stack && typeof stack === 'object' && key in stack) return stack[key];
  }
  return undefined;
}

// Report a Graph API result without leaking anything sensitive.
function reportGraph(label, res) {
  if (res.status >= 200 && res.status < 300 && (res.body.success === true || res.body.id || Object.keys(res.body).length === 0)) {
    log(`${label}: ok.`);
    return;
  }
  const err = (res.body && res.body.error) || {};
  log(`${label}: FAILED (http ${res.status}) ${err.code ? `code ${err.code}` : ''} ${err.message || ''}`.trim());
}

async function main() {
  log('WhatsApp Restaurant AI Host - Meta/WhatsApp setup CLI');
  log('Reminder: create the Meta app + add the WhatsApp product in the console first.\n');
  let flow = envOr('WHATSAPP_FLOW'); // "pre" | "post" | "doctor" | "systemuser"
  if (!flow && process.argv.includes('--doctor')) flow = 'doctor';
  if (!flow && process.argv.includes('--system-user')) flow = 'systemuser';
  if (!flow) {
    if (NON_INTERACTIVE) {
      throw new Error('WHATSAPP_FLOW (pre|post|doctor|systemuser) is required in non-interactive mode.');
    }
    flow = await select({
      message: 'What do you want to do?',
      choices: [
        { name: 'Pre-deploy: validate + discover + populate secrets', value: 'pre' },
        { name: 'Post-deploy: wire the webhook in Meta (Phase B)', value: 'post' },
        { name: 'Doctor: check end-to-end readiness (read-only)', value: 'doctor' },
        { name: 'System User: mint a long-lived token (experimental)', value: 'systemuser' },
      ],
    });
  }
  if (flow === 'pre') await preDeploy();
  else if (flow === 'post') await postDeploy();
  else if (flow === 'doctor') await doctorFlow();
  else if (flow === 'systemuser') await systemUserFlow();
  else throw new Error(`Unknown WHATSAPP_FLOW "${flow}" (expected "pre", "post", "doctor", or "systemuser").`);
}

// EXPERIMENTAL: create a Meta System User + mint a non-expiring token, stored as
// the deployment Access Token. One-time admin authorization; degrades to manual
// paste (the pre-deploy flow) on any permission/contract problem.
async function systemUserFlow() {
  section('System User automation (EXPERIMENTAL)');
  log('Creates a Meta System User and mints a non-expiring token, then stores it as the deployment Access Token.');
  log('Needs a one-time admin authorization. If anything is not permitted, paste an Access Token via the pre-deploy flow instead.\n');
  const ask = async (envName, prompter) => envOr(envName) || (NON_INTERACTIVE ? '' : await prompter());
  const adminToken = await ask('WHATSAPP_ADMIN_TOKEN', () => password({ message: 'Admin access token (business_management):' }));
  const businessId = await ask('WHATSAPP_BUSINESS_ID', () => input({ message: 'Business (portfolio) ID:' }));
  const appId = await ask('WHATSAPP_APP_ID', () => input({ message: 'App ID:' }));
  const appSecret = await ask('WHATSAPP_APP_SECRET', () => password({ message: 'App Secret:' }));
  const wabaId = await ask('WHATSAPP_WABA_ID', () => input({ message: 'WABA ID:' }));
  const systemUserName = await ask('WHATSAPP_SYSTEM_USER_NAME', () => input({ message: 'System User name:', default: 'qsr-wa-system-user' }));
  const deploymentPrefix = envOr('WHATSAPP_DEPLOYMENT_PREFIX') || 'qsr-wa';
  const res = await runSystemUser(
    { adminToken, businessId, appId, appSecret, wabaId, systemUserName, deploymentPrefix },
    { region: process.env.AWS_REGION, repoRoot: REPO_ROOT, onLog: log },
  );
  if (res.ok) log(`\nDone. System User ${res.created ? 'created' : 'reused'}; long-lived token stored (value never shown).`);
  else { log(`\nCould not complete: ${res.reason}`); process.exitCode = 1; }
}

// Doctor: read-only end-to-end readiness check. Prints per-check pass/fail with
// a remediation hint for each failure. Exit code 1 when anything fails.
async function doctorFlow() {
  section('Doctor: end-to-end WhatsApp readiness (read-only)');
  const report = await runDoctor({ region: process.env.AWS_REGION, repoRoot: REPO_ROOT });
  for (const c of report.checks) {
    log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.label}${c.detail ? ' - ' + c.detail : ''}`);
    if (!c.ok && c.remediation) log(`       -> ${c.remediation}`);
  }
  log(report.ok
    ? '\nAll checks passed. The WhatsApp agent should verify its webhook and reply.'
    : '\nSome checks failed. Fix the items marked -> above, then re-run with --doctor.');
  if (!report.ok) process.exitCode = 1;
}

main().catch((err) => {
  // Print the error message only - never dump request bodies that could carry a
  // token or secret.
  log(`\nError: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
