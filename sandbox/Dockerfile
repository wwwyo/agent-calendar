# Cloud Run Job「agent-sandbox」の image。依存は入れず、Bun と sandbox/*.ts だけを持つ
# build context は sandbox/（deploy.sh が `gcloud run jobs deploy --source sandbox` で渡す）
FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY contract.ts entrypoint.ts gemini.ts ./
USER bun
CMD ["bun", "run", "/app/entrypoint.ts"]
