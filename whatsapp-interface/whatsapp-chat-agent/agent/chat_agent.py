"""WhatsApp Chat Runtime - multimodal ordering agent (Task 7.2).

A Strands ``Agent`` on the Amazon Bedrock Converse API with Amazon Nova Pro that
accepts text + image + document content blocks, routes every backend
interaction through the AgentCore Gateway MCP tools (gateway-only, R4.7), places
orders with channel="whatsapp" and the server-derived Customer_Id (R4.6), and
reads/writes the shared AgentCore Memory keyed by customer_id (R4.10, R5.6) via
the copied ``memory_client.py``.

Invoke contract (the webhook handler - Task 8 - builds this payload):

    POST /invocations
    {
      "session_id":  "wa-1f0c3a9b2e4d6f80",   # == customer_id (R5.1)
      "customer_id": "wa-1f0c3a9b2e4d6f80",
      "text":        "optional caption / message body",
      "images":    [ { "format": "jpeg", "bytes_b64": "..." } ],
      "documents": [ { "format": "pdf", "name": "menu", "bytes_b64": "..." } ]
    }

    200 -> { "reply": "<assistant text>",
             "unsupported_attachments": [ {"kind":"image","format":"tiff"} ] }

Unsupported attachment types are skipped (not failed) and reported back so the
reply layer can ask the customer to resend them in a supported form, while the
rest of the message is still processed (R4.9).

Session retention / inactivity reset / strict cross-customer isolation are
wired in Task 8.2; this module handles one invocation seeded with the shared
memory insights for the customer.

Heavy deps (strands, boto3, fastapi) are imported lazily / guarded so a bare
``python -c "import chat_agent"`` smoke test (used in the Docker build) works
without them present.
"""
from __future__ import annotations

import base64
import logging
import os
import re
from typing import Any, Optional

import mcp_tools
from memory_client import ENV_MEMORY_ID, SharedMemoryClient, Turn
from session_store import InProcessSessionStore
from system_prompt import render_system_prompt

logger = logging.getLogger(__name__)

# Per-container conversation session store (R5.2-R5.5). Demo-grade: a warm
# container retains context; a cold start or a second instance starts fresh.
_SESSIONS = InProcessSessionStore()

# Amazon Nova Pro via a cross-region inference profile (configurable).
NOVA_PRO_MODEL_ID = os.environ.get("NOVA_PRO_MODEL_ID", "us.amazon.nova-pro-v1:0")

# Formats Amazon Nova Pro accepts as Converse content blocks. Anything else is
# skipped and reported as unsupported (R4.9).
SUPPORTED_IMAGE_FORMATS = {"png", "jpeg", "gif", "webp"}
SUPPORTED_DOCUMENT_FORMATS = {
    "pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md",
}
# Common alias normalization before the support check.
_IMAGE_FORMAT_ALIASES = {"jpg": "jpeg"}

# Converse document names allow alphanumerics, spaces, hyphens, parentheses, and
# square brackets. Sanitize anything else so the API does not reject the block.
_DOC_NAME_SAFE = re.compile(r"[^a-zA-Z0-9 \-\(\)\[\]]")


def _resolve_memory_id() -> str:
    """Resolve the AgentCore Memory id from the container environment.

    Prefers ``WA_MEMORY_ID`` (the bare id the canonical client reads). Falls back
    to parsing it out of ``SHARED_MEMORY_ARN`` (``arn:...:memory/<id>``) because
    the Task 7.1 chat-agent stack currently threads only the ARN. Returns "" when
    neither is set (the memory client then degrades gracefully). See the
    orchestrator note: the stack should also thread WA_MEMORY_ID for parity with
    the other runtimes.
    """
    memory_id = os.environ.get(ENV_MEMORY_ID, "").strip()
    if memory_id:
        return memory_id
    arn = os.environ.get("SHARED_MEMORY_ARN", "").strip()
    if arn and "/" in arn:
        return arn.rsplit("/", 1)[-1]
    return ""


