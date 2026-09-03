// Gateway-only MCP tool client for the WhatsApp VoiceNotes Runtime.
//
// Ported from mcp_tools.py + probe1_mcp.mjs. Because this runtime drives the RAW
// Nova Sonic bidi protocol (not strands BidiAgent), the tool wiring is explicit:
//   1. Connect to the AgentCore Gateway MCP endpoint over SigV4 (service
//      bedrock-agentcore) using the MCP SDK's StreamableHTTP transport with a
//      signed `fetch` hook.
//   2. listTools() -> build Nova Sonic toolSpecs with a SANITIZED name
//      ([^a-zA-Z0-9_] -> _, mapped back to the real MCP name) and a CLEANED
//      input schema (basePath + customerId removed from properties/required).
//   3. On every tool call, inject the server-derived customerId (overriding any
//      value the model emitted - the model is untrusted) and set
//      channel="whatsapp" where required (PlaceOrder).
//
// The pure helpers (cleanSchema/sonicName/toSonicToolSpecs/injectCustomerId) are
// unit-tested; the live connection is proven by the spike (probe1/probe6).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { REGION, GATEWAY_SERVICE, gatewayUrl } from "./config.js";
import { log } from "./log.js";

// --- Types --------------------------------------------------------------

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface SonicToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: string };
  };
}

export interface SonicToolConfig {
  specs: SonicToolSpec[];
  /** sanitized Sonic name -> real MCP tool name */
  nameMap: Map<string, string>;
}

/** A connected gateway the Sonic engine calls tools through. */
export interface ToolGateway {
  listTools(): Promise<McpTool[]>;
  callTool(realName: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

// --- Pure isolation helpers (unit tested) -------------------------------

/**
 * Deep-clone a tool input schema and strip the fields the model must never see:
 * `basePath` (AgentCore OpenAPI-import artifact) and `customerId` (server-only
 * identity). Removed from both `properties` and `required`.
 */
export function cleanSchema(schema?: Record<string, unknown>): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(schema || { type: "object", properties: {} })) as Record<string, unknown>;
  const props = s.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    delete props.basePath;
    delete props.customerId;
  }
  if (Array.isArray(s.required)) {
    s.required = (s.required as string[]).filter((r) => r !== "basePath" && r !== "customerId");
  }
  return s;
}

/** Sanitize an MCP tool name to the Nova Sonic tool-name charset. */
export function sonicName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Build the Nova Sonic tool configuration from the MCP tool list: a sanitized,
 * schema-cleaned toolSpec per tool plus the sanitized->real name map used to
 * route tool calls back to the gateway.
 */
export function toSonicToolSpecs(tools: McpTool[]): SonicToolConfig {
  const nameMap = new Map<string, string>();
  const specs: SonicToolSpec[] = tools.map((t) => {
    const sn = sonicName(t.name);
    nameMap.set(sn, t.name);
    return {
      toolSpec: {
        name: sn,
        description: t.description || t.name,
        inputSchema: { json: JSON.stringify(cleanSchema(t.inputSchema)) },
      },
    };
  });
  return { specs, nameMap };
}

/**
 * Inject the server-derived identity into tool-call arguments. `customerId` is
 * set unconditionally (overriding any model-supplied value - untrusted), and
 * `channel="whatsapp"` is set for the order-placement tool (parity with the
 * Python build_place_order_body). Returns a new object; never mutates input.
 */
export function injectCustomerId(
  realName: string,
  args: Record<string, unknown> | undefined,
  customerId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(args || {}) };
  const prior = out.customerId;
  out.customerId = customerId;
  if (/PlaceOrder/i.test(realName)) out.channel = "whatsapp";
  if (prior != null && prior !== customerId) {
    log.warn("customerId supplied by model; overwritten", { tool: realName });
  }
  return out;
}

// --- Live gateway (SigV4 MCP over StreamableHTTP) -----------------------

let signer: SignatureV4 | null = null;
function getSigner(): SignatureV4 {
  if (!signer) {
    signer = new SignatureV4({
      service: GATEWAY_SERVICE,
      region: REGION,
      credentials: fromNodeProviderChain(),
      sha256: Sha256,
    });
  }
  return signer;
}

/** A `fetch`-compatible wrapper that SigV4-signs each outbound request. */
export async function signedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = new URL(rawUrl);
  const method = (init.method || "GET").toUpperCase();

  const headers: Record<string, string> = {};
  const h = init.headers;
  if (h) {
    if (typeof (h as Headers).forEach === "function") {
      (h as Headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    } else {
      for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    }
  }
  headers["host"] = url.host;

  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  let body: string | Buffer | undefined = init.body as string | Buffer | undefined;
  if (body != null && typeof body !== "string") body = Buffer.from(body as Uint8Array);

  const signed = await getSigner().sign(
    new HttpRequest({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      query,
      headers,
      body,
    }),
  );
  return fetch(url, { method, headers: signed.headers, body: init.body });
}

/**
 * Connect to the AgentCore Gateway MCP endpoint over SigV4 and return a
 * ToolGateway. The caller is responsible for calling close() when the turn ends.
 */
export async function connectGateway(): Promise<ToolGateway> {
  const url = gatewayUrl();
  const client = new Client({ name: "whatsapp-voicenotes", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: signedFetch as unknown as typeof fetch,
  });
  await client.connect(transport);
  log.info("gateway connected");

  return {
    async listTools(): Promise<McpTool[]> {
      const { tools } = await client.listTools();
      return tools as unknown as McpTool[];
    },
    async callTool(realName: string, args: Record<string, unknown>): Promise<string> {
      const res = (await client.callTool({ name: realName, arguments: args })) as {
        content?: Array<{ text?: string }>;
      };
      const text = (res.content || []).map((c) => c.text || "").join(" ");
      return text || JSON.stringify(res);
    },
    async close(): Promise<void> {
      try {
        await client.close();
      } catch (e) {
        log.warn("gateway close failed", { err: (e as Error).message });
      }
    },
  };
}
