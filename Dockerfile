# Standalone image: Bun.serve with graceful shutdown and the webhook dispatcher on an interval.
#   docker build -t slotlock .
#   docker run -p 3000:3000 -e DATABASE_URL=… -e APP_SECRET=… slotlock

FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/public ./public
COPY src ./src
COPY drizzle ./drizzle
COPY scripts/migrate.ts ./scripts/migrate.ts
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD bun -e "const r = await fetch('http://localhost:3000/healthz'); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "src/server.ts"]
