FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx@4.19.2
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["npx", "tsx", "src/main.ts"]
