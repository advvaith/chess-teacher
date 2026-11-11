FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
# data/ (opening tables, saved reviews, settings) is mounted from the host.
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
