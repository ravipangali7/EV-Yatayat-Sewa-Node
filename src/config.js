const path = require('path');

const PORT = parseInt(process.env.PORT || '8001', 10);
const DJANGO_API_URL = (process.env.DJANGO_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const RECORDINGS_PATH = path.resolve(process.env.RECORDINGS_PATH || './recordings');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DIRECT_GROUP_ID = process.env.DIRECT_GROUP_ID ? parseInt(process.env.DIRECT_GROUP_ID, 10) : null;

module.exports = {
  PORT,
  DJANGO_API_URL,
  RECORDINGS_PATH,
  CORS_ORIGIN,
  DIRECT_GROUP_ID,
};
