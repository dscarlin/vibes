FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY web/package.json web/package.json

RUN npm install --omit=dev

COPY web/ web/

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "web/src/index.js"]
