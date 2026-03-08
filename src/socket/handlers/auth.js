const axios = require('axios');
const config = require('../../config');

const VALIDATE_URL = `${config.DJANGO_API_URL}/api/walkietalkie/validate-token/`;

function isHtmlResponse(data) {
  if (data == null) return false;
  const s = typeof data === 'string' ? data : (data.toString && data.toString()) || '';
  return s.trimStart().toLowerCase().startsWith('<!') || s.includes('</html>') || s.includes('cf-error');
}

function logValidateError(err, retried = false) {
  const status = err.response?.status;
  const data = err.response?.data;
  const contentType = err.response?.headers?.['content-type'] || '';
  if (status >= 500 || (status == null && err.code !== 'ECONNABORTED')) {
    if (isHtmlResponse(data) || (contentType && contentType.includes('text/html'))) {
      console.warn(
        'Validate token: Django API unreachable (got HTML/5xx).',
        'Check DJANGO_API_URL and that the backend is running behind Cloudflare.',
        status ? `Status: ${status}` : err.message
      );
    } else {
      console.warn('Validate token error:', err.message, status ? `(${status})` : '', retried ? '(after retry)' : '');
    }
    return;
  }
  if (status === 401) {
    const detail = data && typeof data === 'object' && data.detail ? data.detail : 'Invalid token';
    console.warn('Validate token: 401', typeof detail === 'string' ? detail : JSON.stringify(detail));
    return;
  }
  const body = data != null && !isHtmlResponse(data) && contentType.includes('json')
    ? (typeof data === 'object' ? JSON.stringify(data) : String(data))
    : '';
  console.warn('Validate token error:', err.message, status ? `(${status})` : '', body || '');
}

async function validateToken(token, retried = false) {
  if (!token) return null;
  try {
    const res = await axios.get(VALIDATE_URL, {
      headers: { Authorization: `Token ${token}` },
      timeout: 5000,
      validateStatus: (s) => s === 200,
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
    logValidateError(err, retried);
    // Retry once on 5xx or HTML (e.g. Cloudflare 521) to avoid flapping
    if (!retried && (status >= 500 || isHtmlResponse(err.response?.data))) {
      await new Promise((r) => setTimeout(r, 1500));
      return validateToken(token, true);
    }
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
      const allowedHere = allowed.includes(id);
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
