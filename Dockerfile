# syntax=docker/dockerfile:1.6
# Multi-stage Bun build for Synology NAS / generic Linux deployment.
# Server runs plain HTTP on :8080; TLS termination happens at Tailscale Funnel.

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
# Curl for the HEALTHCHECK below; busybox wget would also work but curl is more
# diagnosable when we shell into the container.
RUN apk add --no-cache curl

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY web ./web
COPY daemon ./daemon

ENV PORT=8080 \
    USE_TLS=false \
    DATA_DIR=/data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/version || exit 1

# Bun is the entrypoint — no pm2 inside the container, restart is docker's job.
CMD ["bun", "run", "src/index.ts"]
