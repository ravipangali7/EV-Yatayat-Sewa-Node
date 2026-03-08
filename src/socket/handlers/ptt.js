const path = require('path');
const fs = require('fs');
const axios = require('axios');
const config = require('../../config');

const activeRecordings = new Map();

async function createRecordingMetadata(token, payload) {
  if (!token) {
    console.warn('Create recording metadata: no token');
    return;
  }
  const toIso = (v) => {
    if (v == null) return null;
    const s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : null);
    return s ? s.replace('Z', '+00:00') : null;
  };
  const body = {
    group_id: Number(payload.group_id),
    user_id: Number(payload.user_id),
    started_at: toIso(payload.started_at) || payload.started_at,
    ended_at: toIso(payload.ended_at) || payload.ended_at,
    file_path: payload.file_path ?? null,
    storage_key: payload.storage_key ?? null,
    duration_seconds: payload.duration_seconds != null ? Number(payload.duration_seconds) : null,
    file_size_bytes: payload.file_size_bytes ?? null,
    sample_rate: payload.sample_rate != null ? Math.round(Number(payload.sample_rate)) : 48000,
  };
  if (Number.isNaN(body.group_id) || Number.isNaN(body.user_id)) {
    console.warn('Create recording metadata: invalid group_id or user_id', payload);
    return;
  }
  if (!body.started_at || !body.ended_at) {
    console.warn('Create recording metadata: missing started_at or ended_at', payload);
    return;
  }
  try {
    await axios.post(
      `${config.DJANGO_API_URL}/api/walkietalkie/recordings/`,
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

async function createDirectVoiceMessage(token, payload) {
  if (!token) {
    console.warn('Create direct voice message: no token');
    return;
  }
  const { sender_id, recipient_id, file_path, duration_seconds, sample_rate } = payload;
  if (sender_id == null || recipient_id == null || !file_path) {
    console.warn('Create direct voice message: missing sender_id, recipient_id or file_path', payload);
    return;
  }
  try {
    await axios.post(
      `${config.DJANGO_API_URL}/api/walkietalkie/direct-messages/`,
      {
        sender_id: Number(sender_id),
        recipient_id: Number(recipient_id),
        file_path: String(file_path),
        duration_seconds: duration_seconds != null ? Number(duration_seconds) : null,
        sample_rate: sample_rate != null ? Math.round(Number(sample_rate)) : null,
      },
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
    console.warn('Create direct voice message error:', err.message, status ? `(${status})` : '', data ? JSON.stringify(data) : '');
  }
}

function getRecordingPath(groupId, userId, startedAt) {
  const date = new Date(startedAt).toISOString().slice(0, 10);
  const ts = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const dir = path.join(config.RECORDINGS_PATH, date, String(groupId));
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
  const relativePath = path.relative(config.RECORDINGS_PATH, rec.filePath).replace(/\\/g, '/');
  const isDirect = String(rec.groupId).startsWith('direct:');
  const startMs = new Date(rec.startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  const durationSeconds = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? (endMs - startMs) / 1000
    : null;

  if (isDirect) {
    const driverIdRaw = String(rec.groupId).replace(/^direct:/, '');
    const recipientId = parseInt(driverIdRaw, 10);
    if (!Number.isNaN(recipientId)) {
      createDirectVoiceMessage(rec.userToken, {
        sender_id: rec.userId,
        recipient_id: recipientId,
        file_path: relativePath || path.basename(rec.filePath),
        duration_seconds: durationSeconds,
        sample_rate: rec.sampleRate || 48000,
      });
    }
  } else {
    const groupIdForApi = parseInt(rec.groupId, 10);
    if (typeof groupIdForApi === 'number' && !Number.isNaN(groupIdForApi)) {
      createRecordingMetadata(rec.userToken, {
        group_id: groupIdForApi,
        user_id: rec.userId,
        started_at: rec.startedAt,
        ended_at: endedAt,
        file_path: relativePath || path.basename(rec.filePath),
        sample_rate: rec.sampleRate || 16000,
        duration_seconds: durationSeconds,
      });
    }
  }
}

function register(socket) {
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
      ? (socket.data.isSuperuser || groupId === 'direct:' + socket.data.userId || socket.data.groupIds.includes(groupId))
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
}

module.exports = { register };
