const axios = require('axios');
const config = require('../../config');

async function validateToken(token) {
  if (!token) return null;
  try {
    const res = await axios.get(`${config.DJANGO_API_URL}/api/walkietalkie/validate-token/`, {
      headers: { Authorization: `Token ${token}` },
      timeout: 5000,
    });
    if (res.data && res.data.user_id != null) {
      return {
        userId: res.data.user_id,
        username: res.data.username || '',
        name: res.data.name || '',
        groupIds: (res.data.group_ids || []).map(String),
        isSuperuser: !!res.data.is_superuser,
      };
    }
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.warn('Validate token error:', err.message, status ? `(${status})` : '', data ? JSON.stringify(data) : '');
  }
  return null;
}

function register(socket) {
  socket.on('auth', async (payload, ack) => {
    const token = payload && payload.token ? payload.token : null;
    const user = await validateToken(token);
    if (!user) {
      socket.emit('error', { code: 'AUTH_FAILED', message: 'Invalid token' });
      if (typeof ack === 'function') ack({ success: false });
      socket.disconnect(true);
      return;
    }
    socket.data.authenticated = true;
    socket.data.userId = user.userId;
    socket.data.username = user.username;
    socket.data.name = user.name;
    socket.data.groupIds = user.groupIds || [];
    socket.data.isSuperuser = user.isSuperuser || false;
    socket.data.userToken = token;
    if (typeof ack === 'function') ack({ success: true, user_id: user.userId, group_ids: user.groupIds });
  });

  socket.on('join_groups', (payload, ack) => {
    if (!socket.data.authenticated) {
      socket.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Authenticate first' });
      if (typeof ack === 'function') ack({ success: false });
      return;
    }
    const groupIds = payload && Array.isArray(payload.groupIds) ? payload.groupIds : [];
    const allowed = socket.data.groupIds || [];
    const joined = [];
    for (const gid of groupIds) {
      const id = String(gid);
      const isDirect = id.startsWith('direct:');
      const allowedHere = isDirect
        ? (socket.data.isSuperuser || id === 'direct:' + socket.data.userId)
        : allowed.includes(id);
      if (allowedHere) {
        socket.join('group:' + id);
        joined.push(id);
      }
    }
    if (typeof ack === 'function') ack({ success: true, groupIds: joined });
    socket.emit('joined_groups', { groupIds: joined });
  });
}

module.exports = { validateToken, register };
