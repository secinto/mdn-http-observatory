FROM node:24-bookworm AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    postgresql-client \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/node/app /home/node/.npm \
  && chown -R node:node /home/node/app /home/node/.npm

WORKDIR /home/node/app

COPY --chown=node:node .npmrc package.json package-lock.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node conf ./conf
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node src ./src
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh

USER node
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libpq5 \
    postgresql-client \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /home/node/app

ARG GIT_SHA=dev
ARG RUN_ID=unknown

ENV NODE_ENV=production
ENV RUN_ID=${RUN_ID}
ENV GIT_SHA=${GIT_SHA}
ENV NODE_EXTRA_CA_CERTS=/home/node/app/node_modules/node_extra_ca_certs_mozilla_bundle/ca_bundle/ca_intermediate_root_bundle.pem

COPY --from=build --chown=node:node /home/node/app/package.json /home/node/app/package-lock.json ./
COPY --from=build --chown=node:node /home/node/app/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=build --chown=node:node /home/node/app/bin ./bin
COPY --from=build --chown=node:node /home/node/app/conf ./conf
COPY --from=build --chown=node:node /home/node/app/migrations ./migrations
COPY --from=build --chown=node:node /home/node/app/src ./src
COPY --from=build --chown=node:node /home/node/app/node_modules ./node_modules

RUN chmod 0755 /home/node/app/docker-entrypoint.sh

USER node

ENTRYPOINT ["/usr/bin/tini", "--", "/home/node/app/docker-entrypoint.sh"]
CMD ["node", "src/api/index.js"]

EXPOSE 8080
