# Testing conventions - WhatsApp Restaurant AI Host 

This repo uses two property-based-testing (PBT) libraries, split by language:

- **Python** (Lambda handlers, the three modality-specific runtimes, the shared
  memory client, transcode/answerer logic) uses **Hypothesis**.
- **TypeScript** (Cloud Development Kit, CDK, synth-guard logic) uses
  **fast-check**.

Every feature ships both unit tests (specific examples and edge cases) and, where
the design defines a numbered correctness property, exactly one property-based
test. The two kinds are complementary and both are required.

## Non-negotiable rules

1. **Minimum 100 iterations per property test.** Each property runs at least 100
   generated examples. More is fine; fewer is not.
2. **Exactly one PBT per numbered property.** Each design property (Property 1,
   Property 2, ...) is covered by one and only one property-based test. Do not
   split a property across several tests, and do not fold several properties into
   one test.
3. **Never hand-roll PBT.** Use Hypothesis (Python) or fast-check (TypeScript).
   Do not write your own random-input loop.
4. **Tag every property test.** The first line of the test body (or an adjacent
   comment) carries the exact tag:

   ```
   Feature: whatsapp-restaurant-ai-host, Property {n}: {text}
   ```

   where `{n}` is the design property number and `{text}` is the property's short
   name from the design document. Example:

   ```
   Feature: whatsapp-restaurant-ai-host, Property 1: Webhook verification handler decision
   ```

5. **Link the requirement(s).** Property tests also carry a
   `**Validates: Requirements X.Y, ...**` line, matching the task that introduces
   them.
6. **No mocks to force a pass.** Tests validate real logic. Mocking is limited to
   external boundaries (AWS APIs, Meta endpoints) that cannot run locally; never
   mock the unit under test.

## Python (Hypothesis)

### Where tests live

Python test suites live under a `tests/` directory next to the code they cover:

- `backend/agentcore-runtime-voice-webrtc/agent/tests/` (exists; carried over)
- `backend/agentcore-runtime-voicenotes/agent/tests/` (later task)
- `whatsapp-interface/whatsapp-chat-agent/agent/tests/` (later task)
- `whatsapp-interface/whatsapp-webhook/lambda/.../tests/` (later task)
- the shared `memory_client` module's tests (later task)

### The 100-iteration profile

Hypothesis iteration count is set with a registered settings profile, not
per-test `@settings`. The reference implementation is in
`backend/agentcore-runtime-voice-webrtc/agent/tests/conftest.py`:

```python
from hypothesis import HealthCheck, settings

settings.register_profile(
    "wa-pbt",
    max_examples=100,      # project minimum - never lower
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "wa-pbt"))
```

Every new Python test directory copies this `conftest.py` profile block (or
imports it) so all property tests inherit the >=100-iteration floor. To run
more examples locally, set `HYPOTHESIS_PROFILE` to a profile that registers a
higher `max_examples`; do not register one below 100.

### Dependencies

Hypothesis is declared in each agent's `requirements.txt` test-deps block (see
`backend/agentcore-runtime-voice-webrtc/agent/requirements.txt`, which pins
`hypothesis>=6.100` alongside `pytest`/`pytest-asyncio`). New Python modules
add the same test deps. `pyproject.toml` carries the pytest config
(`[tool.pytest.ini_options]`) and registers the `property` marker.

### Example test skeleton

```python
import pytest
from hypothesis import given, strategies as st

@pytest.mark.property
@given(st.text())
def test_property_1_webhook_verification_handler_decision(s):
    # Feature: whatsapp-restaurant-ai-host, Property 1: Webhook verification handler decision
    # **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
    ...
```

## TypeScript (fast-check)

### Where tests live

CDK synth-guard property tests live in each CDK app's `test/` directory
alongside the existing jest suites. The carried-over modules already use jest:

- `backend/network/test/` (reference; `fast-check` added to its `devDependencies`)
- `backend/backend-infrastructure/test/`
- `backend/agentcore-gateway/cdk/test/`
- the new memory / runtime / webhook CDK apps (later tasks)

### Dependencies

fast-check is a `devDependency` of every CDK app that holds synth-guard property
tests, mirroring the jest setup already present. The reference pattern is
`backend/network/package.json`, which now lists `"fast-check": "^3"` next to
`jest`/`ts-jest`. New CDK apps copy the same devDeps.

### Iteration count

fast-check runs >=100 runs per property via `fc.assert(..., { numRuns: 100 })`
(or higher). Do not lower `numRuns` below 100.

### Example test skeleton

```ts
import * as fc from "fast-check";

test("Property 22: certificate-free invariant", () => {
  // Feature: whatsapp-restaurant-ai-host, Property 22: Certificate-free invariant
  // **Validates: Requirements 9.1, 16.7**
  fc.assert(
    fc.property(fc.string(), (prefix) => {
      // synth the stack with the generated prefix and assert no resource
      // requires a user-provided ACM certificate ARN or custom domain.
    }),
    { numRuns: 100 },
  );
});
```

## Running the suites

- Python: from an agent/module dir, `pytest` (the local `conftest.py` loads the
  `wa-pbt` profile automatically). Property tests are also selectable with
  `pytest -m property`.
- TypeScript: from a CDK app dir, `npm test` (jest runs both unit and
  fast-check property suites).

> Deploy/cleanup scripts and AWS calls are out of scope for the test harness.
> `npm install` / `pip install` are run by the developer or by CodeBuild at
> deploy time, not by the test convention itself.
