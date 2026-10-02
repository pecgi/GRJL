FROM node:24-alpine

# 零依赖：不需要 npm install，只用 Node 内置模块 + node:sqlite
WORKDIR /app
COPY package.json schema.js server.js import-backup.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    SITE_DIR=/site \
    DATA_DIR=/data

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=6s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
