const { Server } = require('socket.io');
const logger = require('../utils/logger');

let io = null;

// Etat des joueurs côté serveur (autoritaire)
// id -> { id, x, z, hp, dead, spawnX, spawnZ, aaType, aaSpeed, aaRange, aaRadius }
const players = {};

// Projectiles serveur en vol pour validation de collisions
// [{ id, ownerId, x, z, dx, dz, speed, radius, ttl, targetId?, homing? }]
let activeProjectiles = [];
let projectileLoop = null;
let heartbeatInterval = null;
let nextProjectileId = 1;

const TICK_MS = 50; // 20 ticks/s
const ATTACK_RANGE = 6; // portée serveur par défaut pour AA
const DMG_AA = 10; // auto-attaque
const DMG_Q = 20;  // sort Q
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
    // homing: update direction toward current target position
    if (p.homing && p.targetId) {
      const tgt = players[p.targetId];
      if (tgt && !tgt.dead) {
        const dirX = (tgt.x - p.x);
        const dirZ = (tgt.z - p.z);
        const d = Math.hypot(dirX, dirZ) || 0.0001;
        p.dx = dirX / d;
        p.dz = dirZ / d;
      }
    }
    // avance
    p.x += p.dx * p.speed * dt;
    p.z += p.dz * p.speed * dt;
    p.ttl -= dt;

    // collision simple avec joueurs (cercle rayon p.radius)
    let hit = false;
    let hitTargetId = null;
    for (const [id, pl] of Object.entries(players)) {
      if (id === p.ownerId) continue; // pas soi-même
      if (pl.dead) continue;
      const dx = pl.x - p.x;
      const dz = pl.z - p.z;
      const dist2 = dx*dx + dz*dz;
      if (dist2 <= p.radius * p.radius) {
        applyDamage(id, p.damage || DMG_AA, p.ownerId, p.source || 'AA');
        hitTargetId = id;
        hit = true;
        break;
      }
    }

    if (hit) {
      const impact = { x: round2(p.x), y: 0.5, z: round2(p.z) };
  const msg = { id: p.id, ownerId: p.ownerId, targetId: hitTargetId, pos: impact };
      logger.netOut('projectileHit', { to: 'all', data: msg });
      io.emit('projectileHit', msg);
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

  // track last hitter for death summary
  target.lastHitFrom = fromId;
  target.lastHitSource = source;

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
  io.emit('playerDied', { id, by: p.lastHitFrom || null, source: p.lastHitSource || null });

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

    // Avoid monkey-patching socket.io emit functions to prevent any side-effects on event loop

    io.on('connection', (socket) => {
      logger.netIn('connect', { from: socket.id, data: { address: socket.handshake?.address } });

      // No patching of emit; we'll log specific emissions below as needed
      // spawn par défaut + configuration AA (par défaut à distance)
      players[socket.id] = {
        id: socket.id,
        x: 0,
        z: 0,
        hp: MAX_HP,
        dead: false,
        spawnX: 0,
        spawnZ: 0,
        aaType: 'ranged', // 'ranged' | 'melee'
        aaSpeed: 14,      // vitesse projectile pour ranged
        aaRange: ATTACK_RANGE, // portée d'attaque
        aaRadius: 0.6,    // rayon collision projectile
        aaProjectileTTL: 2.0, // durée de vie max projectile en secondes (indépendante de la distance)
        lastSeq: 0, // sequence id derniere position reçue
      };

  // Envoie la liste des joueurs à ce joueur
  logger.netOut('playersList', { to: socket.id, data: Object.values(players) });
  socket.emit('playersList', Object.values(players));

  // Informe les autres de l'arrivée de ce joueur
  logger.netOut('playerJoined', { from: socket.id, to: 'broadcast', data: players[socket.id] });
  socket.broadcast.emit('playerJoined', players[socket.id]);

      // Auto-attaque => projectile serveur (travel-time) + émission visuelle
  socket.on('autoattack', (data) => {
        // inbound log (sampled if configured)
        logger.netIn('autoattack', { from: socket.id, data });
        const fromId = socket.id;
        const targetId = data && data.targetId;
        const from = players[fromId];
        const target = players[targetId];
        if (!from || from.dead) return;
        if (!target || target.dead) return;
        const range = from.aaRange || ATTACK_RANGE;
        const dx0 = (from.x ?? 0) - (target.x ?? 0);
        const dz0 = (from.z ?? 0) - (target.z ?? 0);
        const dist2 = dx0*dx0 + dz0*dz0;
        if (dist2 > range * range) return; // hors portée

        if ((from.aaType || 'ranged') === 'melee') {
          // Attaque instantanée au corps à corps
          io.emit('autoattack', {
            type: 'melee',
            from: fromId,
            targetId: targetId
          });
          applyDamage(targetId, DMG_AA, fromId, 'AA');
        } else {
          // Attaque à distance avec projectile (travel-time)
          const startX = from.x;
          const startZ = from.z;
          const targetX = target.x;
          const targetZ = target.z;
          const dirX = targetX - startX;
          const dirZ = targetZ - startZ;
          const dist = Math.hypot(dirX, dirZ) || 0.0001;
          const nx = dirX / dist;
          const nz = dirZ / dist;

          const speed = from.aaSpeed || 14; // units/s
          const ttl = from.aaProjectileTTL || 2.0; // constant lifetime; collision may end earlier

          const projId = nextProjectileId++;
          const payload = {
            type: 'ranged',
            from: fromId,
            targetId: targetId,
            pos: { x: startX, y: 0.5, z: startZ },
            dir: { x: nx, y: 0, z: nz },
            speed,
            ttl,
            projId,
            homing: true
          };
          logger.netOut('autoattack', { to: 'all', data: payload });
          io.emit('autoattack', payload);

          activeProjectiles.push({
            id: projId,
            ownerId: fromId,
            x: startX,
            z: startZ,
            dx: nx,
            dz: nz,
            speed,
            radius: from.aaRadius || 0.6,
            ttl,
            targetId,
            homing: true,
            damage: DMG_AA,
            source: 'AA'
          });
          startProjectileLoop();
        }
      });

      // Sort Q => projectile serveur pour collisions, visuel client
      socket.on('spellCast', (data) => {
        logger.netIn('spellCast', { from: socket.id, data });
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

        logger.netOut('spellCast', { to: 'all', data: { spell: 'Q', from: fromId, pos: { x: startX, y: 0.5, z: startZ }, dir: { x: dx, y: 0, z: dz } } });
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
          ttl: 0.3,
          damage: DMG_Q,
          source: 'Q'
        });
        startProjectileLoop();
      });

      // Positions joueurs
      socket.on('playerPosition', (data) => {
        const sampled = !logger.shouldLogSampled(`in:playerPosition:${socket.id}`, logger.config.sampleN);
        if (!sampled) {
          logger.netIn('playerPosition', { from: socket.id, data });
        } else {
          logger.netIn('playerPosition', { from: socket.id, sampled: true });
        }
        if (players[socket.id]) {
          if (players[socket.id].dead) return;
          // sequence management
          const seq = (data && typeof data.seq === 'number') ? data.seq : undefined;
          if (seq !== undefined) {
            if (seq <= players[socket.id].lastSeq) {
              // duplicate or old; ignore silently
            } else if (seq > players[socket.id].lastSeq + 1) {
              logger.warn(`Gap in position seq for ${socket.id}: expected ${players[socket.id].lastSeq + 1} got ${seq}`);
            }
            players[socket.id].lastSeq = seq;
          }
          players[socket.id].x = round2(data.x);
          players[socket.id].z = round2(data.z);
          const update = { id: socket.id, x: players[socket.id].x, z: players[socket.id].z };
          socket.broadcast.emit('playerPositionUpdate', update);
        }
      });

      // Snapshot on demand for fast resync after focus
      socket.on('snapshotRequest', () => {
        const snapshot = Object.values(players).map(p => ({ id: p.id, x: p.x, z: p.z, hp: p.hp, dead: p.dead }));
        logger.netOut('playersSnapshot', { to: socket.id, data: snapshot });
        socket.emit('playersSnapshot', snapshot);
      });

      // Log des events non traités
      socket.onAny((event, ...args) => {
        if (event === 'playerPosition' || event === 'disconnect' || event === 'autoattack' || event === 'spellCast') return;
        logger.netIn(event, { from: socket.id, data: args && args[0] });
      });

      socket.on('disconnect', () => {
        logger.netIn('disconnect', { from: socket.id });
        socket.broadcast.emit('playerLeft', { id: socket.id });
        delete players[socket.id];
      });
    });

    // Heartbeat players snapshot broadcast (autorité serveur)
    if (!heartbeatInterval) {
      heartbeatInterval = setInterval(() => {
        const snapshot = Object.values(players).map(p => ({ id: p.id, x: p.x, z: p.z, hp: p.hp, dead: p.dead }));
        io.emit('playersSnapshot', snapshot);
      }, 1000); // every second
    }
  }
};
