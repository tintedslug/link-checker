# Official Puppeteer image: Chrome + all the system libraries it needs are preinstalled.
FROM ghcr.io/puppeteer/puppeteer:23.11.1

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

USER root
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: the image already has Chrome, skip our postinstall download
RUN npm install --omit=dev --ignore-scripts
COPY . .
USER pptruser

EXPOSE 3000
CMD ["node", "server.js"]
