import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syntheticGate, validateSyntheticInput, buildSyntheticArgs, redactPhone,
} from '../lib/synthetic.mjs';

test('syntheticGate exposes anonymous toggle, required fields, and a sensitive phone field', () => {
  const g = syntheticGate();
  assert.equal(g.kind, 'synthetic-data');
  const byName = Object.fromEntries(g.fields.map((f) => [f.name, f]));
  assert.equal(byName.anonymous.type, 'checkbox');
  assert.equal(byName.location.required, true);
  assert.equal(byName.businessName.required, true);
  assert.equal(byName.userPhone.sensitive, true);
  for (const f of g.fields) assert.ok(f.help && f.help.length > 0, `${f.name} needs help`);
});

test('validateSyntheticInput requires location + business always', () => {
  assert.equal(validateSyntheticInput({}).ok, false);
  assert.equal(validateSyntheticInput({ location: 'Dallas, TX' }).ok, false);
});

test('validateSyntheticInput: non-anonymous needs name + valid E.164 phone', () => {
  const base = { location: 'Dallas, TX', businessName: 'burgers' };
  assert.equal(validateSyntheticInput(base).ok, false); // missing name + phone
  assert.equal(validateSyntheticInput({ ...base, userName: 'Jane Doe', userPhone: 'nope' }).ok, false);
  assert.equal(validateSyntheticInput({ ...base, userName: 'Jane Doe', userPhone: '+1 212 555 0100' }).ok, true);
});

test('validateSyntheticInput: anonymous needs neither name nor phone', () => {
  const r = validateSyntheticInput({ location: 'Dallas, TX', businessName: 'burgers', anonymous: true });
  assert.equal(r.ok, true);
});

test('buildSyntheticArgs: full loyalty seed includes name + phone + company', () => {
  const args = buildSyntheticArgs({
    location: 'Dallas, TX', businessName: 'burgers', userName: 'Jane Doe', userPhone: '+1 212 555 0100',
    companyName: 'Example Cafe', deploymentPrefix: 'qsr-wa',
  });
  assert.ok(args.includes('--non-interactive'));
  assert.ok(args.includes('--user-name') && args.includes('Jane Doe'));
  assert.ok(args.includes('--user-phone') && args.includes('+1 212 555 0100'));
  assert.ok(args.includes('--company-name') && args.includes('Example Cafe'));
  assert.ok(args.includes('--location') && args.includes('Dallas, TX'));
});

test('buildSyntheticArgs: anonymous omits user-name and user-phone', () => {
  const args = buildSyntheticArgs({ location: 'Dallas, TX', businessName: 'burgers', anonymous: true, userName: 'X', userPhone: '+1 212 555 0100' });
  assert.ok(!args.includes('--user-name'), 'anonymous must not pass --user-name');
  assert.ok(!args.includes('--user-phone'), 'anonymous must not pass --user-phone');
  assert.ok(!args.includes('+1 212 555 0100'), 'anonymous must not pass the phone value');
  assert.ok(args.includes('--location') && args.includes('--business-name'));
});

test('buildSyntheticArgs: default prefix when omitted', () => {
  const args = buildSyntheticArgs({ location: 'x', businessName: 'y', anonymous: true });
  const i = args.indexOf('--deployment-prefix');
  assert.ok(i >= 0 && args[i + 1] === 'qsr-wa');
});

test('redactPhone removes the phone number from a line', () => {
  const phone = '+1 212 555 0100';
  assert.equal(redactPhone(`seeding for ${phone} now`, phone), 'seeding for [phone redacted] now');
  assert.equal(redactPhone('no phone here', phone), 'no phone here');
  assert.equal(redactPhone('anything', ''), 'anything'); // anonymous: nothing to redact
});
