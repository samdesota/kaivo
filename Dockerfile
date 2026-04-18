# ---------- build stage ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Build tools needed for native deps (bcrypt, node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund

COPY tsconfig*.json vite.config.ts tsup.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY migrations ./migrations

RUN npm run build

# ---------- runtime stage ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

# docker CLI + tini; the CLI is used by node-pty for interactive shells
# (`docker exec -it <id> bash`) — the daemon itself lives on the host and is
# reached via the mounted /var/run/docker.sock.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    docker.io \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

# Docker group inside the image so the non-root `node` user can read the
# mounted docker socket. The host socket's gid will normally be remapped at
# runtime via the compose `group_add:` entry.
RUN groupadd -f -g 999 docker && usermod -aG docker node
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/index.js"]
