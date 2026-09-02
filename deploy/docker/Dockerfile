FROM node:24-bookworm-slim

ARG CODEMEM_VERSION=latest

ENV NODE_ENV=production
ENV CODEMEM_INSTALL_KIND=docker

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates make g++ python3 tini \
	&& rm -rf /var/lib/apt/lists/*

# Install the CLI and the optional semantic runtime together. The runtime is an
# optional peer, so npm will not add it automatically. ONNXRUNTIME_NODE_INSTALL=skip
# keeps this Linux image from downloading the unused ONNX Runtime GPU provider
# while retaining the bundled CPU binary.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm install -g \
		"codemem@${CODEMEM_VERSION}" \
		"@codemem/embeddings@${CODEMEM_VERSION}" \
	&& npm cache clean --force

RUN mkdir -p /data /config /keys /app /home/node/.codemem \
	&& chown -R node:node /data /config /keys /app /home/node/.codemem

WORKDIR /app
USER node

ENTRYPOINT ["tini", "--"]
CMD ["codemem", "--help"]
