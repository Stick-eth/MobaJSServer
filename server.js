const http = require('http');
const SocketManager = require('./src/network/SocketManager');

// Crée un serveur HTTP simple (nécessaire pour socket.io)
const server = http.createServer();

const PORT = process.env.PORT || 3000;

// Instancie et démarre le gestionnaire de sockets
SocketManager.attach(server);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
