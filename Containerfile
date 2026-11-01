# browserctl's runtime: Node.js, Chrome for Testing, Xvfb, x11vnc, and ffmpeg, with fixed browser and session users.
# Every download is pinned and verified by its SHA-256 before use.

ARG DEBIAN_IMAGE=docker.io/library/debian:trixie-slim@sha256:1e1a22175fbf1b32157ddaf0219e1db4e5401fab2b94ed285add64d18587cd2d

FROM ${DEBIAN_IMAGE} AS fetch
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG CHROME_VERSION=156.0.8078.80
ARG CHROME_SHA256=b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl unzip xz-utils >/dev/null \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && mkdir /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 --no-same-owner \
 && rm -rf /opt/node/include /opt/node/share /tmp/node.tar.xz
RUN curl -fsSLo /tmp/chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
 && echo "${CHROME_SHA256}  /tmp/chrome.zip" | sha256sum -c - \
 && unzip -q /tmp/chrome.zip -d /opt && rm /tmp/chrome.zip

FROM ${DEBIAN_IMAGE} AS runtime
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      ca-certificates fonts-liberation fonts-noto-color-emoji libasound2t64 libatk-bridge2.0-0t64 libcairo2 libcups2t64 \
      libdrm2 libgbm1 libgtk-3-0t64 libnss3 libpango-1.0-0 libxcomposite1 libxdamage1 libxkbcommon0 libxrandr2 \
      libxshmfence1 xvfb x11vnc ffmpeg procps tini >/dev/null \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/node /opt/node
COPY --from=fetch /opt/chrome-linux64 /opt/chrome-linux64
RUN ln -s /opt/node/bin/node /usr/local/bin/node && ln -s /opt/node/bin/npm /usr/local/bin/npm \
 && ln -s /opt/chrome-linux64/chrome /usr/local/bin/chrome
# Pair n has the browser user browser<n> (UID 1100+n) and the session user session<n> (UID 1200+n), both in the group
# pair<n> (GID 1300+n); src/sessions/users.ts holds the same numbers.
RUN for n in $(seq 1 32); do \
      groupadd -g $((1300 + n)) pair$n \
   && useradd -u $((1100 + n)) -g $((1300 + n)) -M -d /nonexistent -s /usr/sbin/nologin browser$n \
   && useradd -u $((1200 + n)) -g $((1300 + n)) -M -d /nonexistent -s /usr/sbin/nologin session$n; \
    done
ENV HOME=/root
# The server is not an init: tini reaps the processes that sessions leave behind.
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /app

# Source with every dependency, for the integration tests.
FROM runtime AS test
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund >/dev/null
COPY . .
