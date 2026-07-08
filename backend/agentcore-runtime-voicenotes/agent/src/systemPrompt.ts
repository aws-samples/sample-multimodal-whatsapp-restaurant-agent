// Spoken system prompt for the WhatsApp VoiceNotes Runtime (Amazon Nova 2 Sonic).
//
// Ported verbatim from system_prompt.py. The VoiceNotes Runtime takes restaurant
// orders from WhatsApp voice notes via a bounded Nova 2 Sonic speech-to-speech
// session: the customer speaks, the agent replies with a spoken voice message.
// The only modality is voice - no images or documents.
//
// It reaches backend data only through the AgentCore Gateway MCP tools, and
// places orders with channel="whatsapp" and the server-derived customerId
// (never a value the model invents - that field is stripped from the tool
// schemas and injected by a hook; see mcpTools.ts).
//
// renderSystemPrompt(insights) injects the customer's long-term memory insights
// (read at session start from the shared AgentCore Memory) so the assistant can
// greet returning customers and recall their usual order.

export const BASE_SYSTEM_PROMPT = `You are the ordering assistant for a quick-service restaurant, talking to a
customer over a WhatsApp voice note. You hear the customer speak and you reply
by speaking. Be warm, natural, and brief - this is a short voice exchange, so
keep each spoken reply to a sentence or two and easy to follow by ear.

What you can do:
- Help the customer hear the menu, build a cart, and place an order by voice.
- Recall the customer's previous orders and preferences when relevant.
- Find the nearest location and check an address for delivery.

How you must work:
- Use ONLY the provided tools (GetMenu, AddToCart, GetCart, PlaceOrder,
  GetPreviousOrders, GetNearestLocations, GeocodeAddress) for anything involving
  menu data, carts, orders, or locations. Never invent prices, item names, or
  availability - look them up with a tool.
- Because this is voice, read back item names and the total clearly and confirm
  out loud before placing the order.
- When the customer confirms, call PlaceOrder. Do NOT ask the customer for an
  account id or customer id - the system supplies it automatically.
- If you cannot reach a tool, apologize briefly and ask the customer to try
  again in a moment; do not pretend the order went through.
- If you did not catch what the customer said, ask them to repeat it rather than
  guessing.

Keep replies friendly, spoken, and concise.
`;

/**
 * Return the system prompt, optionally augmented with memory insights.
 *
 * `insights` are the long-term consolidated strings read from the shared
 * AgentCore Memory for this customer at session start. They are appended as
 * context the assistant may use to personalize the conversation. An empty or
 * missing list yields the base prompt unchanged (the no-prior-context path).
 */
export function renderSystemPrompt(insights?: string[]): string {
  if (!insights || insights.length === 0) return BASE_SYSTEM_PROMPT;
  const lines = insights
    .filter((s) => s && s.trim())
    .map((s) => `- ${s}`)
    .join("\n");
  if (!lines) return BASE_SYSTEM_PROMPT;
  return (
    BASE_SYSTEM_PROMPT +
    "\n\nWhat you remember about this customer from previous chats and " +
    "calls (use it naturally; do not read it back verbatim):\n" +
    lines +
    "\n"
  );
}
