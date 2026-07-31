# The operator UI is a static bundle. It is served by Caddy rather than by a
# Node process because there is nothing to run: Vite emits files, and Caddy is
# already in the stack terminating TLS and injecting the operator API key that
# the dev proxy injects locally.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# The bundle must NOT contain an API key. vite.config.ts reads SNAP_API_KEY
# without a VITE_ prefix precisely so it cannot be inlined, and the dev proxy is
# the only thing that uses it. In production Caddy does that job instead.
RUN npm run build

FROM caddy:2-alpine AS runtime
COPY --from=build /app/dist /srv
