FROM node:20.20.2-alpine3.22 AS builder
WORKDIR /app
# Build toolchain for native modules (usb, node-hid) when no musl prebuild matches.
RUN apk add --no-cache python3 make g++ linux-headers libusb-dev eudev-dev
COPY package.json package-lock.json ./
COPY vendor ./vendor
COPY patches ./patches
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20.20.2-alpine3.22
WORKDIR /app
ENV NODE_ENV=production
# Runtime .so deps for the native modules.
RUN apk add --no-cache libusb eudev-libs
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# The node:alpine image ships a pre-created unprivileged `node` user/group.
# Running as root gives a compromise inside the process write access to the
# whole container filesystem; dropping to `node` keeps the blast radius
# confined to /app and /tmp. No network/USB privileges are needed — TRON
# signing runs on the host, this image is for EVM-only read surfaces.
USER node
ENTRYPOINT ["node", "dist/index.js"]
