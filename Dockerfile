# syntax=docker/dockerfile:1
#
# Two build targets:
#   (default) production  -> Bun `--compile` single binary on distroless (~115MB)
#   --target dev          -> node running the raw TS source via tsx (no build)
#
#   docker build -t agentcity .                        # production
#   docker build -t agentcity:dev --target dev .       # local dev

# ---- compile stage: Bun bundles src -> one self-contained executable ----
# Zero runtime deps (AGENTS rule 6), so no install: bun links only node: builtins.
FROM oven/bun:1 AS compile
WORKDIR /src
COPY package.json ./
COPY src ./src
COPY bin ./bin
# agentcity.bun.ts is the compile entry (calls main(); agentcity.ts never self-runs).
RUN bun build ./bin/agentcity.bun.ts --compile --minify --outfile /out/agentcity

# ---- dev stage: node runs raw TypeScript for local iteration (no dist/) ----
# The bin shim finds no dist/ and registers tsx to run bin/agentcity.ts from source.
FROM node:22-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
# --ignore-scripts: skip the prepare build so dist/ stays absent -> tsx path.
RUN npm ci --ignore-scripts
COPY . .
EXPOSE 4243
ENTRYPOINT ["node", "bin/agentcity.js"]
CMD ["--central", "--host", "0.0.0.0"]

# ---- production stage (default): distroless + the Bun binary ----
# distroless/cc supplies the glibc/libstdc++ the Bun runtime needs; nothing else.
FROM gcr.io/distroless/cc-debian12 AS production
WORKDIR /app
COPY --from=compile /out/agentcity ./agentcity
COPY web ./web
# A --compile binary's import.meta.url is virtual, so web/ can't be auto-probed.
ENV AGENTCITY_WEB_DIR=/app/web
# distroless ships an unprivileged "nonroot" user (uid 65532, HOME /home/nonroot).
USER 65532
VOLUME ["/home/nonroot/.agentcity"]
EXPOSE 4243
# ENTRYPOINT = the agentcity binary; CMD picks the role, overridable at run:
#   server (default): central federation hub, bound to all interfaces
#   client:           docker run <image> --federate http://hub:4243 --handle NAME
ENTRYPOINT ["/app/agentcity"]
CMD ["--central", "--host", "0.0.0.0"]
