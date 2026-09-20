FROM node:24.21.0-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/artifacts/package.json packages/artifacts/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/context/package.json packages/context/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/workflow/package.json packages/workflow/package.json
COPY packages/execution/package.json packages/execution/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/sync/package.json packages/sync/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY packages/artifacts packages/artifacts
COPY packages/auth packages/auth
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/context packages/context
COPY packages/tools packages/tools
COPY packages/workflow packages/workflow
COPY packages/execution packages/execution
COPY packages/database packages/database
COPY packages/documents packages/documents
COPY packages/shared packages/shared
COPY packages/storage packages/storage
COPY packages/sync packages/sync
RUN npm run build -w @uw/contracts \
  && npm run build -w @uw/shared \
  && npm run build -w @uw/storage \
  && npm run build -w @uw/auth \
  && npm run build -w @uw/core \
  && npm run build -w @uw/context \
  && npm run build -w @uw/tools \
  && npm run build -w @uw/workflow \
  && npm run build -w @uw/execution \
  && npm run build -w @uw/documents \
  && npm run build -w @uw/artifacts \
  && npm run build -w @uw/sync \
  && npm run build -w @uw/database \
  && npm run build -w @uw/server \
  && npm prune --omit=dev

FROM node:24.21.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/artifacts/package.json ./packages/artifacts/package.json
COPY --from=build /app/packages/artifacts/dist ./packages/artifacts/dist
COPY --from=build /app/packages/auth/package.json ./packages/auth/package.json
COPY --from=build /app/packages/auth/dist ./packages/auth/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/context/package.json ./packages/context/package.json
COPY --from=build /app/packages/context/dist ./packages/context/dist
COPY --from=build /app/packages/tools/package.json ./packages/tools/package.json
COPY --from=build /app/packages/tools/dist ./packages/tools/dist
COPY --from=build /app/packages/workflow/package.json ./packages/workflow/package.json
COPY --from=build /app/packages/workflow/dist ./packages/workflow/dist
COPY --from=build /app/packages/execution/package.json ./packages/execution/package.json
COPY --from=build /app/packages/execution/dist ./packages/execution/dist
COPY --from=build /app/packages/database/package.json ./packages/database/package.json
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/drizzle ./packages/database/drizzle
COPY --from=build /app/packages/documents/package.json ./packages/documents/package.json
COPY --from=build /app/packages/documents/dist ./packages/documents/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/storage/package.json ./packages/storage/package.json
COPY --from=build /app/packages/storage/dist ./packages/storage/dist
COPY --from=build /app/packages/sync/package.json ./packages/sync/package.json
COPY --from=build /app/packages/sync/dist ./packages/sync/dist

RUN mkdir -p /app/data/artifacts && chown -R node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
