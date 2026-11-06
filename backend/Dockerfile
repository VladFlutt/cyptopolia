# Built from the repository root: docker build -f backend/Dockerfile .
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx@4.19.2
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY --from=web /web/dist /app/web/dist
ENV WEB_DIST=/app/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["npx", "tsx", "src/main.ts"]
