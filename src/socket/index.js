const auth = require('./handlers/auth');
const ptt = require('./handlers/ptt');
const trip = require('./handlers/trip');

function attachSocket(io) {
  io.on('connection', (socket) => {
    socket.data.authenticated = false;
    socket.data.userId = null;
    socket.data.username = null;
    socket.data.groupIds = [];
    socket.data.userToken = null;

    auth.register(socket);
    ptt.register(socket);
    trip.register(socket, io);
  });
}

module.exports = attachSocket;
