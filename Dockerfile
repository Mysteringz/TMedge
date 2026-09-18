# One image, two roles: `web` (EC2 / any container host) or `edge` (the NUC).
#   docker build -t tmedge .
#   docker run -p 8080:8080 --env-file .env -v tmdata:/app/data tmedge web
#   docker run --network host --env-file .env -v tmdata:/app/data tmedge edge
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY test ./test
COPY public-web ./public-web
COPY public-console ./public-console
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public-web ./public-web
COPY --from=build /app/public-console ./public-console
COPY package.json ./
COPY config ./config
USER node
EXPOSE 8080 8090 5200/udp
ENTRYPOINT ["sh", "-c", "exec node dist/src/$0/main.js"]
CMD ["web"]
