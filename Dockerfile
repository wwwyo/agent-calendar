FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV NODE_ENV=production
USER bun
CMD ["bun", "run", "src/server.ts"]
