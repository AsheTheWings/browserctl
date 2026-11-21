# browserctl's runtime: Node.js, Chrome Stable, Xvfb, x11vnc, and ffmpeg, with fixed browser and session users.
# Every download is pinned and verified by its SHA-256 before use.

ARG DEBIAN_IMAGE=docker.io/library/debian:trixie-slim@sha256:1e1a22175fbf1b32157ddaf0219e1db4e5401fab2b94ed285add64d18587cd2d

FROM ${DEBIAN_IMAGE} AS fetch
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG CHROME_VERSION=158.0.8127.36-1
ARG CHROME_SHA256=4696bce00b128f385a870ba2eb6eede61698f22374ea0d8e09af8a1c6543d397
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils >/dev/null \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && mkdir /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 --no-same-owner \
 && rm -rf /opt/node/include /opt/node/share /tmp/node.tar.xz
RUN curl -fsSLo /tmp/google-chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
 && echo "${CHROME_SHA256}  /tmp/google-chrome.deb" | sha256sum -c -

FROM ${DEBIAN_IMAGE} AS runtime
RUN --mount=type=bind,from=fetch,source=/tmp/google-chrome.deb,target=/tmp/google-chrome.deb,ro \
    printf '%s\n' 'repo_add_once="false"' 'repo_reenable_on_distupgrade="false"' > /etc/default/google-chrome \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      /tmp/google-chrome.deb ca-certificates fonts-noto-color-emoji libxshmfence1 xvfb x11vnc ffmpeg procps tini >/dev/null \
 && test ! -e /etc/apt/sources.list.d/google-chrome.list \
 && test ! -e /etc/apt/sources.list.d/google-chrome.sources \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/node /opt/node
RUN ln -s /opt/node/bin/node /usr/local/bin/node && ln -s /opt/node/bin/npm /usr/local/bin/npm \
 && ln -s /usr/bin/google-chrome-stable /usr/local/bin/chrome
# ffmpeg encodes recordings as the recorder user (UID and GID 1090); src/recordings/recorder.ts holds the same number.
RUN groupadd -g 1090 recorder && useradd -u 1090 -g 1090 -M -d /nonexistent -s /usr/sbin/nologin recorder
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

FROM runtime AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier >/dev/null

FROM dependencies AS dashboard
COPY dashboard ./dashboard
COPY src/profiles/note-limits.ts ./src/profiles/note-limits.ts
COPY tsconfig.json ./
RUN npm run build:dashboard

# Source with every dependency, for the integration tests.
FROM dependencies AS test
# A user outside the session pool, for the provider browser integration tests stand up.
RUN groupadd -g 1099 provider-browser && useradd -u 1099 -g 1099 -M -d /nonexistent -s /usr/sbin/nologin provider-browser
COPY . .
COPY --from=dashboard /app/src/dashboard/static/assets ./src/dashboard/static/assets

# The published image: the server, its dashboard files, and the runtime dependencies, stamped with the build.
FROM runtime AS image
ARG VERSION=0.0.0
ARG COMMIT=unknown
# Defaults for both directory inputs stay traversable by the browser and session users, and the work directory stays
# under Chrome's 43-byte limit for its singleton socket.
ENV XDG_STATE_HOME=/var/lib/browserctl/state XDG_CACHE_HOME=/var/lib/browserctl/cache
RUN mkdir -p /var/lib/browserctl && chmod 755 /var/lib/browserctl
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund --no-update-notifier >/dev/null
COPY bin ./bin
COPY src ./src
COPY --from=dashboard /app/src/dashboard/static/assets ./src/dashboard/static/assets
COPY config ./config
COPY docs ./docs
RUN printf '{"version":"%s","revision":"%s"}\n' "$VERSION" "$COMMIT" > build-info.json
LABEL org.opencontainers.image.title="browserctl" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$COMMIT" \
      org.opencontainers.image.source="https://github.com/AsheTheWings/browserctl"
CMD ["node", "bin/browserctl.ts", "serve"]
