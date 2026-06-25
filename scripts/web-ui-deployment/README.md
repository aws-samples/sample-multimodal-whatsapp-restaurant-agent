# Web UI installer

A local, browser-based installer for the WhatsApp Restaurant AI Host. It runs
on your own machine, visualizes the architecture as it deploys, walks you
through the Meta/WhatsApp onboarding, and seeds demo data - all from one page.

It is **additive**: it does not change how `scripts/deploy-all.sh` behaves
without the flag. Everything new lives in this folder.

## Launch

```bash
./scripts/deploy-all.sh --interactive-web-ui
```

This starts a local server bound to `127.0.0.1` on a random port and opens your
browser at `http://127.0.0.1:<port>/?token=<session>`. If the browser does not
open automatically, copy the printed URL.

### Offline demo (no AWS)

```bash
node scripts/web-ui-deployment/server.mjs --mock
```

Mock mode synthesizes the whole flow - deploy animation, the WhatsApp gates, and
seeding - without touching AWS or Meta. Use it to see how the installer works.

## What it does

1. **Deploy** - runs the same layered deploy as `deploy-all.sh`, one layer at a
   time, lighting up each component in the architecture diagram (the diagram is
   the published `index.html` topology, so the box that pulses is the real
   architecture box). A progress line tracks completed layers.
2. **Connect WhatsApp (Meta)** - after the webhook layer exists, a guided form
   collects your Meta values (App ID, App Secret, Access Token, optional WABA /
   Business / Phone Number IDs, Verify Token). Each field explains what it is and
   where to get it, with buttons that open the right Meta console page. The
   installer validates the token, auto-discovers the WABA and phone number,
   generates a Verify Token if you leave it blank, populates AWS Secrets Manager,
   then wires the webhook + subscribes the WABA + enables Calling.
3. **Seed demo data** - a form collects a customer name, phone (E.164), location,
   and business type (or tick "anonymous demo" for menu + locations only), then
   runs the existing `backend/synthetic-data` generator.

You can also run the WhatsApp step or the seeding step on their own with the
**Configure WhatsApp** and **Seed data** buttons in the header. Two more header
buttons help with onboarding:

- **Verify config** - a read-only doctor check: are the secrets populated, the
  Phone Number ID set, the webhook deployed and subscribed, and does the live
  verify-handshake pass? Each failure shows a remediation hint.
- **System User** (experimental) - mint a non-expiring Meta token from a one-time
  admin authorization and store it as the Access Token. Falls back to manual
  paste if Meta does not permit it.

When you deploy a **subset** of layers (the Options dialog), the installer checks
that your selection includes each layer's required dependencies; if any are
missing it offers to add them (in dependency order) before deploying.

## Re-running an existing deployment

When you relaunch and a deployment is detected, the installer asks what to do:

- **Resume** - finish an interrupted deploy; completed layers are skipped.
- **Re-deploy changes** - keep the infrastructure; re-open the WhatsApp and
  seeding steps so you can rotate secrets or re-seed.
- **Re-deploy with previous parameters** - reuse your saved non-secret
  parameters; you only re-enter secrets and the customer phone.
- **Re-deploy with new brand parameters** - re-seed as a different demo
  restaurant (with a scrub-first option so locations are not duplicated).

To re-apply a single layer (for example after a transient failure), click its
card and choose **Re-apply this layer** - it redeploys just that layer.

## Security

- The server binds loopback only and refuses non-loopback connections.
- The control channel (`/events`, `/command`) requires a per-launch session
  token carried only in the opened URL.
- Secrets you enter (App Secret, Access Token, Verify Token) travel only over the
  loopback channel, are held in memory just long enough to put them into AWS
  Secrets Manager, are cleared from the form after submit, and are never logged,
  echoed, or written to disk by the installer.
- The customer phone number is treated as sensitive: passed only as a process
  argument to the generator, redacted from streamed logs, and never persisted.
- Persisted "previous parameters" contain only non-secret values (deployment
  prefix, business name, company name, location) under the gitignored
  `.deploy-tmp/`.

## How it is built

- Zero runtime dependencies for the deploy/diagram path - Node built-ins only.
  The WhatsApp step lazily reuses `scripts/whatsapp-setup/lib` (and its AWS SDK)
  in-process; nothing is reimplemented.
- The control channel is Server-Sent Events (server -> browser) plus HTTP POST
  (`/command`, browser -> server), so there is no WebSocket dependency.

### Layout

```
server.mjs            local server (loopback, SSE + POST control channel)
layers.json           shared layer manifest (single source of truth)
lib/markers.mjs       deploy progress-marker parser
lib/deploy.mjs        spawns deploy-all.sh per layer
lib/topology-source.mjs  extracts the diagram data from repo-root index.html
lib/meta.mjs          Meta onboarding (drives whatsapp-setup/lib)
lib/synthetic.mjs     synthetic-data seeding (drives populate-data.js)
lib/status.mjs        launch-mode detection + non-secret parameter persistence
public/               the single-page UI (diagram, gates, log)
test/                 unit + drift-guard tests
```

### Tests

```bash
cd scripts/web-ui-deployment && npm test
```
