// Meta Media API download for inbound attachments (Task 8.1, R4.8).
//
// Two-step download: GET the time-limited media URL by media id, then GET the
// bytes - both with the Access_Token as a Bearer credential. Uses the Node 18+
// global fetch (no extra HTTP dependency). The token is never logged.

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_BYTES = 16 * 1024 * 1024; // 16 MB, the WhatsApp media ceiling

async function getJson(url: string, token: string): Promise<any> {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`media metadata http ${resp.status}`);
  return resp.json();
}

/** Return the raw bytes for a media id, or null on any failure/oversize.
 *  Never throws; the caller falls back to a could-not-process reply (R4.9). */
export async function downloadMedia(mediaId: string, token: string): Promise<Buffer | null> {
  if (!mediaId || !token) return null;
  try {
    const meta = await getJson(`${GRAPH_BASE}/${mediaId}`, token);
    const url: string | undefined = meta?.url;
    if (!url) return null;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

// Voice-note download (Task 12.5, R7.1/R7.2/R7.7/R7.8). Same two-step Media API
// flow as downloadMedia but with the bounded timeouts the voice-note path
// requires: <=10 s to fetch the time-limited URL (R7.1), <=30 s to download the
// bytes for files up to 16 MB (R7.2). Any failure / timeout / empty / oversize
// returns null so the caller discards partial data and asks for a resend or
// text (R7.7/R7.8).
const MEDIA_URL_TIMEOUT_MS = 10_000; // R7.1
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000; // R7.2

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadVoiceNote(mediaId: string, token: string): Promise<Buffer | null> {
  if (!mediaId || !token) return null;
  try {
    const metaResp = await fetchWithTimeout(
      `${GRAPH_BASE}/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` } },
      MEDIA_URL_TIMEOUT_MS,
    );
    if (!metaResp.ok) return null;
    const meta = (await metaResp.json()) as { url?: string };
    const url = meta?.url;
    if (!url) return null;
    const resp = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}
