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
      };
    }
  } catch (err) {
    console.warn('Validate token error:', err.message);
  }
  return null;
}

async function createRecordingMetadata(token, payload) {
  try {
    await axios.post(
      `${DJANGO_API_URL}/api/walkietalkie/recordings/`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${token}`,
        },
        timeout: 5000,
      }
    );
  } catch (err) {
    console.warn('Create recording metadata error:', err.message);
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
  createRecordingMetadata(rec.userToken, {
    group_id: parseInt(rec.groupId, 10) || rec.groupId,
    user_id: rec.userId,
    started_at: rec.startedAt,
    ended_at: endedAt,
    file_path: rec.filePath,
  });
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
      if (allowed.includes(id)) {
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
    if (!groupId || !socket.data.groupIds.includes(groupId)) {
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
    socket.to(room).emit('ptt_audio', { userId: socket.data.userId, chunk });
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
