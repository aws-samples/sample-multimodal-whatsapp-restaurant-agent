# whatsapp-webhook (CDK)

`${prefix}-WebhookStack` - the WhatsApp webhook ingress for the restaurant AI
host. This app provisions the public HTTPS entry point Meta calls, plus the
state it needs.

## What this stack creates (Task 3.1 - core resources)

- A regional REST API on Amazon API Gateway (HTTPS, TLS 1.2+, AWS-managed
  `execute-api` certificate, no custom domain) with `GET` (verification) and
  `POST` (events: messages and calls) on `/webhook`, both wired to the handler
  via a Lambda PROXY integration so the raw request body reaches the Lambda
  verbatim (the HMAC is computed over the exact bytes Meta signed).
- The Webhook Handler Lambda (Python). Task 3.1 ships a minimal placeholder
  handler; the verification, signature, routing, and reply logic land in
  Tasks 4, 5, 6, 8, 9.
- The 24-hour window DynamoDB table keyed by `customerId`, with `lastInboundTs`
  and `ttl` attributes, TTL auto-expiry on `ttl`, and point-in-time recovery.

### Optional resources (off by default)

| Resource | Context flag | Default |
|---|---|---|
| AWS WAF (rate limit + AWS common rule set, associated with the stage) | `enableWaf` | off |
| Call-id mapping table (`metaCallId` -> runtime session id, for the gated voice path) | `enableCallMappingTable` | off |

Enable per deployment, for example: `cdk synth -c enableWaf=true`.

## Wiring (isolated-app pattern)

- INPUT CfnParameters: `DeploymentPrefix`, `AgentCoreGatewayUrl`,
  `PepperParameterName`, `ChatRuntimeArn`, `VoiceNotesRuntimeArn`,
  `CallRuntimeArn`, `SharedMemoryArn`, `AccessTokenSecretName`,
  `AppSecretSecretName`, `VerifyTokenSecretName`. These are threaded by
  `scripts/deploy-all.sh` via `--parameters Stack:Key=value`.
- OUTPUT CfnOutputs (no `exportName`): `WebhookUrl`, `WebhookApiId`,
  `WindowTableName`, `WebhookHandlerName` (and `CallMapTableName` when enabled).

## Secrets

Task 3.1 threads the three secret NAMES as CfnParameters only. Creating the
Secrets Manager containers and granting the Lambda least-privilege read access
scoped to those specific ARNs is Task 3.2. No secret value is ever passed as a
parameter or emitted into the synthesized template.

## Commands

```bash
npm install
npm run synth   # cdk synth
npm test        # jest synth/config guard
```

Deployment is orchestrated by `scripts/deploy-all.sh`; do not `cdk deploy` this
app directly.
