/**
 * Derive the deterministic WhatsApp customer_id from an E.164 phone number.
 *
 * Mirrors whatsapp-webhook/.../lib/customerId.ts (deriveCustomerId):
 *
 *   customer_id = "wa-" + sha256(e164 || pepper).hexdigest()[:16]   (19 chars)
 *
 * The pepper is read from the same SSM SecureString the webhook worker reads
 * at message/call time: `/${prefix}/customer-id-pepper` (default
 * `/qsr-wa/customer-id-pepper`, created by scripts/deploy-all.sh ensure_pepper).
 *
 * Using the same pepper here guarantees the Customers row this script writes
 * (PK = `CUSTOMER#<customer_id>`) is the row the runtimes read for that phone
 * number, so loyalty lookups and cross-channel memory resolve to the same
 * customer.
 *
 * NOTE on hash equivalence: the worker computes
 * `sha256(Buffer.concat([e164, pepper]))` while this file feeds the two buffers
 * with successive `hash.update()` calls. Both hash the identical byte sequence
 * `e164 || pepper`, so the resulting `wa-` ids match byte-for-byte.
 */
const crypto = require('crypto');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const PEPPER_PARAMETER_NAME_DEFAULT = '/qsr-wa/customer-id-pepper';

/**
 * Read the pepper from SSM SecureString.
 *
 * @param {string} parameterName e.g. `/qsr-wa/customer-id-pepper`.
 * @param {string} region AWS region.
 * @returns {Promise<Buffer>} pepper bytes.
 */
async function loadPepper(parameterName, region = 'us-east-1') {
  const client = new SSMClient({ region });
  const resp = await client.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  const value = resp?.Parameter?.Value ?? '';
  return Buffer.from(value, 'utf-8');
}

/**
 * Compute the customer_id for a given E.164 number using the provided pepper.
 *
 * @param {string} e164 caller phone, must match ^\+[1-9]\d{1,14}$
 * @param {Buffer} pepper bytes read from SSM (empty buffer is accepted
 *   for local dev - matches the worker path when the param is unset).
 * @returns {string} 19-char id like `wa-a1b2c3d4e5f6a7b8`.
 */
function computeCustomerId(e164, pepper) {
  if (typeof e164 !== 'string' || !/^\+[1-9]\d{1,14}$/.test(e164)) {
    throw new Error(`computeCustomerId: invalid E.164 ${JSON.stringify(e164)}`);
  }
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(e164, 'utf-8'));
  hash.update(pepper || Buffer.alloc(0));
  return 'wa-' + hash.digest('hex').slice(0, 16);
}

module.exports = {
  loadPepper,
  computeCustomerId,
  PEPPER_PARAMETER_NAME_DEFAULT,
};
