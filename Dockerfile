FROM node:22-alpine AS builder

WORKDIR /build

# Copy workspace manifests first for better layer caching
COPY package.json package-lock.json ./
COPY packages/mcp/package.json ./packages/mcp/

RUN npm ci

# Copy source and build
COPY tsconfig.base.json vite.config.base.ts vitest.config.ts ./
COPY packages/mcp ./packages/mcp/

RUN npm run build -w @ikko-dev/shopify-mcp

# ---- Runtime image ----
FROM node:22-alpine

WORKDIR /app

# Copy built artefacts + production deps manifest
COPY --from=builder /build/packages/mcp/dist ./dist
COPY --from=builder /build/packages/mcp/package.json ./

# Install only production dependencies (MCP SDK + h3).
# @shopify/dev-mcp is a peer dep — install it here so npx doesn't need network
# access at runtime (recommended for production):
RUN npm install --omit=dev && \
    npm install @shopify/dev-mcp

ENV PORT=3000
ENV HOST=0.0.0.0
# Override the default npx invocation to use the pre-installed binary:
ENV SHOPIFY_MCP_COMMAND=node
ENV SHOPIFY_MCP_ARGS='["node_modules/@shopify/dev-mcp/dist/index.js"]'

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
