FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun build --target=bun --production --outdir=dist src/index.ts

FROM oven/bun:1-slim
# The bundle's asset manifest resolves relative to the working directory.
WORKDIR /app/dist
COPY --from=build /app/dist .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health'); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "index.js"]
