# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory in container
WORKDIR /app

# Copy package files from update_server
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev || npm install --production

# Copy application files
COPY . ./

# Ensure downloads directory exists (for local testing)
RUN mkdir -p downloads

# Expose port
EXPOSE 3000

# Add health check with longer start period
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Run directly with node (bypass npm)
CMD ["node", "update_server.js"]