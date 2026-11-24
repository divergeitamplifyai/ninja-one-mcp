# syntax=docker/dockerfile:1.7
#
# Remote image for the Azure Container Apps lane (LANES.md, docs/deploy-azure.md).
# Runs the Node HTTP lane, dist/http/main.js: Streamable HTTP on port 8080.
#
# Stage 1 builds from the lockfile. Stage 2 is distroless: no shell, no package
# manager, non-root. Both bases are pinned by digest; Dependabot keeps them current.
#
# The image binds 0.0.0.0 because the container network is the only way in, and
# it sets no auth mode: MCP_HTTP_AUTH must come from the deployment (entra or
# bearer). Without it the server refuses to start rather than listen open.

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev --no-audit --no-fund

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
LABEL org.opencontainers.image.title="ninja-one-mcp" \
      org.opencontainers.image.description="MCP server for the NinjaOne RMM Public API v2 (Streamable HTTP)" \
      org.opencontainers.image.source="https://github.com/divergeitamplifyai/ninja-one-mcp" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=8080
EXPOSE 8080
USER nonroot
CMD ["dist/http/main.js"]
