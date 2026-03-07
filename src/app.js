const http = require('http');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./config');
const healthRouter = require('./routes/health');
const createWebhooksRouter = require('./routes/webhooks');
const attachSocket = require('./socket');

if (!fs.existsSync(config.RECORDINGS_PATH)) {
  fs.mkdirSync(config.RECORDINGS_PATH, { recursive: true });
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  path: '/socket.io/',
});

app.use(healthRouter);
app.use('/internal', createWebhooksRouter(io));

attachSocket(io);

module.exports = { app, server, io };
