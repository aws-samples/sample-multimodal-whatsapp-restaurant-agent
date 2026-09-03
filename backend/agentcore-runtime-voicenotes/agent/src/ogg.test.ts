import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { decodeArgs, encodeArgs, decodeOggToPcm16k, encodePcm24kToOgg, OggDecodeError, OggEncodeError } from "./ogg.js";

const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0;

test("decodeArgs targets 16 kHz mono s16le", () => {
  const a = decodeArgs();
  assert.deepEqual([a[a.indexOf("-ar") + 1], a[a.indexOf("-ac") + 1], a[a.indexOf("-f") + 1]], ["16000", "1", "s16le"]);
});

test("encodeArgs reads source-rate mono s16le and writes ogg/libopus", () => {
  const a = encodeArgs();
  assert.equal(a[a.indexOf("-ar") + 1], "24000");
  assert.equal(a[a.indexOf("-c:a") + 1], "libopus");
  assert.equal(a[a.lastIndexOf("-f") + 1], "ogg");
});

test("decode rejects empty input", async () => {
  await assert.rejects(() => decodeOggToPcm16k(Buffer.alloc(0)), OggDecodeError);
});

test("encode rejects empty input", async () => {
  await assert.rejects(() => encodePcm24kToOgg(Buffer.alloc(0)), OggEncodeError);
});

test("round-trip through ffmpeg (self-generated ogg)", { skip: !ffmpegAvailable }, async () => {
  // Generate a 1 s 48 kHz mono opus/ogg tone with ffmpeg (self-contained, no fixture).
  const gen = spawnSync(process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000", "-ac", "1", "-c:a", "libopus", "-f", "ogg", "pipe:1"],
    { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(gen.status, 0, "tone generation failed");
  const ogg = gen.stdout;
  assert.ok(ogg.length > 0);

  const pcm16k = await decodeOggToPcm16k(ogg);
  // ~1 s of 16 kHz mono 16-bit => ~32000 bytes (allow generous tolerance).
  assert.ok(pcm16k.length > 16000 * 2 * 0.5, `decoded PCM too short: ${pcm16k.length}`);

  const reOgg = await encodePcm24kToOgg(pcm16k, 16000); // treat as source-rate for the encode-path test
  assert.ok(reOgg.length > 0, "re-encode produced no output");
});