def _normalize_image_format(fmt: str) -> str:
    fmt = (fmt or "").lower().lstrip(".")
    return _IMAGE_FORMAT_ALIASES.get(fmt, fmt)


def _sanitize_doc_name(name: str, fallback: str) -> str:
    cleaned = _DOC_NAME_SAFE.sub(" ", (name or "").strip()) or fallback
    # Collapse runs of spaces and cap length (Converse caps the name length).
    return re.sub(r"\s+", " ", cleaned)[:64]


def build_content_blocks(payload: dict) -> tuple[list, list]:
    """Turn the invoke payload into Converse content blocks (pure, testable).

    Returns ``(blocks, unsupported)`` where ``blocks`` is the Converse
    content-block list (text first, then supported images, then supported
    documents) and ``unsupported`` lists the attachments that were skipped
    because Nova Pro does not accept their format (R4.9). Decodes base64 bytes;
    a block with undecodable bytes is treated as unsupported rather than raising.
    """
    blocks: list = []
    unsupported: list = []

    text = (payload.get("text") or "").strip()
    if text:
        blocks.append({"text": text})

    for idx, img in enumerate(payload.get("images") or []):
        fmt = _normalize_image_format(img.get("format", ""))
        if fmt not in SUPPORTED_IMAGE_FORMATS:
            unsupported.append({"kind": "image", "format": img.get("format", "")})
            continue
        try:
            data = base64.b64decode(img.get("bytes_b64", ""), validate=True)
        except Exception:  # noqa: BLE001
            unsupported.append({"kind": "image", "format": fmt})
            continue
        blocks.append({"image": {"format": fmt, "source": {"bytes": data}}})

    for idx, doc in enumerate(payload.get("documents") or []):
        fmt = (doc.get("format") or "").lower().lstrip(".")
        if fmt not in SUPPORTED_DOCUMENT_FORMATS:
            unsupported.append({"kind": "document", "format": doc.get("format", "")})
            continue
        try:
            data = base64.b64decode(doc.get("bytes_b64", ""), validate=True)
        except Exception:  # noqa: BLE001
            unsupported.append({"kind": "document", "format": fmt})
            continue
        name = _sanitize_doc_name(doc.get("name", ""), f"document {idx + 1}")
        blocks.append(
            {"document": {"format": fmt, "name": name, "source": {"bytes": data}}}
        )

    return blocks, unsupported


def _summarize_user_turn(payload: dict, unsupported: list) -> str:
    """A short, text-only description of the user's turn for memory (no bytes)."""
    parts = []
    text = (payload.get("text") or "").strip()
    if text:
        parts.append(text)
    n_img = len(payload.get("images") or [])
    n_doc = len(payload.get("documents") or [])
    if n_img:
        parts.append(f"[sent {n_img} image(s)]")
    if n_doc:
        parts.append(f"[sent {n_doc} document(s)]")
    if unsupported:
        parts.append(f"[{len(unsupported)} unsupported attachment(s) skipped]")
    return " ".join(parts) or "[empty message]"


