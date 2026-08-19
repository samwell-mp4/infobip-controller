FROM node:22-alpine
WORKDIR /app
COPY controller/package.json ./
RUN npm install --omit=dev
COPY controller/server.js ./
EXPOSE 3000
CMD ["node", "server.js"]