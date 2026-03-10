FROM martizih/kaniko:latest AS kaniko
FROM node:20-bookworm-slim

WORKDIR /app
RUN mkdir -p /app/infra/k8s

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl awscli coreutils busybox \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY web/package.json web/package.json

RUN npm install --omit=dev \
  && npm i -g @openai/codex

COPY worker/ worker/
COPY infra/k8s/deploy.sh /app/infra/k8s/deploy.sh
COPY infra/k8s/delete.sh /app/infra/k8s/delete.sh
COPY infra/k8s/*.yaml /app/infra/k8s/

RUN chmod +x /app/infra/k8s/deploy.sh /app/infra/k8s/delete.sh

COPY --from=kaniko /kaniko/executor /usr/local/bin/kaniko
RUN curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.30.4/bin/linux/amd64/kubectl" \
  && chmod +x /usr/local/bin/kubectl

# Ensure a predictable shell path for exec in minimal runtimes.
RUN mkdir -p /bin /usr/bin \
  && ln -sf /bin/busybox /bin/sh \
  && ln -sf /bin/busybox /bin/ls \
  && ln -sf /bin/busybox /bin/dirname \
  && ln -sf /bin/busybox /usr/bin/env

ENV NODE_ENV=production

CMD ["node", "/app/worker/src/index.js"]
