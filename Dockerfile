# syntax=docker/dockerfile:1.7

# ---------- Dependencies ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force

# ---------- Runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini wget \
 && addgroup -S app \
 && adduser  -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .

USER app

ENV NODE_ENV=production \
    PORT=5000

EXPOSE 5000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-5000}/health" || exit 1
