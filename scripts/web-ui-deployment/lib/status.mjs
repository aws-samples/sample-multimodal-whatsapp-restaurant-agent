// Launch-mode detection + non-secret parameter persistence for the installer.
//
// On launch the server classifies an existing deployment so the UI can offer
// the right action: a fresh install, Resume (finish an interrupted deploy), or
// - when everything is already deployed - one of the re-deployment paths
// (re-deploy changes / re-deploy with previous parameters / re-deploy with new
// brand parameters). See Requirement 15.
//
// Sources of truth (all durable, no new state store):
//   - .deployment-state.json  -> which layers are done (written by deploy-all.sh)
//   - AWS Secrets Manager      -> whether the 3 Meta secrets are populated
//   - .deploy-tmp/installer-params.json -> the persisted NON-SECRET parameter set
//
// SECURITY: the persisted parameter set never contains a secret value or the
// customer phone number (Requirements 8.2, 14.6); saveParams whitelists keys.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const STATE_FILE = '.deployment-state.json';
export const PARAMS_FILE = join('.deploy-tmp', 'installer-params.json');

// Only these non-secret parameters are ever persisted / offered as "previous".
const PERSIST_KEYS = ['deploymentPrefix', 'businessName', 'companyName', 'location'];

export async function readDeploymentState(repoRoot) {
  try {
    return JSON.parse(await readFile(join(repoRoot, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// Map each manifest layer to 'done' | 'pending' from the deploy-state file.
export function layerStates(layers, state) {
  const components = (state && state.components) || {};
  const states = {};
  let done = 0;
  for (const l of layers) {
    const isDone = Boolean(components[l.key] && components[l.key].deployed === true);
    states[l.key] = isDone ? 'done' : 'pending';
    if (isDone) done += 1;
  }
  return { states, done, total: layers.length };
}

export async function loadParams(repoRoot) {
  try {
    const obj = JSON.parse(await readFile(join(repoRoot, PARAMS_FILE), 'utf8'));
    // Defensive: only return whitelisted, non-secret keys.
    const out = {};
    for (const k of PERSIST_KEYS) if (obj[k] != null) out[k] = obj[k];
    return out;
  } catch {
    return {};
  }
}

// Persist ONLY the non-secret parameter subset. Any secret/phone keys passed in
// are dropped here as a safety net (never written to disk).
export async function saveParams(repoRoot, params) {
  const out = {};
  for (const k of PERSIST_KEYS) {
    const v = (params || {})[k];
    if (v != null && String(v).trim() !== '') out[k] = String(v).trim();
  }
  const dir = join(repoRoot, '.deploy-tmp');
  await mkdir(dir, { recursive: true });
  await writeFile(join(repoRoot, PARAMS_FILE), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

// Best-effort check whether the three Meta secrets hold a value (not just that
// the empty containers exist). `secrets` is the whatsapp-setup secrets lib (or a
// fake in tests); when absent the result is null (unknown) and never blocks.
export async function checkSecretsPopulated({ secrets, region = 'us-east-1', prefix = 'qsr-wa', pure }) {
  if (!secrets || !pure) return null;
  try {
    const names = pure.secretNamesForPrefix(prefix);
    const client = secrets.makeClient(region);
    const vals = await Promise.all([
      secrets.getSecret(client, names.accessToken),
      secrets.getSecret(client, names.appSecret),
      secrets.getSecret(client, names.verifyToken),
    ]);
    return vals.every((v) => typeof v === 'string' && v.length > 0);
  } catch {
    return null;
  }
}

/**
 * Detect deployment status and the modes to offer.
 * @returns {Promise<{classification, states, progress, availableModes, params, meta}>}
 *   classification: 'not-started' | 'partial' | 'fully-deployed'
 *   availableModes: subset of ['fresh','resume','changes','previous','rebrand']
 */
export async function detectStatus(opts = {}) {
  const { repoRoot, layers } = opts;
  const state = await readDeploymentState(repoRoot);
  const { states, done, total } = layerStates(layers, state);
  const params = await loadParams(repoRoot);

  let classification;
  if (done === 0) classification = 'not-started';
  else if (done >= total) classification = 'fully-deployed';
  else classification = 'partial';

  // Onboarding signal (best-effort, never blocks classification).
  const secretsPopulated = await checkSecretsPopulated({
    secrets: opts.secrets, pure: opts.pure, region: opts.region,
    prefix: (params.deploymentPrefix || opts.prefix || 'qsr-wa'),
  });

  let availableModes;
  if (classification === 'not-started') availableModes = ['fresh'];
  else if (classification === 'partial') availableModes = ['resume'];
  else availableModes = ['changes', 'previous', 'rebrand'];

  return {
    classification,
    states,
    progress: { done, total },
    availableModes,
    params,
    meta: { secretsPopulated },
  };
}

// Human-readable, one-line description of what each path does (shown in the UI
// so the operator confirms knowing what changes vs is preserved).
export const MODE_DESCRIPTIONS = {
  fresh: 'Deploy everything from scratch.',
  resume: 'Continue the interrupted deploy - already-completed layers are skipped.',
  changes: 'Keep the deployment; re-open the steps you want to change (rotate WhatsApp secrets, re-seed data, or re-apply a layer).',
  previous: 'Re-run using your previously saved parameters; you will only re-enter secrets and the customer phone.',
  rebrand: 'Re-run with a new brand: new business name, location, and customer - the demo data is re-seeded.',
};
