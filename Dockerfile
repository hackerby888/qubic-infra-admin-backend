# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build                       # tsc -> dist/

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Runtime assets the app reads via process.cwd()/src/scripts (general-setup.sh,
# bob/kvrocks.conf, bob/keydb.conf — transferred to nodes during SSH setup).
COPY src/scripts ./src/scripts
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
