// Progress-marker parser for the web UI installer.
//
// deploy-all.sh emits machine-readable lines of the form:
//   @@WAUI@@ {"type":"layer","key":"wa-gateway","state":"start"}
// (only when WAUI=1; see scripts/deployment-state.sh waui_marker). The prefix
// may be preceded by other text on the line, so we locate it rather than
// requiring it at column 0. Any line without a well-formed marker is treated
// as plain log text (Requirement 4.5) - malformed markers never throw and
// never change node state.

export const MARKER_PREFIX = '@@WAUI@@';

const VALID_TYPES = new Set(['layer', 'build']);
const VALID_STATES = new Set(['start', 'done', 'skipped', 'fail']);

/**
 * Parse a single line of deploy output.
 * @param {string} line
 * @returns {object|null} the typed marker event, or null if the line is not a
 *   well-formed marker (caller should treat null as a plain log line).
 */
export function parseMarkerLine(line) {
  if (typeof line !== 'string') return null;
  const idx = line.indexOf(MARKER_PREFIX);
  if (idx === -1) return null;
  const jsonPart = line.slice(idx + MARKER_PREFIX.length).trim();
  if (!jsonPart) return null;
  let obj;
  try {
    obj = JSON.parse(jsonPart);
  } catch {
    return null; // malformed marker -> treat as log text, never throw
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.type !== 'string' || !VALID_TYPES.has(obj.type)) return null;
  if (typeof obj.key !== 'string' || obj.key.length === 0) return null;
  // 'state' is required for layer markers; 'build' markers may carry 'phase'.
  if (obj.type === 'layer' && !VALID_STATES.has(obj.state)) return null;
  return obj;
}

/**
 * Classify a line as either a marker event or plain log text.
 * @param {string} line
 * @returns {{kind:'marker', event:object} | {kind:'log', line:string}}
 */
export function classifyLine(line) {
  const event = parseMarkerLine(line);
  if (event) return { kind: 'marker', event };
  return { kind: 'log', line: typeof line === 'string' ? line : String(line) };
}
