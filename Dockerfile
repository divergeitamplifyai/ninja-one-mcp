# syntax=docker/dockerfile:1.7
#
# ninja-one-mcp, remote (Streamable HTTP) image for Azure Container Apps.
#
# Stage 1 builds from source and bundles the server into one file.
# Stage 2 is distroless: no shell, no package manager, runs as non-root.
# Both base images are pinned by digest; Dependabot keeps them current.

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json llms.txt ./
COPY src ./src
COPY scripts/bundle.mjs ./scripts/bundle.mjs
RUN npx tsc && node scripts/bundle.mjs

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
LABEL org.opencontainers.image.title="ninja-one-mcp" \
      org.opencontainers.image.description="MCP server for the NinjaOne RMM Public API v2 (Streamable HTTP)" \
      org.opencontainers.image.source="https://github.com/patrickking67/ninja-one-mcp" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=build /src/plugins/ninjaone/server/ ./
ENV NODE_ENV=production \
    NINJAONE_TRANSPORT=http \
    NINJAONE_HTTP_HOST=0.0.0.0 \
    NINJAONE_HTTP_PORT=8080 \
    NINJAONE_ENV_FILE=none
EXPOSE 8080
USER nonroot
CMD ["ninja-one-mcp.mjs"]
