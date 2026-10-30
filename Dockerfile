FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-pw NODE_ENV=production
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright-core install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* && chmod -R a+rX /ms-pw
COPY server/server.js server/rec.js server/hist.js server/ledger.js ./
COPY index.html ./index.html
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data INDEX_FILE=/app/index.html PORT=8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
