FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install
RUN npx playwright install --with-deps chromium

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

ENV CGW_STATE_DIR=/data
ENV CGW_HEADLESS=true

VOLUME ["/data"]

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["mcp"]
