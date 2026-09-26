# syntax=docker/dockerfile:1
#
# TMedge -- one image, three roles:
#   edge  UDP 5200 (TMnodes), TCP 5210 (access gateways), 5211 (direct nodes, if NODE_PORT=5211), 8090 (debug console)
#   web   8080 (student site)
#   sim   virtual TMnodes for testing (sends to the edge)
#
# Builds on any machine with Docker, for linux/amd64 and linux/arm64:
#   docker build -t tmedge .
#   docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/tmedge:1.0 --push .
# Run with docker compose (see docker-compose.yml and DOCKER.md).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# The student UI is a separate React/Vite project; its dependencies never
# reach the runtime image, only the static files it builds.
COPY web-app/package.json web-app/package-lock.json ./web-app/
RUN npm --prefix web-app ci --no-audit --no-fund
COPY web-app ./web-app
COPY algo-app/package.json algo-app/package-lock.json ./algo-app/
RUN npm --prefix algo-app ci --no-audit --no-fund
COPY algo-app ./algo-app
COPY tsconfig*.json ./
COPY src ./src
COPY test ./test
COPY public-web ./public-web
COPY public-console ./public-console
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-alpine
LABEL org.opencontainers.image.title="TMedge" \
      org.opencontainers.image.description="Thermal occupancy edge, student web tier and debug console"
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/public-web ./public-web
COPY --from=build /src/public-console ./public-console
COPY --from=build /src/public-algo ./public-algo
COPY package.json ./
# Default site layout; mount your own over /app/config to change it.
COPY config ./config
COPY docker/entrypoint.sh /usr/local/bin/tmedge
# Recordings, the user list and learned state live in /data: a volume, owned by
# the unprivileged runtime user so the container never needs root.
RUN chmod 755 /usr/local/bin/tmedge && mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 5200/udp 5210 5211 8080 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["tmedge", "health"]
ENTRYPOINT ["tmedge"]
CMD ["web"]
