# Build stage — install production dependencies only.
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# Runtime stage.
FROM node:20-alpine

# tini reaps zombies and forwards signals, so the SIGTERM handler in server.js
# actually runs — it closes the pg pool and the chat LISTEN connection cleanly.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY app.js server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Source archives produced on Windows carry no Unix permission bits, so the
# copied files can land as mode 000 and become unreadable to the non-root user.
# Normalise to read-only-for-all (directories keep +x so they can be traversed).
RUN chmod -R a+rX /app/src /app/public /app/scripts /app/app.js /app/server.js /app/package.json

# The Firebase service-account JSON is NOT baked into the image; it is mounted
# from a Secret at src/config/ at runtime. Same for .env — all configuration
# arrives as environment variables from the Kubernetes Secret.

# Numeric UID, not the `node` name: Kubernetes' runAsNonRoot check cannot verify
# a non-numeric user and refuses to start the container. `node` is UID 1000 in
# the official images.
USER 1000:1000

# Informational only; the real port comes from the PORT env var.
EXPOSE 5000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
