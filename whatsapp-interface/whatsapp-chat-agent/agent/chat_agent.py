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

    200 -> { "ok": true, "messages_sent": <n>,
             "unsupported_attachments": [ {"kind":"image","format":"tiff"} ] }

The runtime OWNS delivery (Option C): it streams the turn and sends each
assistant text block (interim narration + final answer) to WhatsApp via the
Sender Lambda as it is produced. The response body is a STATUS only - there is
no `reply` for the webhook worker to relay. Tool-use blocks are never sent, so a
"[tool]" placeholder can never reach the customer.

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

import asyncio
import base64
import logging
import os
import re
from typing import Any, Optional

import mcp_tools
import sender_client
from memory_client import ENV_MEMORY_ID, SharedMemoryClient, Turn
from session_store import InProcessSessionStore
from system_prompt import render_system_prompt

logger = logging.getLogger(__name__)

# --- Logging configuration -------------------------------------------------
# LOG_LEVEL (env, default INFO) drives BOTH our structured per-step logs and
# Strands' own internal logs (model request/response, event-loop cycles, tool
# dispatch). Set LOG_LEVEL=DEBUG on the runtime to capture the deepest detail
# when tracing the agent loop. AgentCore captures stdout/stderr to CloudWatch.
_LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
_root_logger = logging.getLogger()
if not _root_logger.handlers:
    logging.basicConfig(
        level=_LOG_LEVEL,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )
else:
    _root_logger.setLevel(_LOG_LEVEL)
logger.setLevel(_LOG_LEVEL)
# Surface Strands' internal step-by-step logs at the same level so we can see
# the raw model I/O and tool dispatch alongside our own trace lines.
logging.getLogger("strands").setLevel(_LOG_LEVEL)

# Per-container conversation session store (R5.2-R5.5). Demo-grade: a warm
# container retains context; a cold start or a second instance starts fresh.
_SESSIONS = InProcessSessionStore()

# Customer-facing copy sent directly by the runtime (via the Sender Lambda).
# CANT_READ: nothing usable in the inbound message (secondary guard - the
# webhook already gates input). FALLBACK: the turn produced no assistant text
# (an empty/stalled tool round-trip, or an internal error) - we always say
# SOMETHING rather than leave the customer hanging.
CANT_READ_MESSAGE = (
    "Sorry, I could not read your message. Please send text, a photo, or a PDF."
)
FALLBACK_MESSAGE = (
    "Sorry, something went wrong on our side. Please try again."
)

# Chat model via a cross-region inference profile (configurable). Default is
# Amazon Nova 2 Lite - a newer generation than Nova 1 Pro, multimodal
# (text/image/video) and tool-capable via Converse. Override with NOVA_CHAT_MODEL_ID.
NOVA_CHAT_MODEL_ID = os.environ.get(
    "NOVA_CHAT_MODEL_ID",
    os.environ.get("NOVA_PRO_MODEL_ID", "us.amazon.nova-2-lite-v1:0"),
)

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

# Amazon Nova Pro sometimes wraps its chain-of-thought in <thinking>...</thinking>
# tags. That internal reasoning must NEVER reach the customer. We strip well-
# formed blocks, then any stray/unclosed thinking tags, as a hard guarantee
# independent of the system-prompt instruction (R4: customer-facing replies only).
_THINKING_BLOCK = re.compile(r"<\s*thinking\b[^>]*>.*?<\s*/\s*thinking\s*>", re.IGNORECASE | re.DOTALL)
_THINKING_OPEN_TO_END = re.compile(r"<\s*thinking\b[^>]*>.*\Z", re.IGNORECASE | re.DOTALL)
_STRAY_THINKING_TAG = re.compile(r"<\s*/?\s*thinking\b[^>]*>", re.IGNORECASE)


