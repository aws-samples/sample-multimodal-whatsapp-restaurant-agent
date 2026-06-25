#!/usr/bin/env node
// Thin bootstrap for the Meta/WhatsApp setup CLI.
//
// The real CLI lives in cli.mjs and statically imports heavy dependencies (the
// AWS SDK via lib/secrets.mjs, and @inquirer/prompts). If those packages are
// not installed, that import would fail with a cryptic
// "Cannot find package '@aws-sdk/...'" error. This bootstrap is built-ins-only,
// so it always loads; it ensures the dependencies are installed first, then
// dynamically imports the CLI (whose main() runs on load).
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { ensureDeps } from './lib/ensure-deps.mjs';

ensureDeps(dirname(fileURLToPath(import.meta.url)));
await import('./cli.mjs');
