import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractTopology } from '../lib/topology-source.mjs';

// scripts/web-ui-deployment/test -> scripts/ -> repo root
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(scriptsDir, '..');
const indexHtml = join(repoRoot, 'index.html');
const layersPath = join(scriptsDir, 'web-ui-deployment', 'layers.json');

function manifestLayers() {
  return JSON.parse(readFileSync(layersPath, 'utf8')).layers;
}

test('topology extracts from the published index.html diagram', async () => {
  const t = await extractTopology(indexHtml);
  assert.ok(Object.keys(t.nodes).length > 0, 'NODES should be non-empty');
  assert.ok(t.clusters.length > 0, 'CLUSTERS should be non-empty');
  assert.ok(t.edges.length > 0, 'EDGES should be non-empty');
  assert.ok(Object.keys(t.icons).length > 0, 'ICONS should be non-empty');
});

test('every layers.json node id resolves to a node in the diagram (no drift)', async () => {
  const t = await extractTopology(indexHtml);
  const referenced = manifestLayers().flatMap((l) => l.nodes || []);
  const missing = referenced.filter((id) => !(id in t.nodes));
  assert.deepEqual(missing, [], `layers.json references node ids absent from index.html: ${missing.join(', ')}`);
});

test('every diagram node references an icon that exists', async () => {
  const t = await extractTopology(indexHtml);
  const bad = Object.entries(t.nodes)
    .filter(([, n]) => n.icon && !(n.icon in t.icons))
    .map(([id]) => id);
  assert.deepEqual(bad, [], `nodes reference missing icons: ${bad.join(', ')}`);
});

test('every diagram edge connects nodes that exist', async () => {
  const t = await extractTopology(indexHtml);
  const broken = t.edges
    .filter((e) => !(e.from in t.nodes) || !(e.to in t.nodes))
    .map((e) => e.id || `${e.from}->${e.to}`);
  assert.deepEqual(broken, [], `edges reference unknown nodes: ${broken.join(', ')}`);
});