def run_chat_turn(payload: dict) -> dict:
    """Run one multimodal chat turn end to end.

    Reads shared memory insights at session start, builds the Nova Pro agent
    with gateway MCP tools, runs the Converse loop over the content blocks, writes
    the conversation turns to shared memory at session end, and returns the reply.
    """
    customer_id = (payload.get("customer_id") or payload.get("session_id") or "").strip()
    if not customer_id:
        return {"error": "missing_customer_id", "reply": ""}

    blocks, unsupported = build_content_blocks(payload)
    if not blocks:
        # Nothing usable to send to the model (input gating proper is Task 8.1).
        return {
            "reply": "Sorry, I could not read your message. Please send text, a "
            "photo, or a PDF.",
            "unsupported_attachments": unsupported,
        }

    # --- session start: read shared long-term memory (graceful on failure) ---
    memory = SharedMemoryClient(memory_id=_resolve_memory_id())
    read = memory.read_long_term(customer_id)
    if not read.ok:
        logger.info("proceeding with no prior insights for %s (%s)", customer_id, read.error)

    system_prompt = render_system_prompt(read.insights)

    # --- session retention: load prior turns (honors the 30-min reset) -------
    # R5.2-R5.5: strict per-customer isolation, <= 50 turns, fresh after 1800s
    # idle, and never fail on a load error (proceed with no prior turns).
    prior_messages = _SESSIONS.load_prior(customer_id)

    # --- build + run the agent inside the MCP client context ---
    reply_text, updated_messages = _invoke_agent(
        customer_id, system_prompt, blocks, prior_messages
    )

    # Persist the updated history (text-reduced + trimmed to 50 turns).
    if updated_messages is not None:
        _SESSIONS.save(customer_id, updated_messages)

    # --- session end: write the turns to shared memory (graceful on failure) ---
    memory.write_events(
        customer_id,
        customer_id,  # session_id == customer_id (R5.1); full session model is Task 8.2
        [
            Turn(role="USER", text=_summarize_user_turn(payload, unsupported)),
            Turn(role="ASSISTANT", text=reply_text or ""),
        ],
    )

    result = {"reply": reply_text}
    if unsupported:
        result["unsupported_attachments"] = unsupported
    return result


def _invoke_agent(
    customer_id: str, system_prompt: str, content_blocks: list, prior_messages: Optional[list] = None
) -> tuple[str, Optional[list]]:
    """Construct the Nova Pro Strands Agent with gateway tools and run one turn.

    ``prior_messages`` seeds the agent with the retained conversation history
    (Task 8.2). Returns ``(reply_text, updated_messages)`` where
    ``updated_messages`` is the agent's full message list after the turn (for the
    session store to retain) or None if it could not be read.

    All heavy imports (strands, the MCP client) are local so this module imports
    without them. The MCP tools are discovered and used inside the MCPClient
    context manager; customerId is stripped from the tool schemas and injected by
    the hook so the model can never set it (R4.6).
    """
    from strands import Agent
    from strands.models import BedrockModel
    from strands.tools.mcp.mcp_client import MCPClient

    model = BedrockModel(model_id=NOVA_PRO_MODEL_ID, region_name=os.environ.get("AWS_REGION", "us-east-1"))

    with MCPClient(mcp_tools.for_customer(customer_id)) as client:
        tools = client.list_tools_sync()
        tools = mcp_tools.apply_basepath_workaround(tools)
        tools = mcp_tools.strip_customer_id_from_schemas(tools)

        agent = Agent(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
            messages=list(prior_messages) if prior_messages else None,
            hooks=[mcp_tools.customer_id_hook(customer_id)],
        )
        result = agent(content_blocks)
        updated = getattr(agent, "messages", None)
        return str(result).strip(), updated


# --- AgentCore Runtime HTTP surface -----------------------------------------
# FastAPI is declared in requirements.txt and present in the container. Guarded
# so a bare import for the Docker smoke test does not require the web framework.
try:
    from fastapi import FastAPI, Request

    app = FastAPI(title="whatsapp-chat-runtime")

    @app.get("/ping")
    def ping() -> dict:
        """AgentCore Runtime health probe."""
        return {"status": "ok"}

    @app.post("/invocations")
    async def invocations(request: Request) -> dict:
        """AgentCore Runtime invocation endpoint.

        Synchronous request/response: the webhook handler invokes this with the
        multimodal payload and gets back the text reply. (Session retention /
        inactivity reset are layered on in Task 8.)
        """
        payload = await request.json()
        try:
            return run_chat_turn(payload)
        except Exception as exc:  # noqa: BLE001 - never leak a stack trace to the caller
            logger.exception("chat turn failed")
            return {
                "error": "chat_turn_failed",
                "reply": "Sorry, something went wrong on our side. Please try again.",
                "detail": str(exc),
            }

except ImportError:  # pragma: no cover - smoke-test path without web deps
    app = None  # type: ignore[assignment]


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "chat_agent:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
    )
