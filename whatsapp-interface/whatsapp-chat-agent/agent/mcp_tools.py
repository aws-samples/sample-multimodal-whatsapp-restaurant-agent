"""Gateway-only MCP tool client for the WhatsApp Chat Runtime (Task 7.2).

Adapted from the telephony agent's ``mcp_tools.py``. The structure and the
customer-id isolation strategy are the same; the differences are:

- The Chat Runtime is a STANDARD (request/response) Strands ``Agent`` using the
  Amazon Bedrock Converse API with Amazon Nova Pro - NOT the Nova Sonic
  bidirectional ``BidiAgent``. So the customer-id injection hook registers on
  the standard ``BeforeToolInvocationEvent`` rather than the bidi event.
- ``build_place_order_body`` sets ``channel="whatsapp"`` (R4.6) and there is no
  anonymous path (WhatsApp messages always carry a sender; the webhook derives a
  Customer_Id or rejects - R3.5).

The Chat Runtime reaches every backend tool through the AgentCore Gateway only
(R4.7), authenticated with the runtime's IAM role. It never calls the backend
REST API directly.

Customer-id isolation (R4.6 / cross-customer safety): the model must NEVER
supply ``customerId``. Two-layer defense, identical in spirit to telephony:
  1. ``strip_customer_id_from_schemas`` removes ``customerId`` from every tool's
     input schema, so the model literally cannot emit it.
  2. ``customer_id_hook(customer_id)`` returns a Strands ``HookProvider`` that
     fires before each tool invocation and unconditionally writes the
     server-derived ``customerId`` into the tool input.

NOTE (build-time verify): the exact Strands hook event class name can differ by
SDK version. This module imports it lazily inside ``register_hooks`` and falls
back across the known stable/experimental import paths; if the pinned strands
version in requirements.lock renames it, adjust ``_import_before_tool_event``.
strands is only present inside the container, so this module stays importable in
test/lint environments without it.
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
            # pass `tools` to Agent(...)
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
    OpenAPI-import workaround). Mirrors the telephony agent."""
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


def sanitize_tool_names(mcp_tools: List[Any]) -> List[Any]:
    """Rewrite tool names so Amazon Nova Pro never sees a hyphen (Converse fix).

    Amazon Nova Pro on the Bedrock Converse API emits a malformed tool-use
    sequence - the model errors with "Model produced invalid sequence as part of
    ToolUse" - when a tool name contains a hyphen. The AgentCore Gateway always
    prefixes tool names with the (hyphenated) target name, e.g.
    ``qsr-backend-api___GeocodeAddress``. Nova Sonic (the voice runtimes)
    tolerates the hyphen; Nova Pro (this chat runtime) does not.

    Fix: rebuild each MCP tool with a hyphen-free ``name_override`` (hyphens ->
    underscores) - that is the ONLY name the model sees. The actual gateway call
    still uses the original ``mcp_tool.name`` because strands' ``MCPAgentTool``
    keeps the agent-facing name (``tool_name`` / ``tool_spec``) separate from the
    server-call name (``stream`` uses ``mcp_tool.name``). So no reverse map is
    needed and the ``customerId`` hook is unaffected (it keys off tool input, not
    the name).
    """
    from strands.tools.mcp.mcp_agent_tool import MCPAgentTool

    out: List[Any] = []
    renamed = 0
    for tool in mcp_tools:
        original = getattr(getattr(tool, "mcp_tool", None), "name", None)
        if not original or "-" not in original:
            out.append(tool)
            continue
        safe = original.replace("-", "_")
        out.append(
            MCPAgentTool(
                mcp_tool=tool.mcp_tool,
                mcp_client=tool.mcp_client,
                name_override=safe,
                timeout=getattr(tool, "timeout", None),
            )
        )
        renamed += 1
    logger.info("mcp_tools names sanitized for Converse (hyphen -> underscore)", extra={"renamed": renamed})
    return out


def _import_before_tool_event() -> Any:
    """Import the Strands "before tool invocation" hook event class.

    Tries the stable path first, then the experimental path. Raises ImportError
    if neither is present (which only happens if strands is missing or its hook
    API changed - a correct hard failure inside the container)."""
    try:
        from strands.hooks import BeforeToolInvocationEvent  # type: ignore

        return BeforeToolInvocationEvent
    except Exception:  # noqa: BLE001 - fall back to the experimental path
        from strands.experimental.hooks.events import (  # type: ignore
            BeforeToolInvocationEvent,
        )

        return BeforeToolInvocationEvent


class _CustomerIdInjector:
    """Strands ``HookProvider`` that overwrites ``customerId`` on every tool call.

    Duck-typed against ``strands.hooks.HookProvider`` (no inheritance, so the
    import stays lazy). On each before-tool-invocation event it writes the
    session-derived ``customer_id`` into ``tool_use["input"]["customerId"]``,
    replacing anything the model emitted.
    """

    def __init__(self, customer_id: str) -> None:
        if not customer_id:
            raise ValueError("customer_id must be a non-empty string")
        self._customer_id = customer_id

    def register_hooks(self, registry: Any, **_: Any) -> None:
        event_cls = _import_before_tool_event()
        registry.add_callback(event_cls, self._on_before_tool_call)

    def _on_before_tool_call(self, event: Any) -> None:
        tool_use = getattr(event, "tool_use", None)
        if not isinstance(tool_use, dict):
            return
        args = tool_use.get("input")
        if not isinstance(args, dict):
            args = {}
        prior = args.get("customerId")
        args["customerId"] = self._customer_id  # unconditional - model is untrusted
        tool_use["input"] = args
        logger.info(
            "[mcp] before tool call name=%s id=%s input=%s",
            tool_use.get("name"),
            tool_use.get("toolUseId"),
            args,
        )
        if prior is not None and prior != self._customer_id:
            logger.warning(
                "customerId supplied by model; overwritten",
                extra={"tool_name": tool_use.get("name")},
            )


def customer_id_hook(customer_id: str) -> Any:
    """Public factory - pass the result into ``Agent(hooks=[...])``."""
    return _CustomerIdInjector(customer_id)


def build_place_order_body(customer_id: str) -> Dict[str, Any]:
    """Return the PlaceOrder body shape for the WhatsApp channel (R4.6).

    channel="whatsapp" and the server-derived customerId. The webhook never
    forwards the raw phone number to the runtime, so there is no phone field
    here - the Customer_Id is the only identity the runtime carries.
    """
    return {
        "channel": "whatsapp",
        "customerId": customer_id,
    }
