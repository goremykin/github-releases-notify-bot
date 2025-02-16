FROM node:23-alpine
COPY . .
RUN npm install
CMD npm start
