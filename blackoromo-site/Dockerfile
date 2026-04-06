FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --build-from-source sqlite3
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]