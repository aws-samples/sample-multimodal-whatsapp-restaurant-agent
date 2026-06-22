"""Shared fixtures - make the chat-agent module importable under pytest when
invoked from the repo root or from the agent/ directory itself.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Put the agent/ directory on sys.path so top-level module imports
# (`import session_store`, `import chat_agent`, etc.) work regardless of cwd.
_AGENT_DIR = Path(__file__).resolve().parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

# Ensure tests never attempt real AWS calls.
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("DEPLOYMENT_PREFIX", "qsr-wa-test")
os.environ.setdefault("PEPPER_PARAM_NAME", "")
os.environ.setdefault("WA_MEMORY_ID", "")

# ---------------------------------------------------------------------------
# Shared Hypothesis profile for the WhatsApp Restaurant AI Host (Feature:
# whatsapp-restaurant-ai-host). Every property-based test in this repo runs a
# MINIMUM of 100 iterations per the project's testing convention. We register a
# named "wa-pbt" profile that pins max_examples=100 and load it by default. CI
# or a developer can override with HYPOTHESIS_PROFILE=<name> to dial iterations
# up (never below 100).
#
# Import-safe even where Hypothesis is not installed (the agent image ships it,
# but a partial dev checkout might not): a missing import is swallowed so
# non-property unit tests still collect.
# ---------------------------------------------------------------------------
try:
    from hypothesis import HealthCheck, settings

    settings.register_profile(
        "wa-pbt",
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "wa-pbt"))
except ImportError:  # pragma: no cover - hypothesis always present in CI/image
    pass
