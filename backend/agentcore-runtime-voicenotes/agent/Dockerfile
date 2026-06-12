# WhatsApp VoiceNotes Runtime container image (PLACEHOLDER for Task 12.1).
#
# AgentCore Runtime requires ARM64 OCI images. The CodeBuild project builds
# this with `docker buildx --platform=linux/arm64`.
#
# TODO(Tasks 12.2-12.4): Add the real agent source files (ogg_codec.py,
# bounded_sonic.py, the full handler.py, plus memory_client.py / mcp_tools.py /
# system_prompt.py) and the OS-level libopus/ffmpeg deps PyAV needs for the
# Ogg Opus decode/encode.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

RUN pip install --upgrade pip

# System deps: curl for the HEALTHCHECK, build tooling for transitive native
# pip deps. Tasks 12.2-12.4 add ffmpeg/libopus headers (PyAV) here.
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
COPY handler.py ogg_codec.py bounded_sonic.py mcp_tools.py system_prompt.py memory_client.py ./

# Smoke test - fail the build early if imports are broken.
RUN python -c "import handler, ogg_codec, bounded_sonic, mcp_tools, system_prompt, memory_client"

# Non-root user per AgentCore Runtime best practice.
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/ping || exit 1

ENTRYPOINT ["python", "-m", "uvicorn", "handler:app", "--host", "0.0.0.0", "--port", "8080"]
