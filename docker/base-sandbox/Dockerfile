FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      bash \
      coreutils \
      procps \
      iproute2 \
      python3 \
      python3-pip \
      build-essential \
      gnupg \
 && rm -rf /var/lib/apt/lists/*

# Node.js via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# OpenCode CLI (phase 4 uses `opencode serve`; installed here so the image is ready).
# The install script is unreliable inside CI builds (`| bash` silently no-ops on
# any 4xx); install via npm so the build fails if the package isn't fetched.
ARG OPENCODE_VERSION=1.4.14
RUN npm install -g --omit=dev "opencode-ai@${OPENCODE_VERSION}" \
 && which opencode \
 && opencode --version

# cloud-code OpenCode plugin. Built in CI (`npm run build` in
# packages/opencode-plugin) and COPY'd into the image. Bundle is dep-free.
COPY plugin/index.js /opt/cloud-code-plugin/index.js

# Non-root coder user (uid/gid 1000 matches app container + workspace)
RUN groupadd -g 1000 coder \
 && useradd -m -u 1000 -g coder -s /bin/bash coder

RUN mkdir -p /workspace /home/coder/.opencode /home/coder/.config/opencode \
 && chown -R coder:coder /workspace /home/coder \
 && chmod -R a+r /opt/cloud-code-plugin

USER coder
WORKDIR /home/coder/.config/opencode

# Pre-install the @opencode-ai/plugin peer dep so `opencode serve` skips its
# background npm install on first boot. Match the version opencode-ai ships
# (same major.minor) so the loader doesn't re-resolve at runtime.
RUN echo '{"dependencies":{"@opencode-ai/plugin":"1.4.14"}}' > package.json \
 && npm install --no-audit --no-fund --omit=dev \
 && ls node_modules/@opencode-ai/plugin/package.json

WORKDIR /workspace

# Idle; the app `docker exec`s into this container for everything.
CMD ["tail", "-f", "/dev/null"]
