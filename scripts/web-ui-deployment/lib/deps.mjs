// Shared deploy-dependency resolver for the WhatsApp Restaurant AI Host.
//
// Single source of truth is scripts/web-ui-deployment/layers.json: each layer
// declares `dependsOn` (required upstream layers), `recommends` (optional), and
// its CloudFormation `stack` name. This module is imported by the web installer
// and shelled-out-to by deploy-all.sh (the CLI shim at the bottom), so there is
// exactly one copy of the dependency graph. Pure + dependency-free.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = join(HERE, '..', 'layers.json');

// Load the manifest into a graph: { order: [key...], nodes: { key: {dependsOn, recommends, stack, name} } }.
export function loadGraph(manifestPath = DEFAULT_MANIFEST) {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const layers = Array.isArray(raw) ? raw : raw.layers;
  if (!Array.isArray(layers)) throw new Error('layers.json: expected a "layers" array');
  const order = layers.map((l) => l.key);
  const nodes = {};
  for (const l of layers) {
    nodes[l.key] = {
      name: l.name || l.key,
      stack: l.stack || null,
      dependsOn: Array.isArray(l.dependsOn) ? l.dependsOn.slice() : [],
      recommends: Array.isArray(l.recommends) ? l.recommends.slice() : [],
    };
  }
  return { order, nodes };
}

// Ordered transitive closure of one or more target keys: the targets plus every
// required dependency, returned in manifest (deploy) order, de-duplicated.
export function closure(keys, graph = loadGraph()) {
  const targets = Array.isArray(keys) ? keys : [keys];
  const seen = new Set();
  const visit = (k) => {
    if (seen.has(k)) return;
    const node = graph.nodes[k];
    if (!node) throw new Error(`Unknown layer key: ${k}`);
    seen.add(k);
    for (const d of node.dependsOn) visit(d);
  };
  for (const t of targets) visit(t);
  return graph.order.filter((k) => seen.has(k));
}

// Required dependencies of `selected` that are neither selected nor already
// satisfied. `selected` and `satisfied` are arrays of layer keys.
export function missingDeps(selected, satisfied = [], graph = loadGraph()) {
  const sel = new Set(selected);
  const sat = new Set(satisfied);
  const missing = new Set();
  for (const k of selected) {
    const node = graph.nodes[k];
    if (!node) throw new Error(`Unknown layer key: ${k}`);
    for (const d of node.dependsOn) {
      if (!sel.has(d) && !sat.has(d)) missing.add(d);
    }
  }
  // Return in deploy order for stable, deployable output.
  return graph.order.filter((k) => missing.has(k));
}

// Validate the graph: every referenced key exists, the graph is acyclic, and
// each dependency appears before its dependent in deploy order. Returns an
// array of human-readable problems (empty = valid).
export function validateGraph(graph = loadGraph()) {
  const problems = [];
  const pos = new Map(graph.order.map((k, i) => [k, i]));

  for (const k of graph.order) {
    const node = graph.nodes[k];
    for (const rel of ['dependsOn', 'recommends']) {
      for (const d of node[rel]) {
        if (!pos.has(d)) {
          problems.push(`${k}.${rel} references unknown layer "${d}"`);
          continue;
        }
        if (rel === 'dependsOn' && pos.get(d) >= pos.get(k)) {
          problems.push(`${k} dependsOn "${d}" but "${d}" is not before "${k}" in deploy order`);
        }
      }
    }
  }

  // Cycle detection over required edges (DFS with colors).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(graph.order.map((k) => [k, WHITE]));
  const stack = [];
  const dfs = (k) => {
    color.set(k, GRAY);
    stack.push(k);
    for (const d of (graph.nodes[k] ? graph.nodes[k].dependsOn : [])) {
      if (!graph.nodes[d]) continue; // unknown key already reported
      if (color.get(d) === GRAY) {
        const cycle = stack.slice(stack.indexOf(d)).concat(d).join(' -> ');
        problems.push(`dependency cycle: ${cycle}`);
      } else if (color.get(d) === WHITE) {
        dfs(d);
      }
    }
    stack.pop();
    color.set(k, BLACK);
  };
  for (const k of graph.order) if (color.get(k) === WHITE) dfs(k);

  return [...new Set(problems)];
}

// ---- CLI shim (consumed by deploy-all.sh) --------------------------------
// Usage:
//   node deps.mjs closure <key> [<key>...]   -> newline-separated ordered closure
//   node deps.mjs deps <key>                 -> newline-separated direct required deps
//   node deps.mjs stack <key>                -> the CloudFormation stack name
//   node deps.mjs validate                   -> exit 0 if valid, else 1 + problems on stderr
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const graph = loadGraph();
    if (cmd === 'closure') {
      if (!rest.length) { process.stderr.write('closure: need at least one key\n'); process.exit(2); }
      process.stdout.write(closure(rest, graph).join('\n') + '\n');
    } else if (cmd === 'deps') {
      const node = graph.nodes[rest[0]];
      if (!node) { process.stderr.write(`unknown key: ${rest[0]}\n`); process.exit(2); }
      process.stdout.write(node.dependsOn.join('\n') + (node.dependsOn.length ? '\n' : ''));
    } else if (cmd === 'stack') {
      const node = graph.nodes[rest[0]];
      if (!node) { process.stderr.write(`unknown key: ${rest[0]}\n`); process.exit(2); }
      process.stdout.write((node.stack || '') + '\n');
    } else if (cmd === 'validate') {
      const problems = validateGraph(graph);
      if (problems.length) { process.stderr.write(problems.join('\n') + '\n'); process.exit(1); }
      process.stdout.write('ok\n');
    } else {
      process.stderr.write('usage: deps.mjs closure|deps|stack|validate ...\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`deps.mjs error: ${e.message}\n`);
    process.exit(2);
  }
}
