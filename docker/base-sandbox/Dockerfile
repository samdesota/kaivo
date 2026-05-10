FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      openssh-client \
      bash \
      coreutils \
      procps \
      iproute2 \
      python3 \
      python3-pip \
      build-essential \
      gnupg \
      docker.io \
 && rm -rf /var/lib/apt/lists/*

# Node.js via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# OpenCode CLI
ARG OPENCODE_VERSION=1.4.14
RUN npm install -g --omit=dev "opencode-ai@${OPENCODE_VERSION}" \
 && which opencode \
 && opencode --version

# cloud-code OpenCode plugin. Prebuilt by `npm run prepare:sandbox-image`.
COPY plugin/index.js /opt/cloud-code-plugin/index.js

# cc-env binary + its runtime package.json. Prebuilt by
# `npm run prepare:sandbox-image` (runs tsup in packages/env-server and
# stages the artifacts into docker/base-sandbox/cc-env/).
COPY cc-env/main.js /opt/cc-env/main.js
COPY cc-env/migrations /opt/cc-env/migrations
COPY cc-env/package.json /opt/cc-env/package.json

# Install native deps (better-sqlite3, node-pty). Must compile on the
# target platform, so this runs inside the image.
RUN cd /opt/cc-env \
 && npm install --omit=dev --no-audit --no-fund \
 && test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node \
 && test -f node_modules/node-pty/build/Release/pty.node

# Non-root coder user (uid/gid 1000 matches app container + workspace)
RUN groupadd -g 1000 coder \
 && useradd -m -u 1000 -g coder -s /bin/bash coder

RUN mkdir -p /workspace /home/coder/.opencode /home/coder/.config/opencode /var/lib/cc-env \
 && chown -R coder:coder /workspace /home/coder /var/lib/cc-env \
 && chown -R coder:coder /opt/cc-env \
 && chmod -R a+r /opt/cloud-code-plugin

USER coder
WORKDIR /home/coder/.config/opencode

# Pre-install the @opencode-ai/plugin peer dep so `opencode serve` skips its
# background npm install on first boot.
RUN echo '{"dependencies":{"@opencode-ai/plugin":"1.4.14"}}' > package.json \
 && npm install --no-audit --no-fund --omit=dev \
 && ls node_modules/@opencode-ai/plugin/package.json

WORKDIR /workspace

# cc-env is PID 1 inside the container; it reads CC_STATE_DIR/secrets.json
# on boot to adopt the orchestrator-minted envToken + identityToken.
CMD ["node", "/opt/cc-env/main.js"]
