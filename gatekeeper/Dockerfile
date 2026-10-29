# Proof Gatekeeper agent. Multi-arch: linux/amd64 (GCP e2-micro) and linux/arm64 (Oracle Ampere).
# There are no native modules (snarkjs is pure JS/wasm), so the same build works on both.
# TLS is terminated by Caddy (deploy/). Secrets come from the env at run time, never the image.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY circuits ./circuits
RUN mkdir -p /app/data && chown node:node /app/data
USER node
# Seen-set, response cache and dispute evidence. Must survive restarts and redeploys.
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/src/server.js"]
