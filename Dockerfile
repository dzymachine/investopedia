FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js start.sh ./
COPY lib ./lib
COPY public ./public
EXPOSE 8080
# start.sh hands the root-owned Fly volume to the unprivileged user, then drops root.
CMD ["sh", "/app/start.sh"]
