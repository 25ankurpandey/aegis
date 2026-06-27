# Aegis — single multi-purpose image.
# The SAME image runs every service (api), the background worker, and DB migrations,
# differentiated only by the PROCESS_TYPE env var (see scripts/start.sh).
# This guarantees api / worker / migration are byte-identical versions.

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /usr/src/app
RUN apk add --no-cache python3 make g++ libpq-dev
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx nx run-many -t build --all --prod

# ---- release stage ----
FROM node:22-alpine AS release
WORKDIR /usr/src/app
RUN apk add --no-cache libpq tini
ENV NODE_ENV=production
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package.json ./package.json
COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh && addgroup -S aegis && adduser -S aegis -G aegis && chown -R aegis:aegis /usr/src/app
USER aegis
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./scripts/start.sh"]
