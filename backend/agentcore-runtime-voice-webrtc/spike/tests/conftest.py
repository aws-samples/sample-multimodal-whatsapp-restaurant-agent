"""Make the spike modules importable under pytest from any cwd."""
from __future__ import annotations

import os
import sys
from pathlib import Path

_SPIKE_DIR = Path(__file__).resolve().parent.parent
if str(_SPIKE_DIR) not in sys.path:
    sys.path.insert(0, str(_SPIKE_DIR))

try:
    from hypothesis import HealthCheck, settings

    settings.register_profile(
        "wa-pbt",
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "wa-pbt"))
except ImportError:  # pragma: no cover
    pass
