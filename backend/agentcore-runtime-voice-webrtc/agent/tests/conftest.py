"""Shared fixtures — make the agent module importable under `pytest` when
invoked from the repo root or from the agent/ directory itself.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Put the agent/ directory on sys.path so top-level module imports
# (`import telephony_agent`, `import session`, etc.) work regardless of cwd.
_AGENT_DIR = Path(__file__).resolve().parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

# Ensure tests never attempt real AWS calls.
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("DEPLOYMENT_PREFIX", "qsr-tel-test")
# Empty pepper — pstn_customer.derive(raw, b"") still satisfies R8 determinism
# (two calls with the same raw + same empty pepper produce the same digest).
os.environ.setdefault("CUSTOMER_ID_PEPPER_PARAMETER_NAME", "")

# ---------------------------------------------------------------------------
# Shared Hypothesis profile for the WhatsApp Restaurant AI Host (Feature:
# whatsapp-restaurant-ai-host). Every property-based test in this repo runs a
# MINIMUM of 100 iterations per the project's testing convention (see the
# repo-root TESTING.md). We register a named "wa-pbt" profile that pins
# max_examples=100 and load it by default. CI or a developer can override with
# HYPOTHESIS_PROFILE=<name> to dial iterations up (never below 100).
#
# This block is import-safe even where Hypothesis is not installed (the agent
# image ships it, but a partial dev checkout might not): a missing import is
# swallowed so non-property unit tests still collect.
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
