FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json biome.json drizzle.config.ts ./
COPY packages ./packages
COPY e2e ./e2e
COPY scripts ./scripts
COPY docs ./docs

RUN pnpm install --frozen-lockfile

CMD ["sleep", "infinity"]
