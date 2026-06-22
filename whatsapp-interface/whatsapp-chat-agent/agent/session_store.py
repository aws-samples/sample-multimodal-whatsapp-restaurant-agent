"""In-process conversation session store for the Chat Runtime (Task 8.2).

Implements the runtime-managed session model (R5):
  - retain up to the 50 most recent turns per session (R5.2),
  - start a fresh session after 30 minutes (1800 s) of inactivity (R5.3),
  - keep distinct Customer_Id sessions strictly separate (R5.4),
  - on a context-load failure, proceed with no prior turns and record the
    indication, preserving the session (R5.5).

The session key is the Customer_Id (== session_id, R5.1). The store is in-process
and per-container: this is demo-grade (a warm container retains context; a cold
start or a second instance starts fresh), which the design explicitly accepts
for the sample. The retention/reset DECISIONS are pure functions so they are
unit-testable (Property 5) without any runtime.

Stored history is TEXT-ONLY: image/document content blocks from prior turns are
reduced to a short placeholder so the in-memory store stays bounded. The current
turn still sends full multimodal content to the model; only the retained history
is text-reduced.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

MAX_TURNS = 50          # R5.2
IDLE_RESET_SECONDS = 1800  # 30 min (R5.3)


def should_reset(last_activity_ts: float, now: float, idle_limit: int = IDLE_RESET_SECONDS) -> bool:
    """Pure: a fresh session starts iff the gap since last activity is >= the
    idle limit (R5.3). No prior activity (last_activity_ts <= 0) -> reset."""
    if last_activity_ts <= 0:
        return True
    return (now - last_activity_ts) >= idle_limit


def trim_turns(turns: list, max_keep: int = MAX_TURNS) -> list:
    """Pure: keep only the most recent ``max_keep`` turns (R5.2)."""
    if max_keep <= 0:
        return []
    return turns[-max_keep:]


def to_text_only(message: dict) -> dict | None:
    """Reduce a Converse message to a text-only message for bounded storage.

    - Text blocks are kept.
    - Image / document blocks become a short ``[image]`` / ``[document]`` marker
      so retained history does not carry bytes.
    - ``toolUse`` / ``toolResult`` blocks are DROPPED ENTIRELY (not stored).

    Why drop tool blocks instead of placeholdering them: storing a placeholder
    (the old behavior emitted ``[tool]``) POISONS the retained context. The model
    sees prior assistant turns that are just the placeholder and imitates the
    pattern - it starts emitting the placeholder as a response instead of calling
    a tool, and the loop self-reinforces as more placeholders accumulate. The
    assistant's natural-language answer that FOLLOWS a tool round-trip already
    carries the needed information, so conversational continuity is preserved
    without the tool noise.

    Returns the reduced message, or ``None`` when nothing storable remains (e.g.
    a pure toolUse / toolResult turn) so the caller drops it.
    """
    role = message.get("role", "user")
    out_blocks = []
    for block in message.get("content", []) or []:
        if not isinstance(block, dict):
            continue
        if "text" in block:
            value = block.get("text")
            if isinstance(value, str) and value.strip():
                out_blocks.append({"text": value})
        elif "image" in block:
            out_blocks.append({"text": "[image]"})
        elif "document" in block:
            out_blocks.append({"text": "[document]"})
        # toolUse / toolResult: dropped (see docstring) - never stored.
    if not out_blocks:
        return None
    return {"role": role, "content": out_blocks}


def merge_consecutive_roles(messages: list) -> list:
    """Merge consecutive same-role messages into one (pure).

    Dropping tool turns can leave two assistant (or two user) messages adjacent;
    Converse requires roles to alternate, so merge their content blocks to keep
    the stored history a valid alternating transcript.
    """
    merged: list = []
    for msg in messages:
        if merged and merged[-1].get("role") == msg.get("role"):
            merged[-1]["content"] = list(merged[-1].get("content", [])) + list(
                msg.get("content", [])
            )
        else:
            merged.append({"role": msg.get("role"), "content": list(msg.get("content", []))})
    return merged


@dataclass
class _Session:
    messages: list = field(default_factory=list)
    last_activity_ts: float = 0.0


class InProcessSessionStore:
    """Thread-safe, per-container session store keyed by Customer_Id."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, _Session] = {}

    def load_prior(self, customer_id: str, now: float | None = None) -> list:
        """Return the prior turns for a customer, honoring the inactivity reset.

        Returns [] when the session is new, has been idle past the reset window
        (R5.3), or on any internal error (R5.5 - never raises). Strict isolation:
        only this customer_id's turns are ever returned (R5.4)."""
        now = time.time() if now is None else now
        try:
            with self._lock:
                sess = self._sessions.get(customer_id)
                if sess is None:
                    return []
                if should_reset(sess.last_activity_ts, now):
                    # Idle too long: drop prior turns but keep the session slot.
                    sess.messages = []
                    return []
                return list(sess.messages)
        except Exception:  # noqa: BLE001 - R5.5: proceed with no prior turns
            return []

    def save(self, customer_id: str, messages: list, now: float | None = None) -> None:
        """Persist the updated (text-reduced, trimmed) history for a customer.

        Pipeline: reduce each message to text-only (dropping tool blocks and any
        message left empty), merge consecutive same-role messages, trim to the
        most recent turns, then drop any leading non-user message so the stored
        history begins with a user turn (Converse requires the first message in
        the array to be a user turn).
        """
        now = time.time() if now is None else now
        reduced = [m for m in (to_text_only(msg) for msg in messages) if m is not None]
        reduced = merge_consecutive_roles(reduced)
        reduced = trim_turns(reduced)
        while reduced and reduced[0].get("role") != "user":
            reduced.pop(0)
        with self._lock:
            self._sessions[customer_id] = _Session(messages=reduced, last_activity_ts=now)

    def reset(self, customer_id: str) -> None:
        with self._lock:
            self._sessions.pop(customer_id, None)
