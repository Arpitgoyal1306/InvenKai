FROM node:24-bookworm-slim AS build-client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server/ ./
COPY --chown=node:node --from=build-client /app/client/dist /app/client/dist
USER node
EXPOSE 5001
CMD ["npm", "start"]
