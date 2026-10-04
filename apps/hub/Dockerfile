FROM node:24.13.1-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/hub/package.json apps/hub/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @t3tools/hub...
COPY apps/hub/src apps/hub/src
COPY packages/contracts/src packages/contracts/src
ENV HUB_HOST=0.0.0.0 HUB_PORT=8080 HUB_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["pnpm", "--filter", "@t3tools/hub", "start"]
