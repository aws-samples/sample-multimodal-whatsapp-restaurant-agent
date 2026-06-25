import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGraph, closure, missingDeps, validateGraph } from '../lib/deps.mjs';

test('the shipped layers.json graph is valid (acyclic, known keys, ordered)', () => {
  const problems = validateGraph(loadGraph());
  assert.deepEqual(problems, [], 'expected no graph problems:\n' + problems.join('\n'));
});

test('every layer declares a CloudFormation stack name', () => {
  const g = loadGraph();
  for (const k of g.order) {
    assert.ok(g.nodes[k].stack, `layer ${k} is missing a "stack" name`);
  }
});

test('closure(wa-webhook) is the ordered required set (no recommends, no network)', () => {
  assert.deepEqual(closure('wa-webhook'), [
    'wa-ddb', 'wa-location', 'wa-lambdas', 'wa-apigw',
    'wa-gateway', 'wa-memory', 'wa-runtime-chat', 'wa-webhook',
  ]);
});

test('closure(wa-runtime-call) includes the VPC (network) it requires', () => {
  assert.deepEqual(closure('wa-runtime-call'), [
    'wa-network', 'wa-ddb', 'wa-location', 'wa-lambdas', 'wa-apigw',
    'wa-gateway', 'wa-memory', 'wa-runtime-call',
  ]);
});

test('closure of a leaf with no deps is just itself', () => {
  assert.deepEqual(closure('wa-ddb'), ['wa-ddb']);
});

test('missingDeps reports unsatisfied required deps in deploy order', () => {
  assert.deepEqual(missingDeps(['wa-webhook'], ['wa-gateway', 'wa-memory']), ['wa-runtime-chat']);
  assert.deepEqual(missingDeps(['wa-webhook'], ['wa-gateway', 'wa-memory', 'wa-runtime-chat']), []);
  // recommends are never reported as missing
  assert.deepEqual(missingDeps(['wa-webhook'], closure('wa-webhook').filter((k) => k !== 'wa-webhook')), []);
});

test('closure throws on an unknown key', () => {
  assert.throws(() => closure('wa-nope'), /Unknown layer key/);
});

test('validateGraph detects a cycle', () => {
  const g = { order: ['a', 'b'], nodes: { a: { dependsOn: ['b'], recommends: [] }, b: { dependsOn: ['a'], recommends: [] } } };
  const problems = validateGraph(g);
  assert.ok(problems.some((p) => /cycle/.test(p)), 'expected a cycle problem');
});

test('validateGraph detects an unknown referenced key', () => {
  const g = { order: ['a'], nodes: { a: { dependsOn: ['ghost'], recommends: [] } } };
  const problems = validateGraph(g);
  assert.ok(problems.some((p) => /unknown layer "ghost"/.test(p)));
});

test('validateGraph detects a dependency that is not before its dependent', () => {
  const g = { order: ['a', 'b'], nodes: { a: { dependsOn: ['b'], recommends: [] }, b: { dependsOn: [], recommends: [] } } };
  const problems = validateGraph(g);
  assert.ok(problems.some((p) => /not before/.test(p)));
});
