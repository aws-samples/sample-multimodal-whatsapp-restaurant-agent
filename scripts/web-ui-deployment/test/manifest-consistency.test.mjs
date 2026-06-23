import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// scripts/web-ui-deployment/test -> scripts/
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function manifestKeys() {
  const manifest = JSON.parse(readFileSync(join(scriptsDir, 'web-ui-deployment', 'layers.json'), 'utf8'));
  return manifest.layers.map((l) => l.key);
}

// Extract the VALID_COMPONENTS list deploy-all.sh validates against.
function deployScriptKeys() {
  const sh = readFileSync(join(scriptsDir, 'deploy-all.sh'), 'utf8');
  const m = sh.match(/VALID_COMPONENTS="([^"]+)"/);
  assert.ok(m, 'VALID_COMPONENTS not found in deploy-all.sh');
  return m[1].trim().split(/\s+/);
}

test('every deploy-all.sh component key exists in layers.json (no drift)', () => {
  const manifest = new Set(manifestKeys());
  const missing = deployScriptKeys().filter((k) => !manifest.has(k));
  assert.deepEqual(missing, [], `layers.json is missing deploy layer keys: ${missing.join(', ')}`);
});

test('layers.json has no keys unknown to deploy-all.sh', () => {
  const scriptKeys = new Set(deployScriptKeys());
  const extra = manifestKeys().filter((k) => !scriptKeys.has(k));
  assert.deepEqual(extra, [], `layers.json has keys deploy-all.sh does not know: ${extra.join(', ')}`);
});

test('every manifest layer has name, nodes array, and why text', () => {
  const manifest = JSON.parse(readFileSync(join(scriptsDir, 'web-ui-deployment', 'layers.json'), 'utf8'));
  for (const l of manifest.layers) {
    assert.equal(typeof l.key, 'string');
    assert.equal(typeof l.name, 'string');
    assert.ok(Array.isArray(l.nodes), `${l.key}: nodes must be an array`);
    assert.ok(typeof l.why === 'string' && l.why.length > 0, `${l.key}: why must be non-empty`);
  }
});
