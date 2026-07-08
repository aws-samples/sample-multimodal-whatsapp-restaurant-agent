# WhatsApp VoiceNotes Runtime

The VoiceNotes Runtime answers WhatsApp **voice notes** for the quick-service
restaurant (QSR) ordering assistant. A customer sends a voice note; the runtime
transcribes, reasons, calls backend tools, and replies with one or more spoken
WhatsApp voice notes. It runs on **Amazon Bedrock AgentCore Runtime** (microVM
session isolation) and uses **Amazon Nova 2 Sonic** for bidirectional
speech-to-speech.

This runtime is written in **TypeScript** and speaks the **raw Nova Sonic
bidirectional protocol** directly (over the AWS SDK bidi stream). It does not use
the Strands Agents framework. See `DEVELOPER_NOTES.md` for why.

## What it does

For each inbound voice note the runtime:

1. Decodes the inbound **OGG Opus** audio to 16 kHz mono 16-bit linear PCM.
2. Reads the customer's long-term insights from the shared **Amazon Bedrock
   AgentCore Memory** (cross-channel recall) and seeds them into the spoken
   system prompt.
3. Opens a bounded Nova 2 Sonic session with the backend tools exposed through
   the **AgentCore Gateway** (Model Context Protocol, MCP), feeds the note, and
   collects the spoken response.
4. Splits the response into speech **segments** at tool round-trips (narration
   before a tool call, the answer after it), encodes each 24 kHz PCM segment back
   to OGG Opus, and delivers each as its own WhatsApp voice note via the Sender
   Lambda (out-of-band; the runtime never returns audio to the caller).
5. Writes the two conversation turns back to shared memory.

If a note cannot be understood, decoded, or answered, the runtime sends a short
text fallback instead of a voice reply.

## Request / response contract (unchanged)

The AgentCore Runtime host serves two routes on port 8080:

- `POST /invocations` - the webhook worker's request. The runtime **acknowledges
  immediately** (`{"accepted": true}`) and runs the turn in the background,
  serialized per customer, delivering the reply out-of-band. Payload:

  ```json
  {
    "session_id":  "wa-1f0c3a9b2e4d6f80",
    "customer_id": "wa-1f0c3a9b2e4d6f80",
    "message_id":  "wamid....",
    "audio_b64":   "<base64 OGG Opus bytes>"
  }
  ```

- `GET /ping` - health check. Reports `HealthyBusy` while any turn is in flight
  (so the microVM is not idle-terminated mid-turn), else `Healthy`.

The invoke payload, Sender Lambda contract, gateway wiring, shared-memory keying,
IAM role, and environment variables are all **unchanged** from the previous
Python implementation - only the runtime language and the container image change.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AGENTCORE_GATEWAY_URL` | AgentCore Gateway MCP endpoint (tool use). |
| `SENDER_LAMBDA_ARN` | Sender Lambda for out-of-band delivery. |
| `WA_MEMORY_ID` / `SHARED_MEMORY_ARN` | Shared AgentCore Memory id (the ARN is parsed if the bare id is absent). |
| `AWS_REGION` | AWS region (default `us-east-1`). |
| `LOG_LEVEL` | `DEBUG` / `INFO` / `WARN` / `ERROR` (default `INFO`). |

## Layout

```
agent/
  src/            TypeScript source (compiled to dist/ in the container)
  Dockerfile      Node 22 ARM64 + ffmpeg, multi-stage build
  package.json    build (tsc) + test (node:test via tsx) scripts
cdk/              CDK app that builds the image and provisions the runtime
```

## Build and test

```bash
cd agent
npm ci
npm run build     # tsc -> dist/
npm test          # unit tests (node:test)
```

The container is an ARM64 image (AgentCore requirement) built by the CDK/CodeBuild
pipeline with `docker buildx --platform=linux/arm64`; it installs `ffmpeg` for
the OGG Opus transcode and runs `node dist/server.js`.
