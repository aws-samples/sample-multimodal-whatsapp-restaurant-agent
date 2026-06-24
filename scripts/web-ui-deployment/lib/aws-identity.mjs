// AWS credential / identity status for the web UI installer.
//
// Runs `aws sts get-caller-identity` (the same credential chain deploy-all.sh +
// the CDK use) and reports who you are and whether the credentials are still
// valid. The server polls this so an expiry that happens while the installer is
// open is reflected live, and guards mutating actions with it so an expired
// token surfaces clear refresh guidance instead of a confusing mid-run failure.
//
// The account id + ARN are shown only in the operator's local UI at runtime;
// nothing is persisted to tracked source.

import { spawn } from 'node:child_process';

// Derive a friendly principal label from an STS/IAM ARN. Pure + testable.
//   arn:aws:sts::123:assumed-role/Admin/session   -> "role Admin"
//   arn:aws:iam::123:user/jane                     -> "user jane"
//   arn:aws:iam::123:root                          -> "root"
export function parseIdentityArn(arn) {
  const s = String(arn || '');
  let m = s.match(/assumed-role\/([^/]+)/);
  if (m) return `role ${m[1]}`;
  m = s.match(/:user\/(.+)$/);
  if (m) return `user ${m[1]}`;
  if (/:root$/.test(s)) return 'account root';
  return s || 'unknown';
}

// Classify an STS failure. Pure + testable. Returns { expired, missing }.
export function classifyStsError(stderr = '', code = 1) {
  const t = String(stderr);
  const expired = /ExpiredToken|security token included in the request is (expired|invalid)|InvalidClientTokenId|credentials have expired/i.test(t);
  const missing = /Unable to locate credentials|NoCredentialProviders|could not be found|Unable to parse config/i.test(t);
  return { expired, missing };
}

// Shape the get-caller-identity JSON into the status object the UI consumes.
export function shapeIdentity(json) {
  const arn = json.Arn || '';
  return {
    ok: true,
    expired: false,
    account: json.Account || '',
    arn,
    userId: json.UserId || '',
    display: parseIdentityArn(arn),
  };
}

/**
 * Run `aws sts get-caller-identity`. Resolves with a status object; never
 * rejects. { ok, account, arn, userId, display } on success, or
 * { ok:false, expired, missing, reason } on failure.
 */
export function getIdentity({ region, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (region) env.AWS_REGION = region;
    let child;
    try {
      child = spawn('aws', ['sts', 'get-caller-identity', '--output', 'json'], { env });
    } catch (e) {
      resolve({ ok: false, expired: false, missing: false, reason: `could not run aws CLI: ${e.message}` });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, expired: false, missing: true, reason: `aws CLI not found: ${e.message}` });
    });
    child.on('close', (codeNum) => {
      clearTimeout(timer);
      if (codeNum === 0) {
        try { resolve(shapeIdentity(JSON.parse(out))); }
        catch { resolve({ ok: false, expired: false, missing: false, reason: 'could not parse get-caller-identity output' }); }
      } else {
        const { expired, missing } = classifyStsError(err, codeNum);
        const reason = err.trim().split('\n').filter(Boolean).pop() || `aws exited ${codeNum}`;
        resolve({ ok: false, expired, missing, reason });
      }
    });
  });
}
