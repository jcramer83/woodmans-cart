FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npx playwright install chromium

COPY . .

EXPOSE 3456

CMD ["node", "server-standalone.js"]
