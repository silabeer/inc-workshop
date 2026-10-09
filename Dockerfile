# Без зависимостей: только рантайм Node и файлы приложения.
FROM node:22-alpine
WORKDIR /app
COPY server.js workshop-engine.js analytics.js index.html theme.css ./
COPY ui ./ui
COPY fonts ./fonts
COPY scenarios ./scenarios
# state.json и archive/ — в томе, чтобы переживать пересоздание контейнера.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV PORT=8085 HOST=0.0.0.0 DATA_DIR=/app/data
EXPOSE 8085
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