def strip_internal_reasoning(text: str) -> str:
    """Remove any <thinking> reasoning the model may have leaked (pure, testable).

    1. Drop complete <thinking>...</thinking> blocks (any case, across newlines).
    2. Drop a dangling <thinking> with no close (to end of text) - otherwise an
       unterminated tag would leak the whole reasoning tail.
    3. Drop any leftover stray thinking tags.
    Collapses the blank lines a removed block leaves behind.

    ASSUMPTION (revisit after testing): a reply is never made up of ONLY a
    <thinking> block, so the stripped result is never empty. If that turns out to
    be false in the field, add a safe fallback message here instead of returning
    an empty string.
    """
    if not text:
        return text
    cleaned = _THINKING_BLOCK.sub("", text)
    cleaned = _THINKING_OPEN_TO_END.sub("", cleaned)
    cleaned = _STRAY_THINKING_TAG.sub("", cleaned)
    # Tidy up whitespace left where the block was.
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def extract_assistant_text(content: Any) -> str:
    """Join the TEXT blocks of an assistant message's content (pure, testable).

    Converse assistant messages are a list of content blocks. We keep only
    ``{"text": ...}`` blocks and concatenate them; ``toolUse`` (and any other)
    blocks are dropped. This is what guarantees a tool-use block can NEVER reach
    the customer as a literal "[tool]" - we never stringify the whole message,
    we extract its text. Non-list / malformed content yields "".
    """
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict):
            value = block.get("text")
            if isinstance(value, str):
                parts.append(value)
    return "".join(parts)


def _summarize_block(block: Any) -> str:
    """One-line, log-safe summary of a Converse content block (for tracing).

    Shows the block KIND and a bounded preview so the agent loop can be read
    step by step in CloudWatch without dumping image/document bytes.
    """
    if not isinstance(block, dict):
        return f"<{type(block).__name__}>"
    if "text" in block:
        t = block.get("text") or ""
        return f"text[{len(t)}]={t[:300]!r}"
    if "toolUse" in block:
        tu = block.get("toolUse") or {}
        return (
            f"toolUse(name={tu.get('name')!r}, id={tu.get('toolUseId')!r}, "
            f"input={tu.get('input')!r})"
        )
    if "toolResult" in block:
        tr = block.get("toolResult") or {}
        return (
            f"toolResult(status={tr.get('status')!r}, "
            f"content={str(tr.get('content'))[:300]!r})"
        )
    if "image" in block:
        return "image(<bytes>)"
    if "document" in block:
        return "document(<bytes>)"
    return f"keys={list(block.keys())}"


# A degenerate tool-call placeholder the model can emit as LITERAL TEXT (e.g.
# "[tool]") - historically caused by poisoned context (see session_store). It
# must NEVER be delivered to a customer, so the send path detects and drops it
# as a belt-and-suspenders guard independent of the session-store fix.
_TOOL_PLACEHOLDER = re.compile(
    r"^\s*\[\s*tool(?:[\s_-]*(?:use|call|s))?\s*\]\s*$", re.IGNORECASE
)


def _is_tool_placeholder(text: str) -> bool:
    """True iff ``text`` is just a bare tool-call placeholder like "[tool]"."""
    return bool(text) and bool(_TOOL_PLACEHOLDER.match(text))


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


# Sender callable signature: (customer_id, text, channel) -> awaitable[bool].
# Injectable so the turn orchestration is unit-testable without AWS/strands.
SendFn = Any


async def _default_send(customer_id: str, text: str, channel: str = "chat") -> bool:
    """Deliver one message via the Sender Lambda, off the event-loop thread."""
    return await asyncio.to_thread(sender_client.send_message, customer_id, text, channel)


