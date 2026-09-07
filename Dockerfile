# 构建阶段：前端 React/Vite
FROM node:22 AS build
WORKDIR /web
COPY src/web/package.json src/web/package-lock.json ./
RUN npm ci
COPY src/web ./
RUN npm run build

# 运行阶段：后端零第三方依赖，node: 内置模块即可
FROM node:22-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=18318
WORKDIR /app
COPY package.json ./
COPY src/server ./src/server
COPY --from=build /web/dist ./src/web/dist
RUN groupadd -r app && useradd -r -g app app \
    && mkdir -p /data \
    && chown -R app:app /app /data
USER app
EXPOSE 18318
HEALTHCHECK --interval=60s --timeout=10s --retries=3 --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:18318/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server/index.js"]
