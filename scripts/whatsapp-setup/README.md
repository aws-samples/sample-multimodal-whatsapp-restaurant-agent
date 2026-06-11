# WhatsApp setup CLI

Interactive operator tooling that automates the parts of Meta/WhatsApp onboarding
the Graph API allows, so the only manual step left is the one that genuinely
cannot be scripted: creating the Meta Developer App and adding the WhatsApp
product in the console.

This pairs with `scripts/deploy-all.sh` (secret population) and the
`meta-whatsapp-setup-guide.html` walkthrough.

## What it can and cannot do

Cannot be scripted (do these in the console first):

- Create the Meta Developer App + add the WhatsApp product (credential bootstrap
  - no public API creates an app).
- Business verification, App Review, production number registration, and
  display-name review (see the "Going to production" section of the setup guide).

Automated by this CLI:

- Validate your access token against the Graph API.
- Auto-discover the WhatsApp Business Account (WABA) ID and Phone Number ID.
- Generate a secure random Verify Token.
- Populate the three AWS Secrets Manager containers the webhook stack created
  (`<prefix>-wa-access-token`, `<prefix>-wa-app-secret`, `<prefix>-wa-verify-token`).
- Post-deploy: set the webhook callback URL + Verify Token + fields, subscribe
  the WABA, and optionally create a Utility template. Idempotent and re-runnable.

## Usage

```bash
cd scripts/whatsapp-setup
npm install

# 1) After you created the app in the console and deployed the webhook stack:
npm start          # choose "Pre-deploy" - validates, discovers, populates secrets

# 2) After deploy-all.sh has produced cdk-outputs/wa-webhook.json:
npm start          # choose "Post-deploy" - wires the webhook in Meta
```

### Non-interactive / environment-variable mode

Every value can also come from an environment variable, so the CLI can run in
CI or without typing. Set secrets with `export` so they stay out of shell
history (unlike a `--flag` value). Set `WHATSAPP_NONINTERACTIVE=1` to turn a
missing required value into a hard error instead of a prompt.

| Env var | Meaning | Secret? |
|---|---|---|
| `WHATSAPP_FLOW` | `pre` or `post` (which flow to run) | no |
| `WHATSAPP_DEPLOYMENT_PREFIX` | deployment prefix (default `qsr-wa`) | no |
| `WHATSAPP_APP_ID` | Meta App ID | no |
| `WHATSAPP_WABA_ID` | WhatsApp Business Account ID (else auto-discovered) | no |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID (else auto-discovered) | no |
| `WHATSAPP_APP_SECRET` | Meta App Secret | yes -> Secrets Manager |
| `WHATSAPP_ACCESS_TOKEN` | access token (24h or System User) | yes -> Secrets Manager |
| `WHATSAPP_VERIFY_TOKEN` | Verify Token (else generated) | yes -> Secrets Manager |

```bash
# Example: non-interactive pre-deploy. Secrets via export stay out of history.
export WHATSAPP_APP_SECRET=...        # not echoed, not logged
export WHATSAPP_ACCESS_TOKEN=...      # not echoed, not logged
WHATSAPP_FLOW=pre WHATSAPP_NONINTERACTIVE=1 \
  WHATSAPP_APP_ID=XXXXXXXXXXXXXXX \
  npm start
```

Note: real account identifiers (App ID, WABA ID, Phone Number ID) are
account-specific and must never be committed to source - keep them in env vars
or the gitignored `.deploy-tmp/whatsapp-config.env` only.

## Security

- No secret value (access token, App Secret, Verify Token) is ever printed or
  logged. Secrets go to AWS Secrets Manager only; the access token is sent in the
  Authorization header, never a URL.
- Non-secret config (Phone Number ID, WABA ID, App ID) is printed and written to
  `.deploy-tmp/whatsapp-config.env` (gitignored).
- Uses the deployment account/region from your standard AWS credentials
  (`AWS_REGION`, default `us-east-1`).

## Layout

- `whatsapp-setup.mjs` - interactive entry (orchestration only).
- `lib/pure.mjs` - pure, testable logic (no I/O): token verdict, discovery
  parsing, Verify Token generation, idempotent no-op detection, output rendering.
- `lib/graph.mjs` - thin Graph API wrappers over global `fetch`.
- `lib/secrets.mjs` - thin AWS Secrets Manager wrapper.
- `test/` - unit tests (mock the Graph API + Secrets Manager).
