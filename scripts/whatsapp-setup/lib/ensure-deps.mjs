// Ensure the whatsapp-setup runtime dependencies are installed BEFORE the CLI's
// heavy modules (the AWS SDK via secrets.mjs, and @inquirer/prompts) are
// imported. Built-ins only, so this module loads even when node_modules is
// absent. Synchronous, so the install completes before the caller dynamically
// imports the real CLI.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const PROBES = ['@aws-sdk/client-secrets-manager', '@inquirer/prompts'];

export function depsInstalled(dir) {
  return PROBES.every((p) => existsSync(join(dir, 'node_modules', ...p.split('/'), 'package.json')));
}

// Ensure deps in `dir` (the whatsapp-setup package root). Installs once if
// missing; on failure prints the exact command and exits non-zero so the
// operator gets actionable guidance instead of a module-resolution stack trace.
export function ensureDeps(dir) {
  if (depsInstalled(dir)) return;
  process.stdout.write('[setup] Installing whatsapp-setup dependencies (one-time, npm install)...\n');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: 'inherit' });
  if (r.error || r.status !== 0 || !depsInstalled(dir)) {
    process.stderr.write('\n[setup] Could not install whatsapp-setup dependencies automatically.\n');
    process.stderr.write('        Run this once, then retry:\n          cd scripts/whatsapp-setup && npm install\n');
    process.exit(1);
  }
  process.stdout.write('[setup] Dependencies installed.\n');
}
