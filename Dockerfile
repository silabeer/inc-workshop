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
# Готовность (/readyz): процесс отвечает и состояние пишется на диск. Протокол — как у сервера: с TLS_CERT это HTTPS
# (сертификат выписан на внешнее имя, поэтому проверка его не сверяет — ходим на свой же 127.0.0.1).
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "const t=!!process.env.TLS_CERT;require(t?'https':'http').get({host:'127.0.0.1',port:process.env.PORT,path:'/readyz',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
