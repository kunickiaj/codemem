FROM node:24-bookworm-slim

ARG CODEMEM_VERSION=latest

ENV NODE_ENV=production

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates make g++ python3 tini \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install -g "codemem@${CODEMEM_VERSION}" \
	&& npm cache clean --force

RUN mkdir -p /data /config /keys /app /home/node/.codemem \
	&& chown -R node:node /data /config /keys /app /home/node/.codemem

WORKDIR /app
USER node

ENTRYPOINT ["tini", "--"]
CMD ["codemem", "--help"]
