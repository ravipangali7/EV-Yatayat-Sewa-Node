require('dotenv').config();
const config = require('./src/config');
const { server } = require('./src/app');

server.listen(config.PORT, () => {
  console.log(`PTT server listening on port ${config.PORT}`);
});
