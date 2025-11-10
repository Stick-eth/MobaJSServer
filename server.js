const http = require('http');
const SocketManager = require('./src/network/SocketManager');
const logger = require('./src/utils/logger');

// Crée un serveur HTTP simple (nécessaire pour socket.io)
const server = http.createServer();

const PORT = process.env.PORT || 3000;

// Instancie et démarre le gestionnaire de sockets
SocketManager.attach(server);

server.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`, {
    env: {
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
      LOG_NETWORK: process.env.LOG_NETWORK || 'true',
      LOG_IGNORE_EVENTS: process.env.LOG_IGNORE_EVENTS || '',
      LOG_SAMPLE_N: process.env.LOG_SAMPLE_N || '10',
    }
  });
});
