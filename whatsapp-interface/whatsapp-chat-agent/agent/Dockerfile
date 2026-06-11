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
# transitive native pip deps the real agent pulls in (Task 7.2).
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first so the layer caches across source edits.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Copy application source.
COPY chat_agent.py system_prompt.py memory_client.py mcp_tools.py ./

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

ENTRYPOINT ["python", "-m", "uvicorn", "chat_agent:app", "--host", "0.0.0.0", "--port", "8080"]
