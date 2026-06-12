"""Gateway-only MCP tool client for the WhatsApp VoiceNotes Runtime (Task 12.3).

The VoiceNotes Runtime runs a bounded Amazon Nova 2 Sonic speech-to-speech
session, so - like the telephony Call agent - it uses the BIDIRECTIONAL
``BidiAgent`` and the bidi tool-call hook (``BidiBeforeToolCallEvent``), NOT the
standard Converse ``BeforeToolInvocationEvent`` the Chat Runtime uses. It is,
however, a WhatsApp channel: ``build_place_order_body`` sets
``channel="whatsapp"`` and there is no anonymous path (every WhatsApp message
carries a sender; the webhook derives a Customer_Id or rejects).

It reaches every backend tool through the AgentCore Gateway only (gateway-only),
authenticated with the runtime's IAM role. It never calls the backend REST API
directly.

Customer-id isolation: the model must NEVER supply ``customerId``. Two-layer
defense, identical in spirit to the telephony and Chat runtimes:
  1. ``strip_customer_id_from_schemas`` removes ``customerId`` from every tool's
     input schema, so the model literally cannot emit it.
  2. ``customer_id_hook(customer_id)`` returns a Strands ``HookProvider`` that
     fires before each bidi tool call and unconditionally writes the
     server-derived ``customerId`` into the tool input.

strands is imported lazily so this module stays importable in test/lint
environments without the bidi extra. The container always has it.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Callable, Dict, List

logger = logging.getLogger(__name__)

REGION = "us-east-1"


class ToolError(Exception):
    """Raised when an MCP tool call has exhausted its retry budget."""


def for_customer(customer_id: str) -> Callable[[], Any]:
    """Return an MCP client factory closure bound to the AgentCore Gateway.

    Usage:
        factory = mcp_tools.for_customer(customer_id)
        with MCPClient(factory) as client:
            tools = mcp_tools.apply_basepath_workaround(client.list_tools_sync())
            tools = mcp_tools.strip_customer_id_from_schemas(tools)
            # pass `tools` to BidiAgent(...)
    """

    def _factory():
        from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client

        gateway_url = os.environ.get("AGENTCORE_GATEWAY_URL")
        if not gateway_url:
            raise RuntimeError("AGENTCORE_GATEWAY_URL environment variable not set")

        return aws_iam_streamablehttp_client(
            endpoint=gateway_url,
            aws_region=REGION,
            aws_service="bedrock-agentcore",
        )

    return _factory


def apply_basepath_workaround(mcp_tools: List[Any]) -> List[Any]:
    """Strip ``basePath`` from each tool's inputSchema (AgentCore Gateway
    OpenAPI-import workaround). Mirrors the telephony / Chat agents."""
    modified = 0
    for tool in mcp_tools:
        schema = getattr(getattr(tool, "mcp_tool", None), "inputSchema", None)
        if not isinstance(schema, dict):
            continue
        props = schema.get("properties")
        if isinstance(props, dict) and "basePath" in props:
            del props["basePath"]
            modified += 1
        required = schema.get("required")
        if isinstance(required, list) and "basePath" in required:
            required.remove("basePath")
    logger.info("mcp_tools basePath workaround applied", extra={"modified": modified})
    return mcp_tools


def strip_customer_id_from_schemas(mcp_tools: List[Any]) -> List[Any]:
    """Remove ``customerId`` from every tool's inputSchema so the model cannot
    emit it. The hook injects the real value at invoke time (defense in depth)."""
    modified = 0
    for tool in mcp_tools:
        schema = getattr(getattr(tool, "mcp_tool", None), "inputSchema", None)
        if not isinstance(schema, dict):
            continue
        props = schema.get("properties")
        if isinstance(props, dict) and "customerId" in props:
            del props["customerId"]
            modified += 1
        required = schema.get("required")
        if isinstance(required, list) and "customerId" in required:
            required.remove("customerId")
    logger.info(
        "mcp_tools customerId stripped from input schemas",
        extra={"modified": modified},
    )
    return mcp_tools


class _CustomerIdInjector:
    """Strands ``HookProvider`` that overwrites ``customerId`` on every bidi tool
    call. Duck-typed (no inheritance) so the strands import stays lazy. On each
    ``BidiBeforeToolCallEvent`` it writes the session-derived ``customer_id``
    into ``tool_use["input"]["customerId"]``, replacing anything the model put
    there (the model's value is untrusted)."""

    def __init__(self, customer_id: str) -> None:
        if not customer_id:
            raise ValueError("customer_id must be a non-empty string")
        self._customer_id = customer_id

    def register_hooks(self, registry: Any, **_: Any) -> None:
        # Lazy import - strands is only present inside the container.
        from strands.experimental.hooks.events import BidiBeforeToolCallEvent

        registry.add_callback(BidiBeforeToolCallEvent, self._on_before_tool_call)

    async def _on_before_tool_call(self, event: Any) -> None:
        tool_use = getattr(event, "tool_use", None)
        if not isinstance(tool_use, dict):
            return
        args = tool_use.get("input")
        if not isinstance(args, dict):
            args = {}
        prior = args.get("customerId")
        args["customerId"] = self._customer_id  # unconditional - model is untrusted
        tool_use["input"] = args
        if prior is not None and prior != self._customer_id:
            logger.warning(
                "customerId supplied by model; overwritten",
                extra={"tool_name": tool_use.get("name")},
            )


def customer_id_hook(customer_id: str) -> Any:
    """Public factory - pass the result into ``BidiAgent(hooks=[...])``."""
    return _CustomerIdInjector(customer_id)


def build_place_order_body(customer_id: str) -> Dict[str, Any]:
    """Return the PlaceOrder body shape for the WhatsApp channel (R4.6 parity).

    channel="whatsapp" and the server-derived customerId. The webhook never
    forwards the raw phone number to the runtime, so there is no phone field
    here - the Customer_Id is the only identity the runtime carries.
    """
    return {
        "channel": "whatsapp",
        "customerId": customer_id,
    }
