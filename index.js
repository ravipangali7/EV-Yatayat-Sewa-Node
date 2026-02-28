require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');

const PORT = 8001;
const DJANGO_API_URL = (process.env.DJANGO_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const RECORDINGS_PATH = path.resolve(process.env.RECORDINGS_PATH || './recordings');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
/** For direct PTT, Django expects a group_id. Create a group named "Direct" in Django admin, add superusers as members, set DIRECT_GROUP_ID to its id. */
const DIRECT_GROUP_ID = process.env.DIRECT_GROUP_ID ? parseInt(process.env.DIRECT_GROUP_ID, 10) : null;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  path: '/socket.io/',
});

// Ensure recordings directory exists
function ensureRecordingsDir() {
  if (!fs.existsSync(RECORDINGS_PATH)) {
    fs.mkdirSync(RECORDINGS_PATH, { recursive: true });
  }
}
ensureRecordingsDir();

async function validateToken(token) {
  if (!token) return null;
  try {
    const res = await axios.get(`${DJANGO_API_URL}/api/walkietalkie/validate-token/`, {
      params: { token },
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
    console.warn('Validate token error:', err.message);
  }
  return null;
}

async function createRecordingMetadata(token, payload) {
  if (!token) {
    console.warn('Create recording metadata: no token');
    return;
  }
  const body = {
    group_id: Number(payload.group_id),
    user_id: Number(payload.user_id),
    started_at: payload.started_at,
    ended_at: payload.ended_at,
    file_path: payload.file_path ?? null,
    storage_key: payload.storage_key ?? null,
    duration_seconds: payload.duration_seconds ?? null,
    file_size_bytes: payload.file_size_bytes ?? null,
    sample_rate: payload.sample_rate != null ? Math.round(Number(payload.sample_rate)) : 16000,
  };
  if (Number.isNaN(body.group_id) || Number.isNaN(body.user_id)) {
    console.warn('Create recording metadata: invalid group_id or user_id', payload);
    return;
  }
  try {
    await axios.post(
      `${DJANGO_API_URL}/api/walkietalkie/recordings/`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${token}`,
        },
        timeout: 5000,
      }
    );
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.warn('Create recording metadata error:', err.message, status ? `(${status})` : '', data ? JSON.stringify(data) : '');
  }
}

// Active PTT recording streams: key = `${socket.id}_${groupId}`
const activeRecordings = new Map();

function getRecordingPath(groupId, userId, startedAt) {
  const date = new Date(startedAt).toISOString().slice(0, 10);
  const ts = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const dir = path.join(RECORDINGS_PATH, date, String(groupId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${userId}_${ts}.pcm`);
}

function startRecording(socketId, groupId, userId, userToken) {
  const key = `${socketId}_${groupId}`;
  if (activeRecordings.has(key)) return;
  const startedAt = new Date().toISOString();
  const filePath = getRecordingPath(groupId, userId, startedAt);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  activeRecordings.set(key, {
    stream,
    startedAt,
    filePath,
    userToken,
    userId,
    groupId,
    sampleRate: null,
  });
}

function writeRecordingChunk(socketId, groupId, chunk) {
  const key = `${socketId}_${groupId}`;
  const rec = activeRecordings.get(key);
  if (rec && rec.stream && !rec.stream.destroyed) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'base64');
    rec.stream.write(buf);
  }
}

function endRecording(socketId, groupId) {
  const key = `${socketId}_${groupId}`;
  const rec = activeRecordings.get(key);
  if (!rec) return;
  activeRecordings.delete(key);
  if (rec.stream && !rec.stream.destroyed) {
    rec.stream.end();
  }
  const endedAt = new Date().toISOString();
  const relativePath = path.relative(RECORDINGS_PATH, rec.filePath);
  const isDirect = String(rec.groupId).startsWith('direct:');
  const groupIdForApi = isDirect && DIRECT_GROUP_ID
    ? DIRECT_GROUP_ID
    : (parseInt(rec.groupId, 10) || rec.groupId);
  if (typeof groupIdForApi === 'number' && !Number.isNaN(groupIdForApi)) {
    createRecordingMetadata(rec.userToken, {
      group_id: groupIdForApi,
      user_id: rec.userId,
      started_at: rec.startedAt,
      ended_at: endedAt,
      file_path: relativePath || path.basename(rec.filePath),
      sample_rate: rec.sampleRate || 16000,
    });
  }
}

io.on('connection', (socket) => {
  socket.data.authenticated = false;
  socket.data.userId = null;
  socket.data.username = null;
  socket.data.groupIds = [];
  socket.data.userToken = null;

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

  socket.on('ptt_start', (payload) => {
    if (!socket.data.authenticated) {
      socket.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Authenticate first' });
      return;
    }
    const groupId = payload && payload.groupId != null ? String(payload.groupId) : null;
    if (!groupId) {
      socket.emit('error', { code: 'FORBIDDEN_GROUP', message: 'Not a member of this group' });
      return;
    }
    const isDirect = groupId.startsWith('direct:');
    const allowed = isDirect
      ? (socket.data.isSuperuser || groupId === 'direct:' + socket.data.userId)
      : socket.data.groupIds.includes(groupId);
    if (!allowed) {
      socket.emit('error', { code: 'FORBIDDEN_GROUP', message: 'Not a member of this group' });
      return;
    }
    const room = 'group:' + groupId;
    socket.data._pttGroupId = groupId;
    socket.to(room).emit('ptt_started', {
      userId: socket.data.userId,
      username: socket.data.username,
      name: socket.data.name,
      groupId,
    });
    startRecording(socket.id, groupId, socket.data.userId, socket.data.userToken);
  });

  socket.on('ptt_audio', (payload) => {
    if (!socket.data.authenticated) return;
    const groupId = socket.data._pttGroupId;
    if (!groupId) return;
    const chunk = payload != null && typeof payload === 'object' && payload.chunk != null
      ? payload.chunk
      : payload;
    if (chunk == null) return;
    const room = 'group:' + groupId;
    const sampleRate = payload != null && typeof payload === 'object' && typeof payload.sampleRate === 'number'
      ? payload.sampleRate
      : undefined;
    const recKey = `${socket.id}_${groupId}`;
    const rec = activeRecordings.get(recKey);
    if (rec && sampleRate != null && rec.sampleRate == null) rec.sampleRate = sampleRate;
    socket.to(room).emit('ptt_audio', { userId: socket.data.userId, chunk, sampleRate });
    writeRecordingChunk(socket.id, groupId, chunk);
  });

  socket.on('ptt_end', (payload) => {
    if (!socket.data.authenticated) return;
    const groupId = payload && payload.groupId != null ? String(payload.groupId) : null;
    if (groupId) {
      const room = 'group:' + groupId;
      socket.to(room).emit('ptt_ended', { userId: socket.data.userId, groupId });
      endRecording(socket.id, groupId);
    }
    socket.data._pttGroupId = null;
  });

  socket.on('disconnect', () => {
    socket.data._pttGroupId = null;
    const keysToEnd = Array.from(activeRecordings.keys()).filter((k) => k.startsWith(socket.id + '_'));
    keysToEnd.forEach((key) => {
      const gid = key.slice(String(socket.id).length + 1);
      endRecording(socket.id, gid);
    });
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

server.listen(PORT, () => {
  console.log(`PTT server listening on port ${PORT}`);
});
