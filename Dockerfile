# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci --include=dev
COPY frontend frontend
COPY backend backend
COPY scripts scripts
RUN npm run build

FROM build AS test
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4 && rm -rf /var/lib/apt/lists/*
CMD ["npm", "test"]

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci --omit=dev --workspace @aarohan/backend --include-workspace-root=false && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=5000 NODE_OPTIONS=--max-old-space-size=768
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --from=dependencies --chown=node:node /app/backend ./backend
COPY --from=build --chown=node:node /app/backend/src ./backend/src
COPY --from=build --chown=node:node /app/frontend/dist ./frontend/dist
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node
EXPOSE 5000
HEALTHCHECK --interval=15s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/api/health/ready',{signal:AbortSignal.timeout(9000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "backend/src/server.js"]
