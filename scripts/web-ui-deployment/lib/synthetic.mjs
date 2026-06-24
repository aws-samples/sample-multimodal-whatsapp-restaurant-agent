// Synthetic-data seeding adapter for the web UI installer.
//
// Drives the EXISTING generator at backend/synthetic-data/populate-data.js in
// its --non-interactive mode with the values the operator entered in the UI.
// No data generation is reimplemented here.
//
// PII: the customer phone number is passed only as a process argument (consumed
// by the generator's customer-id derivation). It is NEVER streamed to the UI -
// runSynthetic redacts it from every forwarded output line (Requirement 14.6).

import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const DEFAULT_PREFIX = 'qsr-wa';

// The gate the UI renders for seeding. All educational copy lives here. Example
// phone uses a NANP fictional placeholder, never a real number.
export function syntheticGate() {
  return {
    kind: 'synthetic-data',
    title: 'Seed demo data',
    help:
      'Populate the database with a demo restaurant - locations and a menu - plus an optional ' +
      'recognized customer with order history. This reuses backend/synthetic-data and reads the deployed ' +
      'tables, the customer-id pepper, and Amazon Location Service. Without these deployed, seeding cannot run.',
    consoleUrls: [],
    submitLabel: 'Seed data',
    fields: [
      {
        name: 'anonymous', label: 'Anonymous demo (menu + locations only, no customer PII)', type: 'checkbox',
        help: 'Tick to seed only the restaurant and menu. No customer name or phone number is collected or stored.',
      },
      {
        name: 'userName', label: 'Customer display name', type: 'text', required: false,
        help: 'The recognized loyalty customer, e.g. Jane Doe. Leave blank for an anonymous demo.',
      },
      {
        name: 'userPhone', label: 'Customer phone (E.164)', type: 'text', sensitive: true, required: false,
        help:
          'The customer phone in E.164 format, e.g. +1 212 555 0100. Used only to derive the pseudonymous ' +
          'customer id the agents compute at runtime; it is never shown in logs or saved by the installer. ' +
          'Leave blank for an anonymous demo.',
      },
      {
        name: 'location', label: 'Location', type: 'text', required: true,
        help: 'City, ZIP, address, or "lat,lon" to anchor the restaurant search, e.g. Dallas, TX.',
      },
      {
        name: 'businessName', label: 'Business search term', type: 'text', required: true,
        help: 'What kind of restaurant to populate, e.g. burgers, pizza, tacos.',
      },
      {
        name: 'companyName', label: 'Company name (rebrand)', type: 'text', required: false,
        help: 'Optional - rename the found places to your brand, e.g. Example Cafe.',
      },
      {
        name: 'deploymentPrefix', label: 'Deployment prefix', type: 'text', required: false, default: DEFAULT_PREFIX,
        help: 'Must match the deploy (default qsr-wa).',
      },
    ],
  };
}

function isAnonymous(values) {
  const a = (values || {}).anonymous;
  return a === true || a === 'true' || a === 'on';
}

// Validate the form input before spawning. Mirrors the generator's
// non-interactive requirements: location + business-name always; name + phone
// only when not anonymous.
export function validateSyntheticInput(values) {
  const v = values || {};
  const errors = [];
  const anon = isAnonymous(v);
  if (!String(v.location || '').trim()) errors.push('Location is required.');
  if (!String(v.businessName || '').trim()) errors.push('Business search term is required.');
  if (!anon) {
    if (!String(v.userName || '').trim()) errors.push('Customer name is required (or choose the anonymous demo).');
    const phone = String(v.userPhone || '').trim();
    if (!/^\+?[0-9][0-9 ()-]{6,}$/.test(phone)) {
      errors.push('Customer phone must look like E.164, e.g. +1 212 555 0100 (or choose the anonymous demo).');
    }
  }
  const prefix = String(v.deploymentPrefix || '').trim() || DEFAULT_PREFIX;
  if (!/^[a-z][a-z0-9-]{1,19}$/.test(prefix)) {
    errors.push('Deployment prefix must be 1-20 chars, lowercase, starting with a letter.');
  }
  return { ok: errors.length === 0, errors };
}

// Build the populate-data.js argument array. Anonymous omits the customer
// name + phone so no PII is seeded.
export function buildSyntheticArgs(values) {
  const v = values || {};
  const anon = isAnonymous(v);
  const args = ['--non-interactive'];
  args.push('--location', String(v.location || ''));
  args.push('--business-name', String(v.businessName || ''));
  args.push('--deployment-prefix', String(v.deploymentPrefix || '').trim() || DEFAULT_PREFIX);
  if (String(v.companyName || '').trim()) args.push('--company-name', String(v.companyName).trim());
  if (!anon) {
    args.push('--user-name', String(v.userName || ''));
    args.push('--user-phone', String(v.userPhone || ''));
  }
  return args;
}

// Redact the phone number from any output line so it never reaches the UI log.
export function redactPhone(line, phone) {
  const p = String(phone || '').trim();
  return p ? String(line).split(p).join('[phone redacted]') : String(line);
}

// Spawn the generator and stream its output (phone redacted). Resolves with the
// child exit code (0 = success).
export function runSynthetic(values, opts = {}) {
  const { repoRoot, onLog = () => {}, nodeBin = process.execPath } = opts;
  return new Promise((resolve) => {
    const script = join(repoRoot, 'backend', 'synthetic-data', 'populate-data.js');
    const args = [script, ...buildSyntheticArgs(values)];
    const phone = String((values || {}).userPhone || '').trim();
    const child = spawn(nodeBin, args, { cwd: repoRoot, env: { ...process.env } });
    const pump = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line !== '') onLog(redactPhone(line, phone));
      }
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);
    child.on('error', (err) => { onLog(`installer: failed to spawn seeding: ${err.message}`); resolve(1); });
    child.on('close', (code) => resolve(code ?? 0));
  });
}
