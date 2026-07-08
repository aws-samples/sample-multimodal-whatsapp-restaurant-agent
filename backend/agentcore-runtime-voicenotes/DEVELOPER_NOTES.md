# VoiceNotes Runtime - developer notes

## Why TypeScript on the raw Nova Sonic protocol

The VoiceNotes Runtime was originally built in Python on the Strands Agents
bidirectional agent (`BidiAgent`). On multi-task voice notes (a customer asking
the agent to do several things in one note), the Strands bidi loop **re-prompted
the model turn after turn** and the model spiralled into spoken chain-of-thought:
runs of 49-105 response cycles and ~150 s of audio against a 45 s turn budget,
instead of one coherent reply.

A focused investigation isolated the runaway to the Strands bidi layer, not the
Nova Sonic service. Driving the **raw** Nova Sonic bidirectional protocol against
the exact same multi-task notes produced a single, bounded response cycle and a
coherent multi-tool answer. The migration thesis - "leave Strands, keep raw
Sonic" - held end to end across five integration probes (MCP over the gateway
with SigV4, OGG Opus transcode, a raw Sonic turn, AgentCore Memory, and the Node
runtime host contract).

So this runtime speaks the raw bidirectional protocol directly over the AWS SDK
bidi stream and reproduces the empirically tuned turn behavior (below) rather
than relying on a framework loop. The chat runtime and the voice-call runtime are
unaffected and continue to use Strands.

## Tuned turn behavior (behavioral parity is the bar)

Ported verbatim in behavior from the previous `bounded_sonic.py`:

- **Bounded endpointing silence.** After the note's audio, a real-time-paced
  silence burst (~2.5 s) lets server-side voice-activity detection (VAD) endpoint
  the user's turn so the model responds. The burst is **bounded** and stops the
  instant the model starts speaking - a *continuous* silence stream repeatedly
  re-trips the endpointer and is exactly what caused the re-prompt spiral.
- **Sparse keepalive.** After the burst, one silence frame every ~15 s keeps the
  bidi stream from idle-closing across a tool round-trip, without re-tripping VAD.
- **Audio-idle end-of-response.** Nova Sonic does not emit a per-turn completion
  event mid-session, so the turn ends when audio has started and then no new
  chunk arrives for ~1.2 s (with a hard timeout as the no-audio fallback).
- **Segment split at tool round-trips.** The model narrates ("let me check your
  cart"), calls a tool, then speaks the answer - delivered as two separate voice
  notes. A sub-0.3 s fragment before a tool call is merged into the next segment
  rather than sent as its own tiny note.

## Module map (`agent/src`)

| Module | Responsibility |
| --- | --- |
| `config.ts` | Env accessors + tuning constants (audio shape, silence, timeouts, segment sizing). |
| `ogg.ts` | OGG Opus <-> linear PCM transcode by spawning **ffmpeg** (exact parity with the prior PyAV path). |
| `systemPrompt.ts` | Spoken system prompt + memory-insight injection. |
| `sender.ts` | Sender Lambda client (audio / text / typing) for out-of-band delivery. |
| `memory.ts` | Shared AgentCore Memory read (insights) + write (turns), keyed by `customer_id`. |
| `mcpTools.ts` | SigV4 MCP client over the gateway + `customerId` isolation (schema clean, name sanitize/map, server-side inject). |
| `sonic.ts` | Raw Nova Sonic bidi engine: priming events, real-time feed, segmentation, tool round-trips, teardown. |
| `turn.ts` | Turn orchestrator + guarded fallbacks (oversize segment -> text, could-not-understand -> text). |
| `dispatch.ts` | Per-customer serialization (promise chain), typing-indicator refresh, async-turn signals, in-flight count. |
| `server.ts` | AgentCore host: `/invocations` fast-ack + background dispatch, `/ping` Healthy/HealthyBusy. |

## Codec: bundled ffmpeg

WhatsApp voice notes are OGG Opus (48 kHz). Nova 2 Sonic consumes 16 kHz mono
16-bit PCM and emits 24 kHz mono 16-bit PCM. `ogg.ts` spawns `ffmpeg` for both
directions - ffmpeg is what PyAV wrapped, so this is exact parity. The container
installs `ffmpeg` (Debian slim); `FFMPEG_PATH` overrides the binary path for
local runs.

## customer_id isolation (unchanged in spirit)

The model must never supply `customerId`. Two layers, ported from the Python
runtime:

1. `customerId` (and the gateway's `basePath` artifact) are stripped from every
   tool's input schema, so the model cannot emit them.
2. On every tool call the server-derived `customerId` is injected into the
   arguments, overriding any model value; `channel="whatsapp"` is set for
   PlaceOrder.

## Testing

Unit tests (`node:test`, run via `tsx`) cover the pure logic: audio framing,
segmentation, MCP schema isolation, the fallback paths, and per-customer dispatch
serialization. The raw Sonic transport is injectable, so `sonic.ts` is tested
with a scripted event sequence (an audio-only turn and a tool round-trip) without
a live model. The live Sonic / gateway / memory round-trips and AgentCore session
affinity / `HealthyBusy` are validated at deploy time.

```bash
cd agent && npm test
```

## Session affinity note

Per-customer serialization uses an in-process promise chain, which is coherent
because the deterministic runtime session id routes a customer's invocations to
the same microVM. If session affinity cannot be guaranteed, an external lease is
the documented hardening (carried over from the async-reply-delivery design).

## Python retirement

The previous Python/Strands sources (`handler.py`, `bounded_sonic.py`,
`ogg_codec.py`, `mcp_tools.py`, `memory_client.py`, `sender_client.py`,
`async_dispatch.py`, `system_prompt.py`) remain in `agent/` during the migration
and are removed at cutover, once the TypeScript runtime is validated end to end
in a live deploy. The Strands and PyAV dependencies are retired with them.
