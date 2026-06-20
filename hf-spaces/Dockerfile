# Base image: Node.js 18 Bullseye (Debian 11)
FROM node:18-bullseye

# Set working directory
WORKDIR /app

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
  chromium \
  chromium-sandbox \
  libgbm1 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libxss1 \
  libxtst6 \
  libnss3 \
  libnspr4 \
  libxshmfence1 \
  libdrm2 \
  libxkbcommon0 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libgtk-3-0 \
  libasound2 \
  libpangocairo-1.0-0 \
  libpango-1.0-0 \
  libcairo2 \
  libatspi2.0-0 \
  libgdk-pixbuf2.0-0 \
  libpangoft2-1.0-0 \
  libharfbuzz0b \
  libepoxy0 \
  libfribidi0 \
  libthai0 \
  libfontconfig1 \
  libfreetype6 \
  fonts-liberation \
  fonts-noto-color-emoji \
  fonts-noto-cjk \
  wget \
  curl \
  unzip \
  xdg-utils \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set Chromium path
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Node.js dependencies
COPY package*.json ./
RUN npm install --only=production && npm cache clean --force

# Copy source code
COPY . .

# Create non-root user
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# Expose port 7860 (Hugging Face standard)
EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:7860/health || exit 1

# Start Express API
CMD ["node", "api/index.js"]