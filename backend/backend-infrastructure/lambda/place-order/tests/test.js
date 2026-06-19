// Unit tests for the PlaceOrder Lambda.
//
// Contract (post channel-neutral refactor):
//   - customerId is the ONLY required body field.
//   - locationId is resolved from the cart (authoritative), not the body.
//   - fromPhoneNumber is optional; when non-empty it MUST match E.164.
//     Channel-neutral callers (WhatsApp, web) send no phone and identify by
//     customerId alone.
//
// We use Node's built-in `node:test` runner + `assert`, and inject a hand-rolled
// DynamoDB Document Client stub via `setDocClient()` (exported from the handler
// for this purpose). No external mocking library is required — the handler
// only exercises three methods on the doc client (GetCommand / PutCommand /
// DeleteCommand) and the stub pattern-matches on the constructor name. This
// keeps the Lambda asset dir free of devDependencies.

const test = require('node:test');
const assert = require('node:assert/strict');

// Set env vars before requiring the handler (module-level `process.env` reads).
process.env.CARTS_TABLE_NAME = 'test-Carts';
process.env.ORDERS_TABLE_NAME = 'test-Orders';
process.env.LOCATIONS_TABLE_NAME = 'test-Locations';

const handlerModule = require('..');

// Build a stub doc-client that responds to `GetCommand` / `PutCommand` /
// `DeleteCommand` based on their constructor name. The handler currently
// uses one constructor per op; if any new op is added the test will fail
// loudly (unknown command type).
function makeStubDocClient({ cart, location }) {
  const puts = [];
  const deletes = [];
  const docClient = {
    send: async (cmd) => {
      const ctorName = cmd && cmd.constructor && cmd.constructor.name;
      if (ctorName === 'GetCommand') {
        const table = cmd.input.TableName;
        if (table === process.env.CARTS_TABLE_NAME) return { Item: cart };
        if (table === process.env.LOCATIONS_TABLE_NAME) return { Item: location };
        throw new Error(`unexpected GetCommand on table ${table}`);
      }
      if (ctorName === 'PutCommand') {
        puts.push(cmd.input);
        return {};
      }
      if (ctorName === 'DeleteCommand') {
        deletes.push(cmd.input);
        return {};
      }
      throw new Error(`unexpected command ctor ${ctorName}`);
    },
  };
  return { docClient, puts, deletes };
}

// Cart now carries the authoritative locationId (written by AddToCart).
const happyCart = {
  PK: 'CUSTOMER#cust-abc123',
  locationId: 'loc-1',
  items: [
    { itemId: 'burger', name: 'Burger', price: 7.5, quantity: 2 },
    { itemId: 'fries', name: 'Fries', price: 2.5, quantity: 1 },
  ],
};
const happyLocation = {
  PK: 'LOCATION#loc-1',
  taxRate: 0.1,
  name: 'Downtown',
};

test('identified caller with valid phone — 200 + fields persisted, locationId from cart', async () => {
  const { docClient, puts } = makeStubDocClient({
    cart: { ...happyCart, PK: 'CUSTOMER#pstn-abc123' },
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'pstn-abc123',
      channel: 'telephony',
      anonymousCaller: false,
      fromPhoneNumber: '+14155551234',
    }),
  });

  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.order.channel, 'telephony');
  assert.equal(parsed.order.anonymousCaller, false);
  assert.equal(parsed.order.fromPhoneNumber, '+14155551234');
  assert.equal(parsed.order.customerId, 'pstn-abc123');
  // locationId is resolved from the cart, not the body.
  assert.equal(parsed.order.locationId, 'loc-1');
  // Subtotal 17.5, tax 1.75, total 19.25.
  assert.equal(parsed.order.subtotal, 17.5);
  assert.equal(parsed.order.tax, 1.75);
  assert.equal(parsed.order.total, 19.25);

  assert.equal(puts.length, 1);
  assert.equal(puts[0].TableName, 'test-Orders');
  assert.equal(puts[0].Item.channel, 'telephony');
  assert.equal(puts[0].Item.fromPhoneNumber, '+14155551234');
});

test('channel-neutral caller (WhatsApp/web): no phone, no flag — 200', async () => {
  // This is the bug fix: a caller that sends only customerId (+ cart) must
  // succeed. Previously this returned 400 "Invalid fromPhoneNumber".
  const { docClient, puts, deletes } = makeStubDocClient({
    cart: { ...happyCart, PK: 'CUSTOMER#wa-deadbeef' },
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'wa-deadbeef',
    }),
  });

  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  // No phone supplied -> anonymousCaller defaults true, empty phone, channel 'web'.
  assert.equal(parsed.order.anonymousCaller, true);
  assert.equal(parsed.order.fromPhoneNumber, '');
  assert.equal(parsed.order.channel, 'web');
  assert.equal(parsed.order.locationId, 'loc-1');
  assert.equal(parsed.order.status, 'confirmed');
  // Order persisted and cart cleared.
  assert.equal(puts.length, 1);
  assert.equal(deletes.length, 1);
});

test('explicit channel is passed through to the order row', async () => {
  const { docClient, puts } = makeStubDocClient({
    cart: { ...happyCart, PK: 'CUSTOMER#wa-deadbeef' },
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'wa-deadbeef',
      channel: 'whatsapp',
    }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).order.channel, 'whatsapp');
  assert.equal(puts[0].Item.channel, 'whatsapp');
});

test('locationId is read from the cart, ignoring a body-supplied value', async () => {
  const { docClient } = makeStubDocClient({
    cart: { ...happyCart, PK: 'CUSTOMER#cust-loc', locationId: 'loc-from-cart' },
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'cust-loc',
      locationId: 'loc-from-body-should-be-ignored',
    }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).order.locationId, 'loc-from-cart');
});

test('malformed non-empty fromPhoneNumber -> 400, no writes', async () => {
  const { docClient, puts, deletes } = makeStubDocClient({
    cart: happyCart,
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'pstn-abc123',
      fromPhoneNumber: 'bogus',
    }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(puts.length, 0);
  assert.equal(deletes.length, 0);
  assert.match(JSON.parse(res.body).error, /Invalid fromPhoneNumber/);
});

test('missing customerId -> 400', async () => {
  const { docClient, puts } = makeStubDocClient({
    cart: happyCart,
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({ locationId: 'loc-1' }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(puts.length, 0);
  assert.match(JSON.parse(res.body).error, /customerId/);
});

test('empty cart -> 400', async () => {
  const { docClient, puts } = makeStubDocClient({
    cart: { PK: 'CUSTOMER#cust-empty', locationId: 'loc-1', items: [] },
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({ customerId: 'cust-empty' }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(puts.length, 0);
  assert.match(JSON.parse(res.body).error, /Cart is empty/);
});
