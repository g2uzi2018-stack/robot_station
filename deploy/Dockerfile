FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages/protocol/package*.json packages/protocol/
COPY apps/server/package*.json apps/server/
RUN npm install
COPY packages packages
COPY apps/server apps/server
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package*.json packages/protocol/
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/server/package*.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY apps/web/public apps/web/public
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]