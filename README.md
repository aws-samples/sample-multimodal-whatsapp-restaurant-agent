# Guidance for WhatsApp Ordering on AWS

## Table of Contents

1. [Overview](#overview)
    - [User request flow](#user-request-flow)
    - [Cost](#cost)
    - [Sample Cost Table](#sample-cost-table)
2. [Prerequisites](#prerequisites)
    - [Operating System](#operating-system)
    - [Third-party tools](#third-party-tools)
    - [AWS account requirements](#aws-account-requirements)
    - [Meta WhatsApp requirements](#meta-whatsapp-requirements)
    - [AWS CDK bootstrap](#aws-cdk-bootstrap)
    - [Supported Regions](#supported-regions)
3. [Automated Deployment](#automated-deployment)
4. [Manual Deployment](#manual-deployment)
5. [Deployment Validation](#deployment-validation)
6. [Running the Guidance](#running-the-guidance)
7. [Next Steps](#next-steps)
8. [Cleanup](#cleanup)
9. [Notices](#notices)
10. [FAQ, Known Issues, Additional Considerations, and Limitations](#faq-known-issues-additional-considerations-and-limitations)
11. [Revisions](#revisions)
12. [Authors](#authors)

## Overview

This Guidance demonstrates how to build a multimodal ordering assistant for quick-service restaurants (QSR) on **WhatsApp**. Over a single WhatsApp Business number, a customer can **text** (including photos and documents), send a **voice note**, or place a **voice call**, and converse with an AI agent that takes the order end-to-end. The three channels share one backend and one cross-channel memory, so a customer who texts today and calls tomorrow is recognized as the same person.

The Guidance uses the **Meta WhatsApp Business Platform** (Cloud API webhook, Messages API, Media API, and Calling API) as the customer front door, **Amazon Bedrock AgentCore Runtime** for agent hosting with microVM session isolation, **Amazon Nova 2 Lite** for multimodal text conversations through the **Amazon Bedrock Converse API**, **Amazon Nova 2 Sonic** for bidirectional speech-to-speech on voice notes and voice calls, the **Strands Agents** framework for the text and voice-call conversational logic (the voice-note runtime drives the raw Amazon Nova 2 Sonic bidirectional protocol directly), **Amazon Bedrock AgentCore Memory** for shared cross-channel recall, **Amazon Bedrock AgentCore Gateway** with the **Model Context Protocol (MCP)** to expose backend tools, **Amazon Location Service** for geocoding and nearest-location lookups, and a decoupled **Amazon API Gateway** plus **AWS Lambda** plus **Amazon DynamoDB** ordering backend. Inbound traffic is acknowledged fast and processed asynchronously through **Amazon Simple Queue Service (Amazon SQS)**. Voice calls answer **WebRTC** with `aiortc` and relay media through the **Amazon Kinesis Video Streams (Amazon KVS)** managed TURN relay. All infrastructure is deployed using the **AWS Cloud Development Kit (AWS CDK)**.

An interactive, step-by-step walkthrough of the full architecture and each channel's flow is included as `flow-visualizer.html` (open it in a browser; use the tabs to isolate Chat, Voice note, or Voice call). The Meta-side onboarding is documented in `meta-whatsapp-setup-guide.html`.

![WhatsApp Ordering on AWS — architecture diagram](assets/architecture.png)

The architecture implements a decoupled, channel-fan-out pattern:

**Section A — Backend infrastructure (reused, channel-neutral).** AWS CDK stacks deploy the restaurant backend: **Amazon DynamoDB** tables for customer profiles, orders, menu items, carts, and locations; **Amazon Location Service** for geocoding and nearest-location search; **AWS Lambda** functions for business logic; and an **Amazon API Gateway** REST API with **AWS Identity and Access Management (IAM)** authorization. The same backend serves all three channels.

**Section B — AgentCore Gateway.** One AWS CDK stack creates the **Amazon Bedrock AgentCore Gateway** with the MCP protocol, exposing the backend REST endpoints as discoverable, well-described MCP tools (`GetMenu`, `AddToCart`, `GetCart`, `UpdateCart`, `PlaceOrder`, `GetPreviousOrders`, `GetNearestLocations`, `GeocodeAddress`) that every runtime invokes by name.

**Section C — Shared AgentCore Memory.** One AWS CDK stack provisions a single **Amazon Bedrock AgentCore Memory** resource keyed by a pseudonymous `customer_id`. All three runtimes read long-term consolidated insights at session start and write raw events at session end, which is what gives the assistant cross-channel continuity over one WhatsApp number.

**Section D — Agent runtimes (three modalities).** Three AWS CDK stacks provision the agents on **Amazon Bedrock AgentCore Runtime**, each built as an ARM64 container through **AWS CodeBuild** and stored in **Amazon Elastic Container Registry (Amazon ECR)**:
- **Chat runtime** — **Amazon Nova 2 Lite** through the Bedrock **Converse API**, multimodal (text + image + document), streaming each assistant message. Runs in AgentCore-managed (`PUBLIC`) networking.
- **Voice note runtime** — a bounded **Amazon Nova 2 Sonic** speech-to-speech session (OGG Opus in, OGG Opus out). Runs in AgentCore-managed (`PUBLIC`) networking.
- **Voice call runtime** — an `aiortc` WebRTC answerer driving **Amazon Nova 2 Sonic**, with media relayed through the Amazon KVS managed TURN relay. Runs in `VPC` networking (the only runtime that needs a customer VPC, for outbound UDP to the TURN relay).

**Section E — WhatsApp ingress and delivery.** AWS CDK stacks provision the front door and the reply path: an **Amazon API Gateway** HTTPS webhook (the only public endpoint, with an AWS-managed certificate); a **Webhook Ingest** AWS Lambda that verifies the Meta signature, enqueues to **Amazon SQS**, and returns `200` within Meta's window; a **Webhook Worker** AWS Lambda that consumes the queue and does the slow work (derive `customer_id`, fetch media, invoke the right runtime, relay voice-call signaling); a **Sender Lambda** that the chat runtime invokes to deliver each message (resolving the recipient from a "last inbound" DynamoDB window table so the runtime holds no token and no phone number); **AWS Secrets Manager** for the Meta Access Token, App Secret, and Verify Token; and **AWS Systems Manager Parameter Store** for the customer-id pepper. A separate **order-notifier** stack sends proactive order-status updates (with an optional demo kitchen simulator).

### User request flow

**Text (multimodal).**

1. Meta delivers an inbound message webhook (text, and optionally an image or document) over HTTPS to the **Amazon API Gateway** webhook and into the **Webhook Ingest** Lambda.
2. The ingest verifies the Meta signature with the App Secret, enqueues the event to **Amazon SQS**, and returns `200` immediately — the slow work happens off the request path.
3. The **Webhook Worker** consumes the message, derives `customer_id = "wa-" + sha256(E164 || Pepper)[:16]` using the shared **AWS Systems Manager** pepper, downloads any image or document bytes from the Meta **Media API**, and invokes the **Chat runtime** with `session_id = customer_id`.
4. The Chat runtime reads the customer's long-term insights from **Amazon Bedrock AgentCore Memory**, then streams **Amazon Nova 2 Lite** through the **Converse API**. Menu, cart, order, and location needs go through **Amazon Bedrock AgentCore Gateway** (MCP) to the backend REST API, **AWS Lambda**, **Amazon DynamoDB**, and **Amazon Location Service**.
5. The runtime delivers each assistant message by invoking the **Sender Lambda**, which resolves the recipient from the window table and sends through the Meta **Messages API**. At session end the runtime writes events back to shared memory.

**Voice note (speech-to-speech).**

1. A voice note arrives on the webhook (`type: audio`); the ingest verifies, enqueues, and returns `200`.
2. The worker downloads the OGG Opus bytes from the Media API and invokes the **Voice note runtime** with `session_id = customer_id`.
3. The runtime reads shared memory, decodes OGG Opus to 16 kHz PCM, runs a bounded **Amazon Nova 2 Sonic** speech-to-speech session (tools through the same MCP gateway), encodes the spoken reply back to OGG Opus, writes events to memory, and returns the audio to the worker, which sends it as a WhatsApp voice message. There is **no transcription service** in the path — it is true voice-in / voice-out.

**Voice call (WebRTC).**

1. The customer taps Call; Meta's **Calling API** delivers a `connect` webhook carrying the WebRTC SDP offer. The ingest verifies and enqueues it.
2. The worker relays the offer to the **Voice call runtime** over the AgentCore invoke API (`turnOnly`, since the runtime has no public IP). The runtime reads shared memory and fetches TURN credentials from Amazon KVS (`GetIceServerConfig`).
3. Because Meta provides no trickle-ICE path, the `aiortc` answerer waits for ICE gathering to complete and returns a single-shot SDP answer with relay candidates embedded; the worker delivers it to Meta via `pre_accept` then `accept`.
4. Media flows DTLS/SRTP through the **Amazon KVS managed TURN relay** between Meta and the runtime; **Amazon Nova 2 Sonic** drives the conversation, with tool calls through the MCP gateway. On terminate, the runtime writes events to memory and tears down the session.

**Shared across channels.** Whichever channel a customer uses, the same `customer_id` resolves to the same **Amazon Bedrock AgentCore Memory**, giving the restaurant one continuous relationship over one WhatsApp number. **Amazon CloudWatch** ingests structured logs from every component, and data at rest is encrypted with **AWS Key Management Service (AWS KMS)**.

### Cost

You are responsible for the cost of the AWS services used while running this Guidance, **and** for the Meta WhatsApp Business Platform messaging fees, which Meta bills separately. The figures below are planning estimates for the US East (N. Virginia) Region; validate against the [AWS Pricing Calculator](https://calculator.aws/) and current Meta pricing before relying on them.

The dominant AWS cost drivers are the always-on **NAT gateway** that gives the voice-call runtime VPC its outbound path, **Amazon Bedrock** token usage (Amazon Nova 2 Sonic output speech tokens for voice notes and calls), and **Amazon Bedrock AgentCore Runtime** session time. **Meta charges for WhatsApp messaging separately**, by conversation/template category and destination country — user-initiated service conversations within the 24-hour window are generally free, while business-initiated utility templates (for example, proactive order-status updates) are charged per message.

Create a [Budget](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html) through [AWS Cost Explorer](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/) to manage costs. Prices are subject to change.

### Sample Cost Table

The following table is an illustrative AWS-side breakdown for one month, assuming roughly 1,000 orders split across the three channels (about 600 text, 250 voice note, 150 voice call). **Estimates only**; they exclude Meta messaging fees and AWS Free Tier benefits.

| AWS service | Dimensions | Cost [USD] |
| ----------- | ---------- | ---------- |
| [Amazon VPC NAT gateway](https://aws.amazon.com/vpc/pricing/) | 1 gateway, 730 hours, modest data processing (voice-call runtime egress) | ~$38.00 |
| [Amazon Bedrock (Nova 2 Sonic)](https://aws.amazon.com/bedrock/pricing/) | ~400 voice-note + voice-call speech-to-speech sessions, input + output speech tokens | ~$28.00 |
| [Amazon Bedrock AgentCore Runtime](https://aws.amazon.com/bedrock/agentcore/pricing/) | ~1,000 sessions across three runtimes, short durations | ~$8.00 |
| [Amazon Bedrock (Nova 2 Lite)](https://aws.amazon.com/bedrock/pricing/) | ~600 multimodal text sessions, input + output text tokens | ~$6.00 |
| [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) | log ingestion + metrics across components | ~$4.00 |
| [Amazon KVS (managed TURN)](https://aws.amazon.com/kinesis/video-streams/pricing/) | TURN relay for ~150 voice calls | ~$3.00 |
| [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/) | 3 secrets (Access Token, App Secret, Verify Token) | ~$1.20 |
| [AWS Lambda](https://aws.amazon.com/lambda/pricing/) | webhook ingest/worker/sender + ordering functions | ~$1.00 |
| [Amazon Location Service](https://aws.amazon.com/location/pricing/) | geocoding + nearest-location calls | ~$0.50 |
| [Amazon API Gateway](https://aws.amazon.com/api-gateway/pricing/) | webhook + backend REST calls | ~$0.30 |
| [Amazon Bedrock AgentCore Gateway](https://aws.amazon.com/bedrock/agentcore/pricing/) | tool invocations across channels | ~$0.20 |
| [Amazon SQS](https://aws.amazon.com/sqs/pricing/) | inbound queue requests | ~$0.10 |
| [Amazon DynamoDB](https://aws.amazon.com/dynamodb/pricing/) | on-demand reads/writes across tables | ~$0.10 |
| [Amazon ECR + Amazon S3](https://aws.amazon.com/ecr/pricing/) | container image + CodeBuild source storage | ~$0.30 |
| | **Estimated AWS total** | **~$90 / month** |
| | **Meta WhatsApp messaging** | **billed separately by Meta** |

**Notes:**

- The NAT gateway is an always-on charge that exists only for the voice-call runtime's VPC. If you do not need voice calls, omitting that runtime removes the largest fixed AWS cost. **Amazon VPC interface endpoints** (PrivateLink) for the AWS services the call runtime uses are a valid way to reduce NAT data-processing cost; the TURN media path still requires NAT egress.
- Amazon Nova 2 Sonic output speech tokens drive the Bedrock cost; voice notes and calls are far more expensive per session than text.
- Costs scale roughly linearly with order volume above the fixed NAT-gateway baseline.

## Prerequisites

### Operating System

These deployment instructions are tested on **macOS** and mainstream Linux distributions. Deployment on Windows is not tested; use Windows Subsystem for Linux 2 (WSL2) if needed.

### Third-party tools

Install the following before deployment:

- [Node.js](https://nodejs.org/) version 24.x or later (required for AWS CDK, the Lambda bundlers, and the WhatsApp setup CLI).
- [AWS Command Line Interface (AWS CLI)](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) version 2.x configured with credentials.
- [git](https://git-scm.com/) for cloning the repository.

The agent containers are Python 3.13, but a developer with only the three tools above can deploy the full stack. There is no need to install `python`, `pip`, `uv`, `ffmpeg`, `libopus`, `libsrtp`, or related toolchains on your workstation — all Python package resolution and container assembly runs inside **AWS CodeBuild** on ARM64 at deploy time. Docker is **not** required to deploy.

### AWS account requirements

- AWS Identity and Access Management permissions to deploy AWS CDK stacks and AWS CloudFormation templates, and to create resources in: Amazon Bedrock AgentCore Runtime, Gateway, and Memory; Amazon Bedrock (Nova 2 Lite and Nova 2 Sonic); AWS Lambda; Amazon DynamoDB; Amazon Location Service; Amazon API Gateway; Amazon SQS; Amazon ECR; AWS CodeBuild; Amazon S3; Amazon CloudWatch Logs and Metrics; AWS Secrets Manager; AWS Systems Manager Parameter Store; Amazon Kinesis Video Streams; Amazon VPC; and AWS Identity and Access Management.
- Amazon Bedrock model access for **Amazon Nova 2 Lite** (`amazon.nova-2-lite-v1:0`) and **Amazon Nova 2 Sonic** (`amazon.nova-2-sonic-v1:0`). Request access through the [Amazon Bedrock console](https://console.aws.amazon.com/bedrock/) model access page.

### Meta WhatsApp requirements

The Meta side of onboarding is a manual prerequisite — only the parts the Graph API allows are scripted (see `scripts/whatsapp-setup/` and `meta-whatsapp-setup-guide.html`). Before live testing you need:

- A **Meta Developer App** with the **WhatsApp** product added (this is the one step no API can create for you).
- A **WhatsApp Business Account (WABA)** and a **phone number** registered to it.
- An **Access Token** (a 24-hour token for testing, or a System User token for longer-lived use) and the app's **App Secret** (used to verify inbound webhook signatures).
- A **Verify Token** — a value *you invent*; Meta echoes it back during the one-time webhook handshake so your endpoint can confirm the subscription. The setup CLI can generate one for you.
- For voice calls, **Calling API** access enabled on the number.

Real account identifiers (App ID, WABA ID, Phone Number ID) and all secrets are account-specific and must never be committed to source — keep them in environment variables or the gitignored `.deploy-tmp/whatsapp-config.env` only.

### AWS CDK bootstrap

If you are using AWS CDK for the first time in this account or Region, bootstrap the environment:

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

Replace `<ACCOUNT_ID>` with your AWS account ID and `<REGION>` with your target Region (for example, `us-east-1`).

### Supported Regions

Deploy in a Region where all of the following are available:

- Amazon Bedrock model access for Amazon Nova 2 Lite and Amazon Nova 2 Sonic.
- Amazon Bedrock AgentCore Runtime, Gateway, and Memory.

`us-east-1` (US East, N. Virginia) is the recommended starting Region. Amazon Bedrock AgentCore Runtime supports a subset of Availability Zones per Region; the deploy script `scripts/deploy-all.sh` resolves the supported Availability Zone letters at deploy time and passes them to the network stack as AWS CDK context — no manual Availability Zone selection is required.

## Automated Deployment

The script `scripts/deploy-all.sh` provisions every AWS CDK stack in dependency order, threads cross-stack identifiers via `cdk-outputs/*.json` files and `--parameters Stack:Key=Value` flags, and waits for AWS CodeBuild to finish building each agent container image.

**Usage:**

```bash
git clone https://github.com/aws-samples/sample-restaurant-whatsapp-ai-host-using-amazon-bedrock-agentcore-nova-sonic.git
cd sample-restaurant-whatsapp-ai-host-using-amazon-bedrock-agentcore-nova-sonic

# 1. Preflight - verifies Node.js, npm, AWS CLI, git, AWS CDK bootstrap, and Amazon Bedrock model access.
./scripts/preflight-check.sh

# 2. Deploy with the default deployment prefix (qsr-wa).
./scripts/deploy-all.sh --deploymentPrefix qsr-wa
```

### Guided web installer (optional)

Prefer a visual, guided experience? Launch the local browser-based installer instead of the plain terminal run:

```bash
./scripts/deploy-all.sh --interactive-web-ui
```

It opens a loopback page that animates the architecture as each layer deploys, walks you through the Meta/WhatsApp onboarding with inline guidance, seeds the demo data, shows your AWS credential status, and lets you resume or re-deploy an existing install. See [`scripts/web-ui-deployment/README.md`](scripts/web-ui-deployment/README.md) for details (including an offline `--mock` demo).

**Optional parameters:**

- `--deploymentPrefix <name>` — Prefix applied to every physical resource name. Must match `^[a-z][a-z0-9-]{1,19}$` (1-20 lowercase characters, starting with a letter). Default: `qsr-wa`.
- `--mode update|fresh` — `update` (default) is an idempotent redeploy; `fresh` runs `cleanup-all.sh --force` before deploying.
- `--force-deploy` — Redeploy every layer even if `.deployment-state.json` marks it as already done.
- `--skip-preflight` — Skip the preflight check.
- `--only <component>` — Deploy only the named layer and skip the rest (still reads upstream `cdk-outputs/*.json`). Valid keys: `wa-network`, `wa-ddb`, `wa-location`, `wa-lambdas`, `wa-apigw`, `wa-gateway`, `wa-memory`, `wa-runtime-call`, `wa-runtime-voicenotes`, `wa-runtime-chat`, `wa-webhook`, `wa-order-notifier`.
- `--skip-kitchen-simulator` — Deploy the real, stream-driven order-status notifier but omit the optional **demo** kitchen simulator (a scheduled Lambda that fake-advances order status so you can see the proactive "being prepared" / "ready" WhatsApp messages without a real kitchen/POS). The simulator is deployed by default for easy validation.
- `--low-storage-mode` — Wipe sibling `node_modules/` before each `npm install` to keep disk usage down on constrained environments (for example, AWS CloudShell).
- `--no-rollback` — Pass `--no-rollback` to every `cdk deploy` so a failed layer is left in place for debugging instead of auto-rolling back.
- `--yes` / `--non-interactive` — Never block on a prompt (for CI or piped runs).

**What the script does:**

- Verifies prerequisites (Node.js, npm, AWS CLI, git, AWS CDK bootstrap, Amazon Bedrock model access).
- Deploys the shared **Amazon VPC** (the voice-call runtime needs it).
- Deploys the backend (Amazon DynamoDB tables, Amazon Location Service, ordering AWS Lambda functions, Amazon API Gateway REST API).
- Deploys **Amazon Bedrock AgentCore Gateway** (MCP tools fronting the backend).
- Deploys the shared **Amazon Bedrock AgentCore Memory** resource and threads its ARN into the runtimes and webhook.
- Builds each ARM64 agent container in AWS CodeBuild, pushes to Amazon ECR, and deploys the three **Amazon Bedrock AgentCore Runtime** stacks (voice call, voice note, chat).
- Deploys the WhatsApp webhook (Amazon API Gateway + ingest Lambda + Amazon SQS + worker + Sender Lambda + AWS Secrets Manager containers + window table) and the order-notifier.

### Connect the WhatsApp number (Meta side)

> **New to Meta's console?** Open `meta-setup-guide.html` (in the repo root) for a
> step-by-step guide to collecting each value (App ID, App Secret, Access Token,
> Business ID, and the operator-invented Verify Token) and wiring the webhook.

The AWS deploy provisions the webhook URL and creates the empty AWS Secrets Manager containers; the `scripts/whatsapp-setup/` CLI then automates the Meta wiring the Graph API allows. After creating your Meta app in the console:

```bash
cd scripts/whatsapp-setup
# Dependencies auto-install on first run (or run `npm install`).

# Pre-deploy: validate your access token, auto-discover the WABA + Phone Number ID,
# generate a Verify Token, and populate the three Secrets Manager containers.
npm start          # choose "Pre-deploy"

# Post-deploy (after cdk-outputs/wa-webhook.json exists): set the webhook callback
# URL + Verify Token + subscribed fields, and subscribe the WABA. Idempotent.
npm start          # choose "Post-deploy"

# Verify the agent will actually reply (read-only end-to-end check):
node whatsapp-setup.mjs --doctor
```

Secrets are written only to AWS Secrets Manager (never printed or logged); non-secret identifiers are written to the gitignored `.deploy-tmp/whatsapp-config.env`. See `scripts/whatsapp-setup/README.md` for the non-interactive / environment-variable mode, the `--doctor` health check, and the experimental `--system-user` long-lived-token automation.

**Deploy reliability:** layer dependencies are declared in `scripts/web-ui-deployment/layers.json`. A `deploy-all.sh --only <layer>` run checks that layer's prerequisites and offers to add missing ones (or pass `--with-deps` to include them non-interactively). If a re-run finds a layer marked deployed but its `cdk-outputs/*.json` is missing, it re-hydrates the outputs from the live stack instead of aborting. After the webhook layer, the deploy warns if any Meta secret is still empty (the agent cannot reply until they are set).

**Note:** For a detailed understanding of each deployment step, see the [Manual Deployment](#manual-deployment) section, and open `flow-visualizer.html` for an interactive architecture walkthrough.

## Manual Deployment

Each module is an independent AWS CDK app. Deploy in the order below; later modules consume outputs from earlier ones.

| # | Module | AWS CDK directory | Stack | deploy-all.sh key |
|---|---|---|---|---|
| 1 | Shared Amazon VPC | `backend/network/` | `NetworkStack` | `wa-network` |
| 2 | Amazon DynamoDB tables | `backend/backend-infrastructure/` | `DynamoDBStack` | `wa-ddb` |
| 3 | Amazon Location Service | `backend/backend-infrastructure/` | `LocationStack` | `wa-location` |
| 4 | Ordering AWS Lambda functions | `backend/backend-infrastructure/` | `LambdaStack` | `wa-lambdas` |
| 5 | Backend Amazon API Gateway (REST) | `backend/backend-infrastructure/` | `ApiGatewayStack` | `wa-apigw` |
| 6 | Amazon Bedrock AgentCore Gateway | `backend/agentcore-gateway/cdk/` | `AgentCoreGatewayStack` | `wa-gateway` |
| 7 | Shared Amazon Bedrock AgentCore Memory | `backend/agentcore-memory/` | `MemoryStack` | `wa-memory` |
| 8 | Voice-call runtime (WebRTC) | `backend/agentcore-runtime-voice-webrtc/cdk/` | `VoiceWebrtcStack` | `wa-runtime-call` |
| 9 | Voice-note runtime (speech-to-speech) | `backend/agentcore-runtime-voicenotes/cdk/` | `VoiceNotesStack` | `wa-runtime-voicenotes` |
| 10 | Chat runtime (multimodal text) | `whatsapp-interface/whatsapp-chat-agent/cdk/` | `ChatAgentStack` | `wa-runtime-chat` |
| 11 | WhatsApp webhook (API GW + ingest + SQS + worker + sender + secrets) | `whatsapp-interface/whatsapp-webhook/cdk/` | `WebhookStack` | `wa-webhook` |
| 12 | Order-status notifier (+ optional demo kitchen simulator) | `backend/order-notifier/` | `OrderNotifierStack` | `wa-order-notifier` |

Each AWS CDK invocation threads `--parameters <StackId>:DeploymentPrefix=<prefix>` plus any upstream identifiers from `cdk-outputs/*.json` (the shared AgentCore Memory ARN, the gateway URL, the pepper parameter, the three runtime ARNs, and the secret names). The `json_val` helper in `scripts/deploy-all.sh` documents the exact parameter names per layer; reading the script is the most direct way to derive a manual single-layer recipe. You can also redeploy any single layer with `./scripts/deploy-all.sh --only <key>`.

## Deployment Validation

After `scripts/deploy-all.sh` completes, verify the CloudFormation stacks are live:

```bash
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?StackName=='NetworkStack' \
    || StackName=='DynamoDBStack' || StackName=='LocationStack' \
    || StackName=='LambdaStack' || StackName=='ApiGatewayStack' \
    || StackName=='AgentCoreGatewayStack' || StackName=='MemoryStack' \
    || StackName=='VoiceWebrtcStack' || StackName=='VoiceNotesStack' \
    || StackName=='ChatAgentStack' || StackName=='WebhookStack' \
    || StackName=='OrderNotifierStack'].StackName"
```

Confirm the three AgentCore runtimes are `READY`:

```bash
aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?starts_with(agentRuntimeName,'whatsapp_')].[agentRuntimeName,status]" \
  --output table
```

After sending a test message and placing a sample order, confirm order provenance in the `<prefix>-Orders` Amazon DynamoDB table (orders are written with `channel = "whatsapp"`):

```bash
aws dynamodb scan --table-name <prefix>-Orders \
  --filter-expression "#c = :ch" \
  --expression-attribute-names '{"#c":"channel"}' \
  --expression-attribute-values '{":ch":{"S":"whatsapp"}}' \
  --max-items 5
```

## Running the Guidance

There is no web user interface and no test client. Message or call the WhatsApp Business number from a phone with WhatsApp installed.

### Inputs

- A phone with WhatsApp that has messaged the business number at least once (so it is within the 24-hour service window for free-form replies).
- (Optional) A customer seeded in Amazon DynamoDB so the agent recognizes a returning customer and recalls preferences.

### Example conversation (text)

```
Customer: What's on the menu near 75201?

Agent:    [tools: GeocodeAddress, GetNearestLocations, GetMenu]
          Here's what's available at Amazing Burgers - Dallas:
          - Burger Combo ($8.99)
          - Chicken Tenders ($6.49)
          ...

Customer: A burger combo and a milkshake, please.

Agent:    [tools: AddToCart, GetCart]
          Added to your cart:
          - 1x Burger Combo - $8.99
          - 1x Milkshake - $3.49
          Total: $12.48. Want me to place the order?

Customer: Yes.

Agent:    [tools: PlaceOrder]
          Your order is placed and is being prepared for pickup at
          Amazing Burgers - Dallas. I'll let you know when it's ready.
```

Voice notes and voice calls run the same ordering flow through Amazon Nova 2 Sonic — speak your order and the agent replies with voice.

### Expected output

- **Tool invocations** through Amazon Bedrock AgentCore Gateway (`GetMenu`, `AddToCart`, `GetCart`, `PlaceOrder`, and others) — the cart and order tools own all pricing and totals; the agent never computes them itself.
- **Order confirmation** only after `PlaceOrder` returns; the order is persisted in Amazon DynamoDB with `channel = "whatsapp"`.
- **Proactive status updates** delivered to WhatsApp as the order advances (driven by the order-notifier, or by the demo kitchen simulator when enabled).

### Debugging and logging

- **Runtime logs.** Amazon CloudWatch Logs at `/aws/bedrock-agentcore/runtimes/<runtime-name>-DEFAULT` show model turn-taking and per-tool `[mcp]` traces for each of the three runtimes (Strands Agents events for the chat and voice-call runtimes; raw Nova Sonic session logs for the voice-note runtime).
- **Webhook logs.** Amazon CloudWatch Logs for the ingest and worker Lambdas (`/aws/lambda/<prefix>-wa-webhook-ingest`, `/aws/lambda/<prefix>-wa-webhook-worker`) and the Sender Lambda (`/aws/lambda/<prefix>-wa-sender`).
- **Backend logs.** Amazon CloudWatch Logs for each ordering Lambda and the backend REST API.
- **Gateway logs.** Amazon CloudWatch Logs for the AgentCore Gateway handler show tool import and synchronization.

## Next Steps

Consider the following enhancements after deploying this Guidance:

- **Verified customer identification.** Layer one-time-password verification on top of the pseudonymous phone-hash.
- **Reduce or remove NAT cost.** Add Amazon VPC interface endpoints (PrivateLink) for the AWS services the voice-call runtime calls; if voice calls are not needed, omit that runtime to drop the always-on NAT gateway.
- **Multi-language support.** Amazon Nova 2 Lite and Nova 2 Sonic support additional languages; extend the system prompts and menu data.
- **Richer media replies.** Use WhatsApp interactive messages (list/reply buttons) for menu browsing and cart confirmation.
- **Point-of-sale integration.** Replace the demo kitchen simulator with a real POS event source that advances order status.
- **Cross-region failover.** Deploy a second Region for geographic redundancy.

## Cleanup

Remove all deployed resources to stop incurring charges. The cleanup script destroys stacks in reverse deployment order so consumer stacks are removed before the producers they depend on.

> **Warning:** Cleanup is destructive. Order history in Amazon DynamoDB, the customer-id pepper in AWS Systems Manager Parameter Store, the AWS Secrets Manager secrets, and the agent container images in Amazon ECR are deleted along with the stacks. Back up anything you want to keep first. Cleanup does not delete anything on the Meta side — unsubscribe the webhook and revoke tokens in the Meta console separately.

```bash
# Preview deletions - no resources are removed.
./scripts/cleanup-all.sh --dry-run

# Delete every stack provisioned by deploy-all.sh.
./scripts/cleanup-all.sh
```

Confirm in the [AWS CloudFormation console](https://console.aws.amazon.com/cloudformation/) that all twelve stacks have been deleted.

## Notices

*Customers are responsible for making their own independent assessment of the information in this Guidance. This Guidance: (a) is for informational purposes only, (b) represents AWS current product offerings and practices, which are subject to change without notice, and (c) does not create any commitments or assurances from AWS and its affiliates, suppliers or licensors. AWS products or services are provided "as is" without warranties, representations, or conditions of any kind, whether express or implied. AWS responsibilities and liabilities to its customers are controlled by AWS agreements, and this Guidance is not part of, nor does it modify, any agreement between AWS and its customers.*

WhatsApp is a product of Meta Platforms, Inc. Use of the WhatsApp Business Platform is governed by Meta's terms and policies. This Guidance is not affiliated with or endorsed by Meta.

## FAQ, Known Issues, Additional Considerations, and Limitations

### Known issues

- **AWS CodeBuild cold start.** The first deploy of each runtime assembles an ARM64 image from scratch (Python package resolution plus Docker layers); allow roughly 8 to 12 minutes per container for the build waiter.
- **Meta webhook handshake.** If the webhook subscription fails to verify, the Verify Token in AWS Secrets Manager does not match the value entered in the Meta console. Re-run the setup CLI "Post-deploy" flow. The Verify Token is a value you invent — it is not issued by Meta.
- **App-level vs user tokens.** Some Graph API endpoints (for example, subscribing the WABA) require an App Access Token (`app_id|app_secret`), while message sending uses a user or System User token. The setup CLI handles this distinction.
- **AWS Lambda runtime warnings.** During `cdk synth`/`cdk deploy`, `aws-cdk-lib` emits advisory warnings about deprecated framework-internal custom-resource runtimes. Deployments succeed; every Lambda owned by this Guidance pins a current runtime explicitly.

### Additional considerations

- **Network egress and NAT.** Only the voice-call runtime runs in a VPC (for outbound UDP to the Amazon KVS managed TURN relay). It reaches Amazon Bedrock, the AgentCore Gateway, and other AWS services over IPv4 through a NAT gateway. An IPv6 egress-only internet gateway is **not** a viable substitute, because those AWS endpoints are reached over IPv4. The chat and voice-note runtimes use AgentCore-managed networking and need no VPC.
- **Data retention.** Short-term memory events expire after a configured window; the raw phone number is never stored — only the pseudonymous `customer_id`. Configure Amazon DynamoDB time-to-live on `<prefix>-Carts` for automatic cleanup of stale carts.
- **Compliance.** Confirm that message and voice data handling complies with applicable regulations and with Meta's WhatsApp Business policies before deploying to production.
- **Identity and Access Management.** This Guidance creates scoped IAM roles and applies `cdk-nag` at synth time. Review the policies in each stack against your organization's requirements.
- **Asynchronous reply delivery (scaling).** The webhook worker AWS Lambda acknowledges each inbound message and hands the turn to the Amazon Bedrock AgentCore Runtime, which processes it asynchronously (acknowledge-then-continue) and delivers the reply out-of-band through the Sender Lambda for both text and voice notes. The worker therefore runs for the brief time it takes to prepare and dispatch the turn, not for the full multi-second model turn, so its Lambda concurrency footprint scales with the inbound-message rate rather than with turn duration. A customer's turns are serialized inside the runtime (a per-`customer_id` lock) so a follow-up message never runs in parallel with an in-flight turn and inherits its context. Inbound messages are de-duplicated by their WhatsApp message id (an Amazon SQS at-least-once delivery can arrive more than once). For production hardening, consider these enhancements, which are intentionally out of scope for this sample:
  - **Stage large voice replies in Amazon Simple Storage Service (Amazon S3).** The voice-note reply audio travels in the Lambda invoke payload (never stored at rest, to keep the security-review surface small), which bounds it to the AWS Lambda synchronous-invoke limit of 6 MB (about 4.5 MB of audio after base64 encoding) - well above a typical WhatsApp voice note. Staging the audio in Amazon S3 and passing only a reference would scale to WhatsApp's full 16 MB audio ceiling, at the cost of storing potentially sensitive customer audio at rest (a larger compliance surface).
  - **Persist a per-turn status and reconcile.** The baseline records an asynchronous-turn failure as an observable log and delivers a fallback message. A durable per-turn status record plus a reconciler that re-drives stuck or failed turns would add stronger at-least-once guarantees for the turn itself.
  - **Strict per-customer ordering with an Amazon SQS First-In-First-Out (FIFO) queue.** The baseline guarantees a customer's turns are never processed in parallel. If strict arrival ordering across a customer's rapid-fire messages is required, an Amazon SQS FIFO ingest queue keyed on `customer_id` (its message group id) provides ordered delivery.

### Limitations

- **WhatsApp only.** No web UI, mobile app, or browser client.
- **English only.** The system prompts and menu are configured for English.
- **Going to production on Meta.** Business verification, App Review, production phone-number registration, and display-name review are Meta console steps outside the scope of this Guidance (see `meta-whatsapp-setup-guide.html`).
- **Single Region.** The Guidance deploys into one AWS Region.

For feedback, questions, or suggestions, open an issue in the repository.

## Revisions

- **v1.0.0** — Initial release. Three WhatsApp channels (multimodal text on Amazon Nova 2 Lite via the Converse API; voice notes and WebRTC voice calls on Amazon Nova 2 Sonic speech-to-speech) over a single WhatsApp Business number, sharing one backend and one cross-channel Amazon Bedrock AgentCore Memory. Asynchronous webhook ingest via Amazon SQS, a Sender Lambda delivery path, AgentCore Gateway MCP tools with documented schemas, and an order-status notifier with an optional demo kitchen simulator.

## Authors

- Sergio Barraza, Senior TAM
- Salman Ahmed, Senior TAM
- Ravi Kumar, Senior TAM
