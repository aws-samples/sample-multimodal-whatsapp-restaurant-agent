// Topology source extractor for the web UI installer.
//
// The architecture diagram lives in the repo-root index.html (the published
// visualizer). Rather than duplicate its node/cluster/edge/icon data into the
// installer (which would drift), we read that file once and materialize the
// four data declarations - NODES, CLUSTERS, EDGES, ICONS - straight from it.
// The installer then renders the SAME diagram, so "the box that is deploying"
// is literally the box from the architecture picture.
//
// These four declarations are plain object/array literals with no DOM access,
// so we can evaluate them in an isolated vm context. We slice each literal out
// with a brace/bracket scanner that respects string and comment boundaries,
// then evaluate it as an expression. A consistency test guards against the
// published file being refactored in a way that breaks extraction.

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Scan from the opening bracket at `start` to its matching close bracket,
// skipping over string literals (', ", `) and // and /* */ comments so that
// brackets appearing inside them are not counted.
function sliceBalanced(src, start, open, close) {
  let depth = 0;
  let str = null;             // active string delimiter, or null
  let line = false;           // inside a // comment
  let block = false;          // inside a /* */ comment
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (line) { if (ch === '\n') line = false; continue; }
    if (block) { if (ch === '*' && next === '/') { block = false; i++; } continue; }
    if (str) {
      if (ch === '\\') { i++; continue; }   // skip escaped char
      if (ch === str) str = null;
      continue;
    }
    if (ch === '/' && next === '/') { line = true; i++; continue; }
    if (ch === '/' && next === '*') { block = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${open}${close} starting at ${start}`);
}

// Pull `const NAME = <literal>` out of the source and return the literal text.
function extractDecl(src, name, open, close) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*`);
  const m = re.exec(src);
  if (!m) throw new Error(`declaration "${name}" not found`);
  const start = src.indexOf(open, m.index + m[0].length);
  if (start === -1) throw new Error(`opening "${open}" for "${name}" not found`);
  return sliceBalanced(src, start, open, close);
}

function evalLiteral(literal) {
  // Wrap in parens so an object literal is parsed as an expression.
  return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
}

/**
 * Extract the diagram data from an index.html visualizer file.
 * @param {string} indexHtmlPath absolute path to index.html
 * @returns {Promise<{nodes:object, clusters:Array, edges:Array, icons:object}>}
 */
export async function extractTopology(indexHtmlPath) {
  const html = await readFile(indexHtmlPath, 'utf8');
  const nodes = evalLiteral(extractDecl(html, 'NODES', '{', '}'));
  const clusters = evalLiteral(extractDecl(html, 'CLUSTERS', '[', ']'));
  const edges = evalLiteral(extractDecl(html, 'EDGES', '[', ']'));
  const icons = evalLiteral(extractDecl(html, 'ICONS', '{', '}'));
  // The vm evaluates in a separate realm, so the objects/arrays it returns
  // carry that realm's prototypes (which breaks strict deep-equality and is
  // surprising to callers). The data is all JSON-safe, so round-trip it to
  // normalize everything into plain local-realm objects - this is also exactly
  // what the server serializes over /topology.json.
  return JSON.parse(JSON.stringify({ nodes, clusters, edges, icons }));
}

export const EMPTY_TOPOLOGY = { nodes: {}, clusters: [], edges: [], icons: {} };
