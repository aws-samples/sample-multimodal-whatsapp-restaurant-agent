import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkerLine, classifyLine, MARKER_PREFIX } from '../lib/markers.mjs';

test('parses a well-formed layer start marker', () => {
  const ev = parseMarkerLine('@@WAUI@@ {"type":"layer","key":"wa-gateway","state":"start"}');
  assert.deepEqual(ev, { type: 'layer', key: 'wa-gateway', state: 'start' });
});

test('parses each layer state', () => {
  for (const state of ['start', 'done', 'skipped', 'fail']) {
    const ev = parseMarkerLine(`${MARKER_PREFIX} {"type":"layer","key":"wa-ddb","state":"${state}"}`);
    assert.equal(ev.state, state);
  }
});

test('parses a build marker with a phase', () => {
  const ev = parseMarkerLine('@@WAUI@@ {"type":"build","key":"wa-runtime-chat","phase":"BUILD"}');
  assert.equal(ev.type, 'build');
  assert.equal(ev.phase, 'BUILD');
});

test('finds the marker even with leading log text on the line', () => {
  const ev = parseMarkerLine('15:04:05 some log noise @@WAUI@@ {"type":"layer","key":"wa-memory","state":"done"}');
  assert.deepEqual(ev, { type: 'layer', key: 'wa-memory', state: 'done' });
});

test('a normal log line is not a marker', () => {
  assert.equal(parseMarkerLine('Layer 3: AgentCoreGatewayStack (wa-gateway)'), null);
});

test('malformed JSON after the prefix is tolerated (treated as log, no throw)', () => {
  assert.equal(parseMarkerLine('@@WAUI@@ {not valid json'), null);
  assert.equal(parseMarkerLine('@@WAUI@@ '), null);
});

test('marker missing required fields is rejected', () => {
  assert.equal(parseMarkerLine('@@WAUI@@ {"type":"layer","key":"wa-ddb"}'), null); // no state
  assert.equal(parseMarkerLine('@@WAUI@@ {"type":"layer","state":"start"}'), null); // no key
  assert.equal(parseMarkerLine('@@WAUI@@ {"type":"bogus","key":"x","state":"start"}'), null); // bad type
  assert.equal(parseMarkerLine('@@WAUI@@ {"type":"layer","key":"x","state":"weird"}'), null); // bad state
});

test('non-string input does not throw', () => {
  assert.equal(parseMarkerLine(undefined), null);
  assert.equal(parseMarkerLine(42), null);
});

test('classifyLine returns marker vs log', () => {
  assert.deepEqual(
    classifyLine('@@WAUI@@ {"type":"layer","key":"wa-apigw","state":"start"}'),
    { kind: 'marker', event: { type: 'layer', key: 'wa-apigw', state: 'start' } },
  );
  assert.deepEqual(classifyLine('just a log line'), { kind: 'log', line: 'just a log line' });
});
