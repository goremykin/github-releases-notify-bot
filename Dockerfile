FROM node:24-alpine
COPY . .
RUN npm ci
CMD npm start