async def _process_stream(
    event_stream: Any,
    customer_id: str,
    channel: str,
    send: SendFn,
) -> tuple[list[str], str]:
    """Consume a Strands ``stream_async`` event stream, sending each completed
    ASSISTANT message's text as its own WhatsApp message (pure-with-injection,
    testable with a fake event stream + fake ``send``).

    Strands emits a ``message`` event whenever a message is created. We act ONLY
    on assistant messages, extract their TEXT blocks (never tool-use), strip any
    leaked <thinking>, and send non-empty text in order - so the interim "let me
    pull the menu" turn and the final answer each arrive as separate messages,
    and a tool-use block can never surface as a literal "[tool]". Returns
    (sent_texts, stop_reason).
    """
    sent: list[str] = []
    stop_reason = ""
    seen_tool_ids: set = set()
    turn_text_chars = 0
    msg_index = 0
    logger.info("[loop] stream START customer=%s", customer_id)
    async for event in event_stream:
        if not isinstance(event, dict):
            continue
        # Incremental tool-use signal: log the first time each tool call appears
        # in the stream (before the model message that carries the toolUse block).
        ctu = event.get("current_tool_use")
        if isinstance(ctu, dict):
            tid = ctu.get("toolUseId")
            name = ctu.get("name")
            if name and tid and tid not in seen_tool_ids:
                seen_tool_ids.add(tid)
                logger.info("[loop] tool_use START name=%s id=%s", name, tid)
        # Visible-text token accounting (the model's streamed answer text for
        # the current turn) - lets us compare streamed text vs message content.
        data = event.get("data")
        if isinstance(data, str):
            turn_text_chars += len(data)
        # A completed message marks a turn boundary (assistant turn OR a tool
        # result turn). Log every one with its block breakdown.
        msg = event.get("message")
        if isinstance(msg, dict):
            msg_index += 1
            role = msg.get("role")
            content = msg.get("content", []) or []
            logger.info(
                "[loop] message #%d role=%s streamed_text_chars=%d blocks=[%s]",
                msg_index,
                role,
                turn_text_chars,
                " | ".join(_summarize_block(b) for b in content),
            )
            turn_text_chars = 0
            if role == "assistant":
                text = strip_internal_reasoning(extract_assistant_text(content))
                if text and text.strip() and not _is_tool_placeholder(text):
                    logger.info(
                        "[loop] SEND #%d (%d chars) customer=%s text=%r",
                        len(sent) + 1, len(text), customer_id, text[:300],
                    )
                    ok = await send(customer_id, text, channel)
                    logger.info("[loop] SEND #%d delivered ok=%s", len(sent) + 1, ok)
                    sent.append(text)
                elif _is_tool_placeholder(text):
                    logger.warning(
                        "[loop] DROPPED tool-placeholder assistant text=%r (NOT delivered)", text
                    )
                else:
                    logger.info(
                        "[loop] assistant message #%d had no sendable text (skipped)",
                        msg_index,
                    )
        result = event.get("result")
        if result is not None:
            stop_reason = str(getattr(result, "stop_reason", "") or "")
            logger.info("[loop] RESULT stop_reason=%s sent_count=%d", stop_reason, len(sent))
            # Safety net: if the final answer was somehow NOT emitted as a
            # `message` event, recover it from the result (dedup by text so the
            # same content is never sent twice).
            final = strip_internal_reasoning(
                extract_assistant_text(getattr(result, "message", {}).get("content", []))
            )
            if final and final.strip() and not _is_tool_placeholder(final) and final not in sent:
                logger.info(
                    "[loop] SEND (safety-net final) (%d chars) text=%r", len(final), final[:300]
                )
                ok = await send(customer_id, final, channel)
                logger.info("[loop] SEND (safety-net) delivered ok=%s", ok)
                sent.append(final)
    logger.info(
        "[loop] stream END customer=%s sent_count=%d stop_reason=%s",
        customer_id, len(sent), stop_reason,
    )
    return sent, stop_reason


async def run_chat_turn(payload: dict, send: Optional[SendFn] = None) -> dict:
    """Run one multimodal chat turn end to end (Option C: the runtime SENDS).

    Reads shared memory, builds the Nova agent with gateway MCP tools, streams
    the turn, and sends each assistant text block to WhatsApp via the Sender
    Lambda as it is produced (interim narration + final answer). Writes the turns
    to shared memory and returns a STATUS - there is no `reply` for the worker to
    relay anymore; the runtime owns delivery. ``send`` is injectable for tests.
    """
    sender: SendFn = send or _default_send
    customer_id = (payload.get("customer_id") or payload.get("session_id") or "").strip()
    if not customer_id:
        return {"ok": False, "error": "missing_customer_id", "messages_sent": 0}

    blocks, unsupported = build_content_blocks(payload)
    if not blocks:
        # Nothing usable to send to the model (the webhook already gates input;
        # this is a secondary guard). Tell the customer directly.
        await sender(customer_id, CANT_READ_MESSAGE, "chat")
        result = {"ok": True, "messages_sent": 1}
        if unsupported:
            result["unsupported_attachments"] = unsupported
        return result

    # --- session start: read shared long-term memory (graceful on failure) ---
    memory = SharedMemoryClient(memory_id=_resolve_memory_id())
    read = memory.read_long_term(customer_id)
    if not read.ok:
        logger.info("proceeding with no prior insights for %s (%s)", customer_id, read.error)

    system_prompt = render_system_prompt(read.insights)

    # --- session retention: load prior turns (honors the inactivity reset) ---
    # R5.2-R5.5: strict per-customer isolation, bounded turns, fresh after idle,
    # and never fail on a load error (proceed with no prior turns).
    prior_messages = _SESSIONS.load_prior(customer_id)

    logger.info(
        "[turn] start customer=%s model=%s blocks=%d insights=%d prior_msgs=%d sys_prompt_chars=%d",
        customer_id,
        NOVA_CHAT_MODEL_ID,
        len(blocks),
        len(read.insights or []),
        len(prior_messages or []),
        len(system_prompt),
    )

    # --- stream the turn, sending each assistant text block as it lands -------
    sent_texts, updated_messages, stop_reason = await _stream_turn(
        customer_id, system_prompt, blocks, prior_messages, sender
    )

    # Persist the updated history (text-reduced + trimmed).
    if updated_messages is not None:
        _SESSIONS.save(customer_id, updated_messages)

    # Graceful degradation: the turn produced no assistant text (an empty or
    # stalled tool round-trip). Never leave the customer hanging.
    if not sent_texts:
        logger.warning(
            "chat turn for %s produced no assistant text (stop_reason=%s); sending fallback",
            customer_id,
            stop_reason,
        )
        await sender(customer_id, FALLBACK_MESSAGE, "chat")
        sent_texts = [FALLBACK_MESSAGE]

    # --- session end: write the turns to shared memory (graceful on failure) --
    memory.write_events(
        customer_id,
        customer_id,  # session_id == customer_id (R5.1)
        [
            Turn(role="USER", text=_summarize_user_turn(payload, unsupported)),
            Turn(role="ASSISTANT", text="\n\n".join(sent_texts)),
        ],
    )

    result = {"ok": True, "messages_sent": len(sent_texts)}
    if unsupported:
        result["unsupported_attachments"] = unsupported
    logger.info(
        "[turn] done customer=%s messages_sent=%d stop_reason=%s unsupported=%d",
        customer_id, len(sent_texts), stop_reason, len(unsupported),
    )
    return result


