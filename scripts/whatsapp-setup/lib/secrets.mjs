// Thin AWS Secrets Manager wrapper for the WhatsApp setup CLI (Task 26).
//
// The webhook stack (Task 3.2) creates three EMPTY secret containers with
// deterministic prefixed names; this module PUTS the operator-provided values
// into those existing containers. It never creates secrets and never logs a
// value (R11.6).
//
// PutSecretValue is idempotent from the operator's view: re-running overwrites
// the value in place (a new version), which is the intended "re-populate when
// the 24h token lapses" behavior.

import {
  SecretsManagerClient,
  PutSecretValueCommand,
  GetSecretValueCommand,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';

export function makeClient(region = 'us-east-1') {
  return new SecretsManagerClient({ region });
}

// Confirm the three secret containers exist (created by the webhook stack)
// before attempting to populate them. Returns { ok, missing: [names] }.
export async function checkSecretsExist(client, names) {
  const missing = [];
  for (const name of names) {
    try {
      await client.send(new DescribeSecretCommand({ SecretId: name }));
    } catch (err) {
      if (err && (err.name === 'ResourceNotFoundException')) {
        missing.push(name);
      } else {
        throw err;
      }
    }
  }
  return { ok: missing.length === 0, missing };
}

// Put a value into an existing secret container. Returns the version id. NEVER
// logs `value`.
export async function putSecret(client, secretId, value) {
  const out = await client.send(
    new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
  );
  return out.VersionId;
}

// Read a secret value from an existing container. Returns the string value, or
// '' when the secret is missing or empty (so the caller can fall back to an env
// var / prompt). NEVER logs the value. Used by the post-deploy flow to pull the
// Verify Token + Access Token that pre-deploy already stored, so the operator
// never has to re-enter them.
export async function getSecret(client, secretId) {
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    return out.SecretString ?? '';
  } catch (err) {
    if (err && err.name === 'ResourceNotFoundException') return '';
    throw err;
  }
}
