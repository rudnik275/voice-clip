# syntax=docker/dockerfile:1.6
# Multi-stage Bun build for the voice-clip server.
# TLS terminates at Cloudflare Tunnel; container always serves plain HTTP.

# Runtime deps only (no dev deps) — what the server needs at boot.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build the Vue SPA with Vite (needs dev deps: vite, vue-tsc, plugin-vue).
# Output is web/dist/ with content-hashed assets, served statically by the
# server at runtime. See docs/adr/0006-frontend-vue-spa-vite.md.
FROM oven/bun:1-alpine AS webbuild
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./web
# The recorder store imports the framework-agnostic capture core (web/src/stores/
# recorder.ts → ../../../core/*), so core/ must be present for `vite build` to
# resolve those imports. (Runtime stage doesn't need it — it serves the bundled
# web/dist/ and src/ has no core/ dependency.)
COPY core ./core
# Root tsconfig.json is required at build time: rolldown-vite's transform plugin
# resolves the nearest tsconfig from /app, and core/tsconfig.json extends
# ../tsconfig.json. Without it the build fails "Tsconfig not found /app/tsconfig.json".
COPY tsconfig.json ./
RUN bun run build:web

FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# Build version = the git tag that triggered the release, passed in from CI as
# `--build-arg APP_VERSION=<tag>` (server-deploy.yml uses github.ref_name). We
# can't `git describe` inside the image — `.git` is in .dockerignore — so the
# tag has to arrive as a build-arg and get frozen into ENV for src/version.ts
# to read at boot. Defaults to 'dev' for a local `docker build` without the arg.
ARG APP_VERSION=dev

# wget for the HEALTHCHECK (smaller than curl, ships in busybox).
# tini optional — bun handles SIGTERM, docker stop is enough.

# Non-root user.
RUN addgroup -S app && adduser -S -G app -h /app app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY web ./web
# Overlay the Vite-built SPA (web/dist/) produced by the webbuild stage.
COPY --from=webbuild /app/web/dist ./web/dist

RUN mkdir -p /data && chown -R app:app /app /data

USER app

ENV PORT=8080 \
    DATA_DIR=/data \
    APP_VERSION=$APP_VERSION
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:8080/version || exit 1

CMD ["bun", "run", "src/index.ts"]
