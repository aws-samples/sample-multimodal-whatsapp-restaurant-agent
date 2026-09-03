// WhatsApp VoiceNotes Runtime - AgentCore Runtime host contract.
//
// Ported from the handler.py entrypoint. AgentCore Runtime requires the
// container to serve two routes on port 8080:
//   POST /invocations  - the webhook worker's request. We ACK IMMEDIATELY
//                        ({accepted:true}) and run the voice-note turn in the
//                        background, serialized per customer, delivering the
//                        reply out-of-band via the Sender Lambda. The worker is
//                        never blocked for the Nova Sonic turn (Move A).
//   GET  /ping         - health check. Reports "HealthyBusy" while any turn is
//                        in flight so the microVM is not idle-terminated
//                        mid-turn, else "Healthy".
//
// The invoke wiring is injectable so the routing + ack can be unit-tested
// without running a real turn.
import http from "node:http";
import { dispatchTurn, withTypingRefresh, inFlightCount } from "./dispatch.js";
import { runVoiceTurnGuarded, type VoiceNotePayload } from "./turn.js";
import { sendTyping } from "./sender.js";
import { log } from "./log.js";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

export interface Ack {
  accepted: boolean;
  error?: string;
}

/** Resolve + validate the customer id; the ack is the entrypoint's response. */
export function ackFor(payload: VoiceNotePayload): Ack {
  const customerId = (payload.customer_id || payload.session_id || "").trim();
  if (!customerId) return { accepted: false, error: "missing_customer_id" };
  return { accepted: true };
}

/** Health-check body: HealthyBusy while any turn is in flight, else Healthy. */
export function pingBody(inflight: number): { status: string } {
  return { status: inflight > 0 ? "HealthyBusy" : "Healthy" };
}

/** Fire-and-forget dispatcher type (defaults to the real per-customer chain). */
export type Dispatch = (customerId: string, run: () => Promise<void>) => unknown;

const defaultDispatch: Dispatch = (customerId, run) => dispatchTurn(customerId, run);

/**
 * Validate the payload and, if accepted, dispatch the guarded turn in the
 * background (serialized per customer, with a typing-indicator refresh). Returns
 * the ack synchronously. `dispatch` is injectable for tests.
 */
export function handleInvocation(payload: VoiceNotePayload, dispatch: Dispatch = defaultDispatch): Ack {
  const ack = ackFor(payload);
  if (!ack.accepted) return ack;
  const customerId = (payload.customer_id || payload.session_id || "").trim();
  const messageId = (payload.message_id || "").trim();
  dispatch(customerId, () => withTypingRefresh(() => runVoiceTurnGuarded(payload), messageId, sendTyping));
  return ack;
}

function readJsonBody(req: http.IncomingMessage, limitBytes = 12_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export interface HttpServerOptions {
  dispatch?: Dispatch;
  inFlight?: () => number;
}

/** Build the AgentCore host HTTP server. Options are injectable for tests. */
export function createHttpServer(opts: HttpServerOptions = {}): http.Server {
  const dispatch = opts.dispatch || defaultDispatch;
  const inFlight = opts.inFlight || inFlightCount;

  return http.createServer((req, res) => {
    const method = req.method || "GET";
    const url = (req.url || "/").split("?")[0];

    if (method === "GET" && url === "/ping") {
      sendJson(res, 200, pingBody(inFlight()));
      return;
    }

    if (method === "POST" && url === "/invocations") {
      readJsonBody(req)
        .then((body) => {
          const ack = handleInvocation((body || {}) as VoiceNotePayload, dispatch);
          sendJson(res, 200, ack);
        })
        .catch((e) => {
          const msg = (e as Error).message;
          sendJson(res, msg === "invalid_json" ? 400 : 413, { accepted: false, error: msg });
        });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });
}

/** Start the runtime host. Entrypoint for the container. */
export function start(): http.Server {
  const server = createHttpServer();
  server.listen(PORT, HOST, () => log.info("voicenotes runtime listening", { host: HOST, port: PORT }));
  return server;
}

// Start when run directly (node dist/server.js), not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
