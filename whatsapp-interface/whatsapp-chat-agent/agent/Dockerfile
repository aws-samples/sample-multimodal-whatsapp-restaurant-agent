# WhatsApp Chat Runtime container image (PLACEHOLDER for Task 7.1).
#
# AgentCore Runtime requires ARM64 OCI images. The CodeBuild project builds
# this with `docker buildx --platform=linux/arm64`.
#
# TODO(Task 7.2): Add the real agent source files (system_prompt.py,
# memory_client.py, mcp_tools.py and any Strands/Bedrock/MCP deps) and replace
# the placeholder entrypoint with the multimodal Nova Pro Converse loop.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

RUN pip install --upgrade pip

# Minimal system deps: curl for the HEALTHCHECK, build tooling for any
# transitive native pip deps the real agent pulls in (Task 7.2), and git (pip
# installs mcp-proxy-for-aws from a git+https URL, which requires git on PATH).
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first so the layer caches across source edits.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Copy application source.
COPY chat_agent.py async_dispatch.py sender_client.py session_store.py system_prompt.py memory_client.py mcp_tools.py ./

# Smoke test - fail the build early if imports are broken.
RUN python -c "import chat_agent"

# Non-root user per AgentCore Runtime best practice.
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/ping || exit 1

# BedrockAgentCoreApp serves /invocations + /ping and starts its own server via
# app.run(); launch the module directly rather than pointing uvicorn at a
# FastAPI instance (async-reply-delivery Move A).
ENTRYPOINT ["python", "chat_agent.py"]
