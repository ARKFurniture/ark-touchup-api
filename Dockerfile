FROM node:20-alpine

# Set working dir
WORKDIR /app

# Copy package.json + lock file first
COPY package*.json ./

# Install deps
RUN npm ci --omit=dev || npm install --omit=dev

# Copy rest of the app
COPY . .

# Set production env
ENV NODE_ENV=production

# Expose the port Fly will connect to
EXPOSE 3000

# Start command
CMD ["node", "server.js"]