async def _stream_turn(
    customer_id: str,
    system_prompt: str,
    content_blocks: list,
    prior_messages: Optional[list],
    send: SendFn,
) -> tuple[list[str], Optional[list], str]:
    """Construct the Nova Strands Agent with gateway tools and STREAM one turn,
    delivering each assistant text block via ``send``. Returns
    (sent_texts, updated_messages, stop_reason).

    All heavy imports (strands, the MCP client) are local so this module imports
    without them. customerId is stripped from the tool schemas and injected by
    the hook so the model can never set it (R4.6). ``callback_handler=None``
    silences the default stdout printer (which previously dumped half-rendered
    turns, including "[tool]", into CloudWatch).
    """
    from strands import Agent
    from strands.models import BedrockModel
    from strands.tools.mcp.mcp_client import MCPClient

    model = BedrockModel(
        model_id=NOVA_CHAT_MODEL_ID, region_name=os.environ.get("AWS_REGION", "us-east-1")
    )

    with MCPClient(mcp_tools.for_customer(customer_id)) as client:
        tools = client.list_tools_sync()
        tools = mcp_tools.apply_basepath_workaround(tools)
        tools = mcp_tools.strip_customer_id_from_schemas(tools)
        # Nova (Converse) rejects hyphenated tool names with "Model produced
        # invalid sequence as part of ToolUse"; rename them hyphen-free for the
        # model while the gateway call keeps the original name (R4.7).
        tools = mcp_tools.sanitize_tool_names(tools)

        agent = Agent(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
            messages=list(prior_messages) if prior_messages else None,
            hooks=[mcp_tools.customer_id_hook(customer_id)],
            callback_handler=None,
        )
        sent_texts, stop_reason = await _process_stream(
            agent.stream_async(content_blocks), customer_id, "chat", send
        )
        updated = getattr(agent, "messages", None)
        return sent_texts, updated, stop_reason


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

        The runtime now OWNS delivery (Option C): it streams the turn and sends
        each assistant message to WhatsApp via the Sender Lambda as it lands. The
        response body is a STATUS for the worker (no `reply` to relay). On an
        internal error we still try to tell the customer something went wrong, so
        the worker only needs to cover a transport-level invoke failure.
        """
        payload = await request.json()
        try:
            return await run_chat_turn(payload)
        except Exception as exc:  # noqa: BLE001 - never leak a stack trace to the caller
            logger.exception("chat turn failed")
            try:
                cid = (payload.get("customer_id") or payload.get("session_id") or "").strip()
                if cid:
                    await _default_send(cid, FALLBACK_MESSAGE, "chat")
            except Exception:  # noqa: BLE001 - best-effort fallback notify
                logger.exception("failed to send the error fallback for the chat turn")
            return {"ok": False, "error": "chat_turn_failed", "detail": str(exc)}

except ImportError:  # pragma: no cover - smoke-test path without web deps
    app = None  # type: ignore[assignment]


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "chat_agent:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
    )
