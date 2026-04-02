FROM node:25-alpine
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src/ ./src/
USER node
CMD node src/index.ts
