# syntax=docker/dockerfile:1

# ---- build: bundle the CLI/API and the React UI, then drop dev dependencies ----
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json web/
RUN npm ci --prefix web
COPY . .
RUN npm run build && npm run web:build && npm prune --omit=dev

# ---- runtime: Node + the tools the pipeline shells out to (never to run submission code) ----
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git ffmpeg poppler-utils libreoffice-impress python3 python3-venv \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY config ./config
RUN useradd --create-home --uid 10001 hackeval && mkdir -p /data && chown hackeval /data
USER hackeval
ENV NODE_ENV=production \
    HACKEVAL_CONFIG_DIR=/app/config \
    HACKEVAL_WORKSPACE=/data/workspace \
    HACKEVAL_DB_PATH=/data/hackeval.db
VOLUME /data
EXPOSE 8000
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8000"]
