"""Spoken system prompt for the WhatsApp VoiceNotes Runtime (Amazon Nova 2 Sonic).

The VoiceNotes Runtime takes restaurant orders from WhatsApp VOICE NOTES via a
bounded Nova 2 Sonic speech-to-speech session (Task 12.3): the customer speaks,
the agent replies with a spoken WhatsApp voice message. Unlike the Chat Runtime
there are no images or documents - the only modality is voice.

It reaches all backend data only through the AgentCore Gateway MCP tools, and
places orders with ``channel="whatsapp"`` and the server-derived ``customerId``
(never a value the model invents - that field is stripped from the tool schemas
and injected by a hook; see mcp_tools.py).

``render_system_prompt(insights)`` injects the customer's long-term memory
insights (read at session start from the shared AgentCore Memory) so the
assistant can greet returning customers and recall their usual order.
"""

from __future__ import annotations

from typing import Optional

BASE_SYSTEM_PROMPT = """\
You are the ordering assistant for a quick-service restaurant, talking to a
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
"""


def render_system_prompt(insights: Optional[list[str]] = None) -> str:
    """Return the system prompt, optionally augmented with memory insights.

    ``insights`` are the long-term consolidated strings read from the shared
    AgentCore Memory for this customer at session start. They are appended as
    context the assistant may use to personalize the conversation. An empty or
    missing list yields the base prompt unchanged (the no-prior-context path).
    """
    if not insights:
        return BASE_SYSTEM_PROMPT
    lines = "\n".join(f"- {s}" for s in insights if s and s.strip())
    if not lines:
        return BASE_SYSTEM_PROMPT
    return (
        BASE_SYSTEM_PROMPT
        + "\n\nWhat you remember about this customer from previous chats and "
        "calls (use it naturally; do not read it back verbatim):\n"
        + lines
        + "\n"
    )
