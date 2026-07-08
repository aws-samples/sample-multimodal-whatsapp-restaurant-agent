# WhatsApp VoiceNotes Runtime container image (TypeScript / Node).
#
# AgentCore Runtime requires ARM64 OCI images; the CodeBuild project builds this
# with `docker buildx --platform=linux/arm64`. The runtime is a bounded raw
# Amazon Nova 2 Sonic speech-to-speech session (TypeScript), replacing the prior
# Python/strands implementation. OGG Opus transcode is done by spawning ffmpeg
# (exact parity with the PyAV path), so ffmpeg is installed in the runtime image.
#
# Multi-stage: a builder stage compiles TypeScript -> dist/, and a slim runtime
# stage carries only production deps + dist + ffmpeg.

# --- builder: install all deps and compile TypeScript -------------------
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim AS builder

WORKDIR /app

# Install deps first so the layer caches across source edits. npm ci needs the
# lockfile and installs devDependencies (typescript) for the build.
COPY package.json package-lock.json ./
RUN npm ci

# Compile src/ -> dist/ (tsconfig excludes *.test.ts).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime: production deps + ffmpeg + compiled output ----------------
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim AS runtime

WORKDIR /app

# ffmpeg (with libopus) for the OGG Opus decode/encode; ca-certificates for TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Production dependencies only (no typescript/tsx).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled JavaScript from the builder stage.
COPY --from=builder /app/dist ./dist

# Non-root user per AgentCore Runtime best practice.
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

# Health check hits /ping using Node's built-in fetch (no curl needed on slim).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The Node host serves /invocations + /ping and starts its own HTTP server.
ENTRYPOINT ["node", "dist/server.js"]
