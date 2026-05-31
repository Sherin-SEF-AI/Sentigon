# syntax=docker/dockerfile:1
#
# Sentigon frontend image (Next.js standalone).
#
# NEXT_PUBLIC_* values are inlined at BUILD time, not read at runtime, so they
# are passed as build args. Behind the bundled nginx, set them to your public
# origin (the browser talks to nginx, which proxies /api and /ws to the backend):
#   --build-arg NEXT_PUBLIC_API_URL=https://your-domain
#   --build-arg NEXT_PUBLIC_WS_URL=wss://your-domain
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

# Standalone server + static assets + public files.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
