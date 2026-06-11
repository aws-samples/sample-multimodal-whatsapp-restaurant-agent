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
