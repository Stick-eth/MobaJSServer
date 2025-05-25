const { Server } = require('socket.io');

let io = null;
const players = {};

function round2(num) {
  return Math.round(num * 100) / 100;
}

module.exports = {
  attach: function(server) {
    io = new Server(server, {
      cors: { origin: "*" }
    });

    io.on('connection', (socket) => {
      console.log('New client connected:', socket.id);
      players[socket.id] = { id: socket.id, x: 0, z: 0 };

      // Envoie la liste des joueurs à ce joueur
      socket.emit('playersList', Object.values(players));

      // Informe les autres de l'arrivée de ce joueur
      socket.broadcast.emit('playerJoined', players[socket.id]);

      // Quand on reçoit la position du joueur
      socket.on('playerPosition', (data) => {
        if (players[socket.id]) {
          // Arrondit à 2 décimales
          players[socket.id].x = round2(data.x);
          players[socket.id].z = round2(data.z);

          // Prépare le message à broadcaster
          const positionUpdate = {
            id: socket.id,
            x: players[socket.id].x,
            z: players[socket.id].z
          };

          // Broadcast à tous sauf au joueur qui a envoyé
          socket.broadcast.emit('playerPositionUpdate', positionUpdate);
        }
      });

      // Gère la déconnexion
      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        socket.broadcast.emit('playerLeft', { id: socket.id });
        delete players[socket.id];
      });
    });
  }
};
