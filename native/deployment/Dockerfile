FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
RUN mkdir -p /var/lib/synced/segment-relay \
    && chown -R node:node /var/lib/synced

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
USER node

CMD ["node", "server/index.mjs"]
