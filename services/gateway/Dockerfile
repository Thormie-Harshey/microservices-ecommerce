# ---- Stage 1: deps (installs production packages) ----
FROM node:24.21.0-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: dev (hot reload and debugging, used by docker-compose.override.yml) ----
FROM node:24.21.0-alpine3.24 AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
RUN chown node:node /app
COPY --chown=node:node . .
USER node
CMD ["node", "--watch", "--inspect=0.0.0.0:9229", "index.js"]

# ---- Stage 3: runtime (hardened production image, built by default) ----
FROM node:24.21.0-alpine3.24 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Remove package managers (not needed to run the app) and create a non-root user
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
      /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && addgroup -S -g 1001 appgroup \
 && adduser -S -u 1001 -G appgroup appuser

# Files are owned by root, so appuser can read them but not change them
COPY --from=deps /app/node_modules ./node_modules
COPY package.json index.js ./

USER appuser

# Shell form, so $PORT is swapped for its real value
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

# Exec form, so Node is PID 1 and receives SIGTERM
CMD ["node", "index.js"]
