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
ARG OPENCODE_VERSION=
RUN npm install -g --omit=dev "opencode-ai${OPENCODE_VERSION:+@}${OPENCODE_VERSION}" \
 && which opencode \
 && opencode --version

# Non-root coder user (uid/gid 1000 matches app container + workspace)
RUN groupadd -g 1000 coder \
 && useradd -m -u 1000 -g coder -s /bin/bash coder

RUN mkdir -p /workspace /home/coder/.opencode \
 && chown -R coder:coder /workspace /home/coder

USER coder
WORKDIR /workspace

# Idle; the app `docker exec`s into this container for everything.
CMD ["tail", "-f", "/dev/null"]
