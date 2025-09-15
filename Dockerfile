# Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./server.js
EXPOSE 3000
CMD ["node","server.js"]
