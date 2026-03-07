const axios = require('axios');
const config = require('../../config');
const { validateToken } = require('./auth');

function register(socket, io) {
  socket.on('join_trip', async (payload, ack) => {
    const trip_id = payload && payload.trip_id != null ? String(payload.trip_id) : null;
    const token = (payload && payload.token) || socket.data.userToken;
    if (!trip_id) {
      socket.emit('error', { code: 'BAD_PAYLOAD', message: 'trip_id is required' });
      if (typeof ack === 'function') ack({ success: false });
      return;
    }
    const user = await validateToken(token);
    if (!user) {
      socket.emit('error', { code: 'AUTH_FAILED', message: 'Invalid token' });
      if (typeof ack === 'function') ack({ success: false });
      return;
    }
    socket.data.authenticated = true;
    socket.data.userId = user.userId;
    socket.data.userToken = token;
    socket.join('trip:' + trip_id);
    socket.data.tripId = trip_id;
    if (typeof ack === 'function') ack({ success: true, trip_id });
  });

  socket.on('location', (payload) => {
    if (!socket.data.authenticated || !payload || !payload.trip_id) return;
    const trip_id = String(payload.trip_id);
    if (socket.data.tripId !== trip_id) return;
    const room = 'trip:' + trip_id;
    socket.to(room).emit('location', {
      trip_id: payload.trip_id,
      vehicle_id: payload.vehicle_id,
      lat: payload.lat,
      lng: payload.lng,
      speed: payload.speed,
      ts: payload.ts || new Date().toISOString(),
    });
  });
}

module.exports = { register };
