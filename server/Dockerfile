FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl \
  && chmod +x /usr/local/bin/kubectl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY web/package.json web/package.json

RUN npm install --omit=dev

COPY server/ server/
COPY downloads/ /app/downloads/

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "server/src/index.js"]
