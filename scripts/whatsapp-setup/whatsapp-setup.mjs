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
} from './lib/pure.mjs';
import * as graph from './lib/graph.mjs';
import { makeClient, checkSecretsExist, putSecret } from './lib/secrets.mjs';

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

  const appId = await valueFrom('WHATSAPP_APP_ID', 'App ID', () =>
    input({
      message: 'App ID (App Dashboard -> Settings -> Basic):',
      validate: (v) => /^\d+$/.test(v.trim()) || 'App ID is numeric',
    }),
  );
  const appSecret = await valueFrom('WHATSAPP_APP_SECRET', 'App Secret', () =>
    password({ message: 'App Secret (Settings -> Basic -> App Secret):', mask: '*' }),
  );
  const token = await valueFrom('WHATSAPP_ACCESS_TOKEN', 'access token', () =>
    password({ message: 'Access token (temporary 24h, or System User token):', mask: '*' }),
  );

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
      message: 'Verify Token (leave blank to generate a secure random one):',
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

  const token = await password({
    message: 'Access token (System User token recommended):',
    mask: '*',
  });
  const appId = await input({
    message: 'App ID:',
    validate: (v) => /^\d+$/.test(v.trim()) || 'App ID is numeric',
  });
  const wabaId = await input({
    message: 'WABA ID:',
    validate: (v) => /^\d+$/.test(v.trim()) || 'WABA ID is numeric',
  });
  const verifyToken = await password({
    message: 'Verify Token (the same value you populated into Secrets Manager):',
    mask: '*',
  });

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
  const existing = await graph.getAppSubscriptions(token, appId);
  const desired = { callbackUrl: webhookUrl, fields: WEBHOOK_FIELDS };
  if (isAppSubscriptionConfigured(existing.body, desired)) {
    log('App subscription already configured with the desired callback URL + fields (no-op).');
  } else {
    const res = await graph.setAppSubscription(token, appId, {
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
  log('Enabling the Calling API on the number is not reliably exposed via the Graph API.');
  log('If the Call channel does not work, enable calling in the console: WhatsApp -> API Setup -> Calling.');

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
  let flow = envOr('WHATSAPP_FLOW'); // "pre" | "post"
  if (!flow) {
    if (NON_INTERACTIVE) {
      throw new Error('WHATSAPP_FLOW (pre|post) is required in non-interactive mode.');
    }
    flow = await select({
      message: 'What do you want to do?',
      choices: [
        { name: 'Pre-deploy: validate + discover + populate secrets', value: 'pre' },
        { name: 'Post-deploy: wire the webhook in Meta (Phase B)', value: 'post' },
      ],
    });
  }
  if (flow === 'pre') await preDeploy();
  else if (flow === 'post') await postDeploy();
  else throw new Error(`Unknown WHATSAPP_FLOW "${flow}" (expected "pre" or "post").`);
}

main().catch((err) => {
  // Print the error message only - never dump request bodies that could carry a
  // token or secret.
  log(`\nError: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
