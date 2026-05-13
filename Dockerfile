# syntax=docker/dockerfile:1.6
# Multi-stage Bun build for the voice-clip server.
# TLS terminates at Cloudflare Tunnel; container always serves plain HTTP.

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# wget for the HEALTHCHECK (smaller than curl, ships in busybox).
# tini optional — bun handles SIGTERM, docker stop is enough.

# Non-root user.
RUN addgroup -S app && adduser -S -G app -h /app app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY web ./web

RUN mkdir -p /data && chown -R app:app /app /data

USER app

ENV PORT=8080 \
    DATA_DIR=/data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:8080/version || exit 1

CMD ["bun", "run", "src/index.ts"]
