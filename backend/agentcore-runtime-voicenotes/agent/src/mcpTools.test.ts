import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSchema, sonicName, toSonicToolSpecs, injectCustomerId, type McpTool } from "./mcpTools.js";

test("cleanSchema strips basePath and customerId from properties and required", () => {
  const schema = {
    type: "object",
    properties: { basePath: { type: "string" }, customerId: { type: "string" }, city: { type: "string" } },
    required: ["basePath", "customerId", "city"],
  };
  const out = cleanSchema(schema);
  const props = out.properties as Record<string, unknown>;
  assert.ok(!("basePath" in props));
  assert.ok(!("customerId" in props));
  assert.ok("city" in props);
  assert.deepEqual(out.required, ["city"]);
});

test("cleanSchema does not mutate the input", () => {
  const schema = { type: "object", properties: { customerId: { type: "string" } }, required: ["customerId"] };
  cleanSchema(schema);
  assert.ok("customerId" in (schema.properties as Record<string, unknown>), "input must be untouched");
});

test("cleanSchema tolerates a missing schema", () => {
  const out = cleanSchema(undefined);
  assert.equal(out.type, "object");
  assert.deepEqual(out.properties, {});
});

test("sonicName replaces illegal chars with underscore", () => {
  assert.equal(sonicName("qsr-backend-api___GetMenu"), "qsr_backend_api___GetMenu");
  assert.equal(sonicName("x_amz_bedrock_agentcore_search"), "x_amz_bedrock_agentcore_search");
  assert.equal(sonicName("a.b:c/d"), "a_b_c_d");
});

test("toSonicToolSpecs builds specs and a reverse name map", () => {
  const tools: McpTool[] = [
    { name: "qsr-backend-api___GetMenu", description: "menu", inputSchema: { type: "object", properties: { customerId: {}, basePath: {} } } },
    { name: "x_amz_bedrock_agentcore_search" },
  ];
  const { specs, nameMap } = toSonicToolSpecs(tools);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].toolSpec.name, "qsr_backend_api___GetMenu");
  assert.equal(nameMap.get("qsr_backend_api___GetMenu"), "qsr-backend-api___GetMenu");
  // description falls back to the name when absent
  assert.equal(specs[1].toolSpec.description, "x_amz_bedrock_agentcore_search");
  // schema is a cleaned JSON string
  const parsed = JSON.parse(specs[0].toolSpec.inputSchema.json);
  assert.ok(!("customerId" in parsed.properties));
  assert.ok(!("basePath" in parsed.properties));
});

test("injectCustomerId overrides any model value and never mutates input", () => {
  const modelArgs = { customerId: "wa-EVIL", city: "McKinney" };
  const out = injectCustomerId("qsr-backend-api___GetNearestLocations", modelArgs, "wa-real123");
  assert.equal(out.customerId, "wa-real123");
  assert.equal(out.city, "McKinney");
  assert.equal(modelArgs.customerId, "wa-EVIL", "input must be untouched");
  assert.ok(!("channel" in out), "channel only injected for PlaceOrder");
});

test("injectCustomerId sets channel=whatsapp for PlaceOrder", () => {
  const out = injectCustomerId("qsr-backend-api___PlaceOrder", {}, "wa-real123");
  assert.equal(out.customerId, "wa-real123");
  assert.equal(out.channel, "whatsapp");
});

test("injectCustomerId handles undefined args", () => {
  const out = injectCustomerId("GetMenu", undefined, "wa-real123");
  assert.deepEqual(out, { customerId: "wa-real123" });
});
