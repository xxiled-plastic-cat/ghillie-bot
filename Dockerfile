FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/alpha-dashboard/package.json ./apps/alpha-dashboard/
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# curl for health checks; ca-certificates for HTTPS release download
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ARG ZS_PROXY_VERSION=0.15.1
# TARGETARCH is set by BuildKit; fall back to uname for classic docker build.
ARG TARGETARCH
RUN set -eux; \
  arch="${TARGETARCH:-}"; \
  if [ -z "$arch" ]; then \
    case "$(uname -m)" in \
      x86_64) arch=amd64 ;; \
      aarch64|arm64) arch=arm64 ;; \
      *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; \
    esac; \
  fi; \
  case "$arch" in \
    amd64) ZS_ARCH=amd64 ;; \
    arm64) ZS_ARCH=arm64 ;; \
    *) echo "unsupported TARGETARCH=${arch}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL \
    "https://github.com/TxnLab/zs-proxy/releases/download/v${ZS_PROXY_VERSION}/zs-proxy_${ZS_PROXY_VERSION}_linux_${ZS_ARCH}.tar.gz" \
    -o /tmp/zs-proxy.tgz; \
  tar -xzf /tmp/zs-proxy.tgz -C /usr/local/bin zs-proxy; \
  chmod +x /usr/local/bin/zs-proxy; \
  rm /tmp/zs-proxy.tgz; \
  zs-proxy version

COPY --from=deps /app/package.json /app/package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/alpha-dashboard/package.json ./apps/alpha-dashboard/
COPY src ./src
COPY tsconfig.json ./tsconfig.json
COPY config/zs-proxy.yaml /app/config/zs-proxy.yaml
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY docker/sanitize-zs-logs.mjs /app/docker/sanitize-zs-logs.mjs
RUN chmod +x /app/docker/entrypoint.sh \
  && chown -R node:node /app /home/node

USER node
ENV HOME=/home/node
ENV ZEROSIGNAL_KEYRING_BACKEND=file
ENV OPENAI_BASE_URL=http://127.0.0.1:8080/v1
ENV OPEN_AI_API_KEY=zerosignal
# Direct to model operator (no *.belt.algo.xyz relay). Override with PROXY_ZS_PRIVACY=true.
ENV PROXY_ZS_PRIVACY=false
ENV ALPHA_HEALTH_PORT=8788
EXPOSE 8788
ENTRYPOINT ["/app/docker/entrypoint.sh"]
