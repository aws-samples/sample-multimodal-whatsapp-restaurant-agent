FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

RUN pip install --upgrade pip

# System deps. Unlike the telephony reference (where the Node SIP-gateway bridge
# owned all codec conversion), the WhatsApp Call Runtime runs WebRTC INSIDE this
# container, so aiortc + av (PyAV) carry and transcode the media here. What we
# install:
#   gcc/g++/make            - native extension fallbacks for transitive pip deps
#   git                     - mcp-proxy-for-aws installs from a git tag
#   curl, ca-certificates   - used by the Docker HEALTHCHECK below
#   pkg-config              - build-time lib discovery for the media stack
#   ffmpeg + libav* headers - PyAV codec backend (Opus encode/decode for media)
#   libopus0, libvpx-dev    - Opus/VP8 codecs aiortc negotiates
#   libsrtp2-dev            - SRTP keying for the DTLS/SRTP media path
#   libffi-dev, libssl-dev  - cffi / cryptography build fallbacks for aiortc
# aarch64 wheels usually satisfy aiortc/av directly; these are present so a
# from-source fallback still links in the ARM64 CodeBuild image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    git \
    curl \
    ca-certificates \
    pkg-config \
    ffmpeg \
    libopus0 \
    libvpx-dev \
    libsrtp2-dev \
    libffi-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first so the layer caches across source edits.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Copy application source. The Call Runtime invoke surface is handler.py, which
# imports kvs_turn (TURN credentials) and single_shot_answerer (the aiortc
# answerer); sdp_inspect is the SDP analysis helper. The Nova 2 Sonic media path
# (session/telephony_agent/protocol + memory/mcp/prompt) lands in Tasks 18/19 and
# is carried now so the image is complete for that step.
COPY handler.py kvs_turn.py single_shot_answerer.py sdp_inspect.py ./
COPY telephony_agent.py protocol.py session.py pstn_customer.py mcp_tools.py system_prompt.py prompt_renderer.py memory_client.py ./

# Smoke test - fail the build early if the invoke entrypoint's imports are broken.
RUN python -c "import handler"

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
