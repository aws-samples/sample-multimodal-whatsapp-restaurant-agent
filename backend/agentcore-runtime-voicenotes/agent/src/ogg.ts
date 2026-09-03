// OGG Opus <-> linear PCM transcode via bundled ffmpeg (replaces PyAV/libopus).
//
// WhatsApp voice notes are OGG Opus (48 kHz). Nova 2 Sonic consumes 16 kHz mono
// 16-bit PCM and emits 24 kHz mono 16-bit PCM. ffmpeg is what PyAV wrapped, so
// spawning it gives exact parity (proven in the spike, probe2_ogg.mjs).
import { spawn } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export class OggDecodeError extends Error {}
export class OggEncodeError extends Error {}

/** ffmpeg args to decode an OGG/Opus stream (stdin) to 16 kHz mono s16le PCM (stdout). */
export function decodeArgs(rate = 16000): string[] {
  return ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ar", String(rate), "-ac", "1", "-f", "s16le", "pipe:1"];
}

/** ffmpeg args to encode source-rate mono s16le PCM (stdin) to OGG/Opus (stdout). */
export function encodeArgs(sourceRate = 24000, bitrate = "24k"): string[] {
  return ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(sourceRate), "-ac", "1", "-i", "pipe:0", "-c:a", "libopus", "-b:a", bitrate, "-f", "ogg", "pipe:1"];
}

/** Run ffmpeg with `args`, feeding `input` on stdin, resolving the stdout Buffer. */
function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString().slice(0, 400)}`));
      else resolve(Buffer.concat(out));
    });
    p.stdin.on("error", () => { /* EPIPE if ffmpeg exits early; surfaced via close code */ });
    p.stdin.write(input);
    p.stdin.end();
  });
}

/** Decode inbound OGG Opus bytes to 16 kHz / 16-bit / mono PCM. */
export async function decodeOggToPcm16k(ogg: Buffer, rate = 16000): Promise<Buffer> {
  if (!ogg || ogg.length === 0) throw new OggDecodeError("empty inbound audio");
  let pcm: Buffer;
  try {
    pcm = await runFfmpeg(decodeArgs(rate), ogg);
  } catch (e) {
    throw new OggDecodeError(`decode failed: ${(e as Error).message}`);
  }
  if (pcm.length < 2) throw new OggDecodeError("no audio samples decoded");
  return pcm;
}

/** Encode 24 kHz / 16-bit / mono PCM to OGG Opus container bytes. */
export async function encodePcm24kToOgg(pcm: Buffer, sourceRate = 24000): Promise<Buffer> {
  if (!pcm || pcm.length === 0) throw new OggEncodeError("empty PCM to encode");
  let ogg: Buffer;
  try {
    ogg = await runFfmpeg(encodeArgs(sourceRate), pcm);
  } catch (e) {
    throw new OggEncodeError(`encode failed: ${(e as Error).message}`);
  }
  if (ogg.length === 0) throw new OggEncodeError("encoder produced no output");
  return ogg;
}
