const { Server } = require('socket.io');

let io = null;

// Etat des joueurs côté serveur (autoritaire)
// id -> { id, x, z, hp, dead, spawnX, spawnZ }
const players = {};

// Projectiles serveur en vol pour validation de collisions
// [{ ownerId, x, z, dx, dz, speed, radius, ttl }]
let activeProjectiles = [];
let projectileLoop = null;

const TICK_MS = 50; // 20 ticks/s
const ATTACK_RANGE = 6; // portée serveur pour AA
const DMG_ON_HIT = 20;
const MAX_HP = 100;
const RESPAWN_MS = 5000;

function round2(num) {
  return Math.round(num * 100) / 100;
}

function startProjectileLoop() {
  if (projectileLoop) return;
  projectileLoop = setInterval(stepProjectiles, TICK_MS);
}

function stopProjectileLoopIfIdle() {
  if (activeProjectiles.length === 0 && projectileLoop) {
    clearInterval(projectileLoop);
    projectileLoop = null;
  }
}

function stepProjectiles() {
  const dt = TICK_MS / 1000;
  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const p = activeProjectiles[i];
    // avance
    p.x += p.dx * p.speed * dt;
    p.z += p.dz * p.speed * dt;
    p.ttl -= dt;

    // collision simple avec joueurs (cercle rayon p.radius)
    let hit = false;
    for (const [id, pl] of Object.entries(players)) {
      if (id === p.ownerId) continue; // pas soi-même
      if (pl.dead) continue;
      const dx = pl.x - p.x;
      const dz = pl.z - p.z;
      const dist2 = dx*dx + dz*dz;
      if (dist2 <= p.radius * p.radius) {
        applyDamage(id, DMG_ON_HIT, p.ownerId, 'AA');
        hit = true;
        break;
      }
    }

    if (hit || p.ttl <= 0) {
      activeProjectiles.splice(i, 1);
    }
  }

  if (activeProjectiles.length === 0) {
    stopProjectileLoopIfIdle();
  }
}

function applyDamage(targetId, amount, fromId, source) {
  const target = players[targetId];
  if (!target || target.dead) return;

  target.hp = Math.max(0, target.hp - amount);
  io.emit('playerDamaged', { id: targetId, hp: target.hp, from: fromId, source });

  if (target.hp === 0) {
    handleDeath(targetId);
  }
}

function handleDeath(id) {
  const p = players[id];
  if (!p || p.dead) return;
  p.dead = true;
  io.emit('playerDied', { id });

  setTimeout(() => {
    p.hp = MAX_HP;
    p.x = round2(p.spawnX);
    p.z = round2(p.spawnZ);
    p.dead = false;
    io.emit('playerRespawned', { id, x: p.x, z: p.z, hp: p.hp });
  }, RESPAWN_MS);
}

module.exports = {
  attach: function(server) {
    io = new Server(server, {
      cors: { origin: "*" }
    });

    io.on('connection', (socket) => {
      console.log('New client connected:', socket.id);
      // spawn par défaut
      players[socket.id] = { id: socket.id, x: 0, z: 0, hp: MAX_HP, dead: false, spawnX: 0, spawnZ: 0 };

      // Envoie la liste des joueurs à ce joueur
      socket.emit('playersList', Object.values(players));

      // Informe les autres de l'arrivée de ce joueur
      socket.broadcast.emit('playerJoined', players[socket.id]);

      // Auto-attaque => projectile serveur (travel-time) + émission visuelle
      socket.on('autoattack', (data) => {
        const fromId = socket.id;
        const targetId = data && data.targetId;
        const from = players[fromId];
        const target = players[targetId];
        if (!from || from.dead) return;
        if (!target || target.dead) return;

        const dx = (from.x ?? 0) - (target.x ?? 0);
        const dz = (from.z ?? 0) - (target.z ?? 0);
        const dist2 = dx*dx + dz*dz;
        if (dist2 > ATTACK_RANGE * ATTACK_RANGE) return; // hors portée

        const startX = from.x;
        const startZ = from.z;
        const targetX = target.x;
        const targetZ = target.z;
        const dirX = targetX - startX;
        const dirZ = targetZ - startZ;
        const dist = Math.hypot(dirX, dirZ) || 0.0001;
        const nx = dirX / dist;
        const nz = dirZ / dist;

        const AA_SPEED = 14; // units/s
        const ttl = dist / AA_SPEED + 0.02;

        io.emit('autoattack', {
          from: fromId,
          targetId: targetId,
          pos: { x: startX, y: 0.5, z: startZ },
          dir: { x: nx, y: 0, z: nz },
          speed: AA_SPEED,
          ttl
        });

        activeProjectiles.push({
          ownerId: fromId,
          x: startX,
          z: startZ,
          dx: nx,
          dz: nz,
          speed: AA_SPEED,
          radius: 0.6,
          ttl
        });
        startProjectileLoop();
      });

      // Sort Q => projectile serveur pour collisions, visuel client
      socket.on('spellCast', (data) => {
        const fromId = socket.id;
        const from = players[fromId];
        if (!from || from.dead) return;
        const spell = data && data.spell;
        if (spell !== 'Q') return;

        const dir = data && data.dir ? data.dir : null;
        if (!dir) return;
        const len = Math.hypot(dir.x || 0, dir.z || 0);
        if (len <= 0.0001) return;
        const dx = (dir.x || 0) / len;
        const dz = (dir.z || 0) / len;

        const startX = from.x;
        const startZ = from.z;

        io.emit('spellCast', {
          spell: 'Q',
          from: fromId,
          pos: { x: startX, y: 0.5, z: startZ },
          dir: { x: dx, y: 0, z: dz }
        });

        activeProjectiles.push({
          ownerId: fromId,
          x: startX,
          z: startZ,
          dx, dz,
          speed: 25,
          radius: 0.6,
          ttl: 0.3
        });
        startProjectileLoop();
      });

      // Positions joueurs
      socket.on('playerPosition', (data) => {
        if (players[socket.id]) {
          if (players[socket.id].dead) return;
          players[socket.id].x = round2(data.x);
          players[socket.id].z = round2(data.z);
          socket.broadcast.emit('playerPositionUpdate', { id: socket.id, x: players[socket.id].x, z: players[socket.id].z });
        }
      });

      // Log des events non traités
      socket.onAny((event, ...args) => {
        if (event !== 'playerPosition' && event !== 'disconnect' && event !== 'autoattack' && event !== 'spellCast') {
          console.log(`Event inconnu reçu : "${event}" de ${socket.id} | data :`, ...args);
        }
      });

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        socket.broadcast.emit('playerLeft', { id: socket.id });
        delete players[socket.id];
      });
    });
  }
};
