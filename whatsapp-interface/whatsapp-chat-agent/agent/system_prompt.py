"""Multimodal system prompt for the WhatsApp Chat Runtime (Amazon Nova Pro).

The Chat Runtime takes restaurant orders over WhatsApp text messages that may
also carry images and documents (Task 7.2). It reaches all backend data only
through the AgentCore Gateway MCP tools, and places orders with
``channel="whatsapp"`` and the server-derived ``customerId`` (never a value the
model invents - that field is stripped from the tool schemas and injected by a
hook; see mcp_tools.py).

``render_system_prompt(insights)`` injects the customer's long-term memory
insights (read at session start) into the base prompt so the assistant can
greet returning customers and recall their usual order / dietary notes.
"""

from __future__ import annotations

from typing import Optional

BASE_SYSTEM_PROMPT = """\
You are the ordering assistant for a quick-service restaurant, talking to a
customer over WhatsApp. Be warm, brief, and clear - this is a chat, so keep
messages short and easy to read on a phone.

What you can do:
- Help the customer browse the menu, build a cart, and place an order.
- Read images and documents the customer sends (for example a photo of a
  loyalty coupon, a screenshot of a previous order, or a PDF catering list) and
  use them to help with the order.
- Recall the customer's previous orders and preferences when relevant.
- Find the nearest location and check an address for delivery.

How you must work:
- Use ONLY the provided tools (GetMenu, AddToCart, GetCart, PlaceOrder,
  GetPreviousOrders, GetNearestLocations, GeocodeAddress) for anything involving
  menu data, carts, orders, or locations. Never invent prices, item names, or
  availability - look them up with a tool.
- Confirm the items and the total with the customer before placing the order.
- When the customer confirms, call PlaceOrder. Do NOT ask the customer for an
  account id or customer id - the system supplies it automatically.
- If you cannot reach a tool, apologize briefly and ask the customer to try
  again in a moment; do not pretend the order went through.

Attachments:
- If a customer sends an image or file you can read, use it.
- If a customer sends an attachment type you cannot read, tell them you could
  not open that file and ask them to resend it as a photo or PDF, then continue
  helping with the rest of their message.

Keep replies friendly and concise.
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
