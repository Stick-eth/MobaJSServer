const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const logger = require('../utils/logger');
const MinionManager = require('../minions/minionManager');
const { CLASS_DEFS, DEFAULT_CLASS_ID } = require('../data/classDefinitions');

let io = null;

// Etat des joueurs côté serveur (autoritaire)
// id -> { id, x, z, hp, dead, spawnX, spawnZ, aaType, aaSpeed, aaRange, aaRadius }
const players = {};

// Projectiles serveur en vol pour validation de collisions
// [{ id, ownerId, x, z, dx, dz, speed, radius, ttl, targetId?, homing? }]
let activeProjectiles = [];
let heartbeatInterval = null;
let nextProjectileId = 1;
let gameLoop = null;
let lastTickAt = Date.now();
const turrets = [];
let turretsReady = false;

const TEAM_BLUE = 'blue';
const TEAM_RED = 'red';

const TICK_MS = 50; // 20 ticks/s
const RESPAWN_MS = 5000;
const SUMMONER_COOLDOWNS_MS = {
  flash: 300000
};

const LEVEL_CAP = 18;
const LEVEL_XP_BASE = 200;
const LEVEL_XP_GROWTH = 120;
const HP_GROWTH_PER_LEVEL = 1.08;
const DAMAGE_GROWTH_PER_LEVEL = 1.06;
const SPEED_GROWTH_PER_LEVEL = 1.02;
const KILL_XP_BASE = 240;
const KILL_XP_PER_LEVEL = 35;

const TURRET_RADIUS = 5;
const TURRET_ATTACK_INTERVAL = 1 / 0.8333;
const TURRET_DAMAGE_PLAYER = 30;
const TURRET_MINION_DAMAGE_RATIOS = {
  melee: 0.45,
  ranged: 0.7,
  cannon: 0.14
};
const TURRET_PROJECTILE_SPEED = 22;
const TURRET_PROJECTILE_HEIGHT = 2.8;
const TERRAIN_SIZE = 100;
const TURRET_MAP_ROOT = path.resolve(__dirname, '..', 'maps', 'base_map');
const PLAYER_HP_REGEN_PER_SECOND = 1;

function clampLevel(level) {
  return Math.max(1, Math.min(level || 1, LEVEL_CAP));
}

function xpRequiredForLevel(level = 1) {
  const clamped = clampLevel(level);
  return Math.round(LEVEL_XP_BASE + (clamped - 1) * LEVEL_XP_GROWTH);
}

function growthForLevel(baseGrowth, level) {
  return Math.pow(baseGrowth, Math.max(0, clampLevel(level) - 1));
}

function getClassDefinition(classId) {
  return CLASS_DEFS[classId] || CLASS_DEFS[DEFAULT_CLASS_ID];
}

function createPlayerState(id) {
  return {
    id,
    x: 0,
    z: 0,
    hp: 0,
    maxHp: 0,
    dead: false,
    spawnX: 0,
    spawnZ: 0,
    team: null,
    classId: DEFAULT_CLASS_ID,
    aaType: 'ranged',
    aaSpeed: 0,
    aaRange: 0,
    aaRadius: 0,
    aaProjectileTTL: 0,
    aaDamage: 0,
    aaCooldownMs: 0,
    nextAaBonus: 0,
    lastSeq: 0,
    qConfig: null,
    summonerCooldowns: {},
    level: 1,
    xp: 0,
    xpToNext: xpRequiredForLevel(1),
    moveSpeed: 4.5,
    baseStats: null,
    regenAccumulator: 0
  };
}

function applyClassToPlayer(player, classId, { resetHp = false } = {}) {
  const classDef = getClassDefinition(classId);
  player.classId = classDef.id;
  player.level = clampLevel(player.level || 1);
  player.xp = Math.max(0, player.xp || 0);
  player.xpToNext = player.level >= LEVEL_CAP ? 0 : xpRequiredForLevel(player.level);

  const stats = classDef.stats || {};
  player.baseStats = {
    maxHp: stats.maxHp ?? 100,
    moveSpeed: stats.moveSpeed ?? 4.5,
    autoAttack: { ...(stats.autoAttack || {}) },
    qConfig: (classDef.spells && classDef.spells.Q) ? { ...classDef.spells.Q } : null
  };

  if (resetHp) {
    player.hp = player.baseStats.maxHp;
  } else if (typeof player.hp !== 'number' || Number.isNaN(player.hp)) {
    player.hp = player.baseStats.maxHp;
  }

  const scalingResult = applyLevelScaling(player, { preserveHpRatio: !resetHp });
  if (resetHp) {
    player.hp = player.maxHp;
  } else if (!scalingResult || typeof scalingResult.newMaxHp !== 'number') {
    player.hp = Math.min(player.hp, player.maxHp);
  }

  player.nextAaBonus = 0;
  player.regenAccumulator = player.regenAccumulator || 0;
  return classDef;
}

function serializePlayer(player) {
  return {
    id: player.id,
    x: player.x,
    z: player.z,
    hp: player.hp,
    maxHp: player.maxHp,
    dead: player.dead,
    team: player.team,
    classId: player.classId,
    level: player.level,
    xp: player.xp,
    xpToNext: player.xpToNext,
    moveSpeed: player.moveSpeed
  };
}

function pickTeam() {
  const counts = {
    [TEAM_BLUE]: 0,
    [TEAM_RED]: 0
  };
  Object.values(players).forEach(player => {
    if (player.team === TEAM_BLUE) counts[TEAM_BLUE] += 1;
    else if (player.team === TEAM_RED) counts[TEAM_RED] += 1;
  });
  if (counts[TEAM_BLUE] <= counts[TEAM_RED]) return TEAM_BLUE;
  return TEAM_RED;
}

function areAllies(playerA, playerB) {
  if (!playerA || !playerB) return false;
  if (!playerA.team || !playerB.team) return false;
  return playerA.team === playerB.team;
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

function applyLevelScaling(player, { preserveHpRatio = true } = {}) {
  if (!player) return null;
  const base = player.baseStats || {};
  const level = clampLevel(player.level);
  const prevMaxHp = typeof player.maxHp === 'number' ? player.maxHp : (base.maxHp ?? 100);
  const prevHp = typeof player.hp === 'number' ? player.hp : prevMaxHp;

  const hpMultiplier = growthForLevel(HP_GROWTH_PER_LEVEL, level);
  const dmgMultiplier = growthForLevel(DAMAGE_GROWTH_PER_LEVEL, level);
  const speedMultiplier = growthForLevel(SPEED_GROWTH_PER_LEVEL, level);

  const baseMaxHp = base.maxHp ?? 100;
  const newMaxHp = Math.round(baseMaxHp * hpMultiplier);
  const ratio = preserveHpRatio && prevMaxHp > 0
    ? Math.min(1, Math.max(0, prevHp / prevMaxHp))
    : 1;

  player.maxHp = newMaxHp;
  player.hp = Math.min(newMaxHp, Math.round(newMaxHp * ratio));

  const aaBase = base.autoAttack || {};
  player.aaType = aaBase.type || 'ranged';
  player.aaDamage = Number(((aaBase.damage ?? 0) * dmgMultiplier).toFixed(2));
  player.aaRange = aaBase.range ?? player.aaRange ?? 4;
  player.aaSpeed = aaBase.projectileSpeed ?? 0;
  player.aaRadius = aaBase.projectileRadius ?? 0.6;
  player.aaProjectileTTL = aaBase.projectileTtl ?? 0;
  player.aaCooldownMs = aaBase.cooldownMs ?? 650;

  player.moveSpeed = Number(((base.moveSpeed ?? 4.5) * speedMultiplier).toFixed(2));

  const qBase = base.qConfig || null;
  if (qBase) {
    player.qConfig = { ...qBase };
    if (typeof qBase.damage === 'number') {
      player.qConfig.damage = Number((qBase.damage * dmgMultiplier).toFixed(2));
    }
    if (typeof qBase.bonusDamage === 'number') {
      player.qConfig.bonusDamage = Number((qBase.bonusDamage * dmgMultiplier).toFixed(2));
    }
  } else {
    player.qConfig = null;
  }

  return { prevMaxHp, newMaxHp };
}

function buildProgressPayload(player, { leveledUp = false, levelsGained = 0 } = {}) {
  return {
    id: player.id,
    level: clampLevel(player.level),
    xp: player.xp,
    xpToNext: player.xpToNext,
    hp: player.hp,
    maxHp: player.maxHp,
    moveSpeed: player.moveSpeed,
    aaDamage: player.aaDamage,
    qDamage: player.qConfig && typeof player.qConfig.damage === 'number' ? player.qConfig.damage : null,
    leveledUp: Boolean(leveledUp),
    levelsGained
  };
}

function broadcastProgress(player, { leveledUp = false, levelsGained = 0, targetSocket = null } = {}) {
  if (!player) return;
  const payload = buildProgressPayload(player, { leveledUp, levelsGained });
  if (targetSocket) {
    targetSocket.emit('playerProgress', payload);
  } else if (io) {
    io.emit('playerProgress', payload);
  }
}

function addExperience(player, amount) {
  if (!player || typeof amount !== 'number' || amount <= 0) {
    return { leveledUp: false, levelsGained: 0 };
  }

  let remaining = Math.floor(amount);
  let leveledUp = false;
  let levelsGained = 0;

  while (remaining > 0 && player.level < LEVEL_CAP) {
    const needed = Math.max(1, (player.xpToNext || xpRequiredForLevel(player.level)) - (player.xp || 0));
    if (remaining >= needed) {
      remaining -= needed;
      player.level = clampLevel(player.level + 1);
      player.xp = 0;
      const scalingInfo = applyLevelScaling(player, { preserveHpRatio: true });
      if (scalingInfo && typeof scalingInfo.prevMaxHp === 'number') {
        const hpGain = player.maxHp - scalingInfo.prevMaxHp;
        if (hpGain > 0) {
          player.hp = Math.min(player.maxHp, Math.round(player.hp + Math.max(hpGain, 0)));
        }
      }
      leveledUp = true;
      levelsGained += 1;
      player.xpToNext = player.level >= LEVEL_CAP ? 0 : xpRequiredForLevel(player.level);
    } else {
      player.xp = (player.xp || 0) + remaining;
      remaining = 0;
    }
  }

  if (player.level >= LEVEL_CAP) {
    player.level = LEVEL_CAP;
    player.xp = 0;
    player.xpToNext = 0;
  } else {
    player.xpToNext = xpRequiredForLevel(player.level);
  }

  broadcastProgress(player, { leveledUp, levelsGained });
  return { leveledUp, levelsGained };
}

function computeKillXp(killer, victim) {
  if (!killer || !victim) return 0;
  const base = KILL_XP_BASE + ((victim.level || 1) - 1) * KILL_XP_PER_LEVEL;
  const levelDiff = (victim.level || 1) - (killer.level || 1);
  const diffFactor = 1 + Math.max(-0.4, Math.min(0.4, levelDiff * 0.08));
  const xp = Math.round(base * diffFactor);
  return Math.max(80, xp);
}

function awardKillExperience(killerId, victim) {
  if (!killerId || !victim) return;
  const killer = players[killerId];
  if (!killer || killer.dead) return;
  if (killerId === victim.id) return;
  const xpGain = computeKillXp(killer, victim);
  if (xpGain <= 0) return;
  addExperience(killer, xpGain);
}
function loadPngAsync(filePath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(new PNG({ filterType: 4 }))
      .on('parsed', function parsed() { resolve(this); })
      .on('error', reject);
  });
}

function uvToWorld(u, v) {
  const half = TERRAIN_SIZE * 0.5;
  const x = (u - 0.5) * TERRAIN_SIZE;
  const z = -(v - 0.5) * TERRAIN_SIZE;
  return {
    x: Math.max(-half, Math.min(x, half)),
    z: Math.max(-half, Math.min(z, half))
  };
}

async function loadTurretMarkersForTeam(team) {
  const teamDir = path.join(TURRET_MAP_ROOT, team, 'turrets');
  if (!fs.existsSync(teamDir)) {
    logger.warn(`Turret directory missing for team ${team}: ${teamDir}`);
    return [];
  }

  const entries = fs.readdirSync(teamDir).filter(name => name.toLowerCase().endsWith('.png'));
  const results = [];

  for (const filename of entries) {
    const match = /^t_(\d+)_(\d+)\.png$/i.exec(filename);
    if (!match) {
      continue;
    }
    const lane = parseInt(match[1], 10);
    const tier = parseInt(match[2], 10);
    const id = `t_${lane}_${tier}`;
    const filePath = path.join(teamDir, filename);
    try {
      const png = await loadPngAsync(filePath);
      const { width, height, data } = png;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 4;
          const alpha = data[index + 3];
          if (alpha < 8) continue;
          sumX += x + 0.5;
          sumY += y + 0.5;
          count += 1;
        }
      }
      if (!count) {
        logger.warn(`Turret marker empty: ${filePath}`);
        continue;
      }
      const u = (sumX / count) / width;
      const v = 1 - (sumY / count) / height;
      const world = uvToWorld(u, v);
      results.push({
        uid: `${team}:${id}`,
        id,
        team,
        lane,
        tier,
        x: world.x,
        z: world.z
      });
    } catch (error) {
      logger.error(`Failed to load turret marker ${filePath}`, { error: error.message });
    }
  }

  return results;
}

async function loadTurrets() {
  turrets.length = 0;
  const blue = await loadTurretMarkersForTeam(TEAM_BLUE);
  const red = await loadTurretMarkersForTeam(TEAM_RED);
  [...blue, ...red].forEach(entry => {
    turrets.push({
      uid: entry.uid,
      id: entry.id,
      team: entry.team,
      lane: entry.lane,
      tier: entry.tier,
      position: { x: entry.x, z: entry.z },
      cooldown: Math.random() * TURRET_ATTACK_INTERVAL,
      target: null
    });
  });
  turretsReady = turrets.length > 0;
  if (!turretsReady) {
    logger.warn('No turret markers were loaded');
  } else {
    logger.info('Turrets loaded', { count: turrets.length });
  }
}

function distanceSquared(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function validateTurretTarget(turret) {
  if (!turret || !turret.target) {
    return null;
  }
  const radiusSq = TURRET_RADIUS * TURRET_RADIUS;
  if (turret.target.type === 'minion') {
    const minion = MinionManager.getMinionById(turret.target.id);
    if (!minion || minion.dead || minion.team === turret.team) {
      return null;
    }
    const distSq = distanceSquared(turret.position.x, turret.position.z, minion.position.x, minion.position.z);
    if (distSq > radiusSq) return null;
    return { type: 'minion', id: minion.id };
  }
  if (turret.target.type === 'player') {
    const player = players[turret.target.id];
    if (!player || player.dead || player.team === turret.team) {
      return null;
    }
    const distSq = distanceSquared(turret.position.x, turret.position.z, player.x, player.z);
    if (distSq > radiusSq) return null;
    return { type: 'player', id: player.id };
  }
  return null;
}

function acquireTurretTarget(turret) {
  const radiusSq = TURRET_RADIUS * TURRET_RADIUS;
  const prioritizedMinions = {
    cannon: null,
    melee: null,
    ranged: null
  };
  MinionManager.forEachMinion(minion => {
    if (!minion || minion.dead || minion.team === turret.team) {
      return;
    }
    const distSq = distanceSquared(turret.position.x, turret.position.z, minion.position.x, minion.position.z);
    if (distSq > radiusSq) return;
    const bucket = (minion.type === 'cannon') ? 'cannon' : (minion.type === 'melee' ? 'melee' : 'ranged');
    const current = prioritizedMinions[bucket];
    if (!current || distSq < current.distSq) {
      prioritizedMinions[bucket] = { id: minion.id, distSq };
    }
  });
  if (prioritizedMinions.cannon) {
    return { type: 'minion', id: prioritizedMinions.cannon.id };
  }
  if (prioritizedMinions.melee) {
    return { type: 'minion', id: prioritizedMinions.melee.id };
  }
  if (prioritizedMinions.ranged) {
    return { type: 'minion', id: prioritizedMinions.ranged.id };
  }

  let bestPlayer = null;
  Object.values(players).forEach(player => {
    if (!player || player.dead || !player.team || player.team === turret.team) {
      return;
    }
    const distSq = distanceSquared(turret.position.x, turret.position.z, player.x, player.z);
    if (distSq > radiusSq) {
      return;
    }
    if (!bestPlayer || distSq < bestPlayer.distSq) {
      bestPlayer = { type: 'player', id: player.id, distSq };
    }
  });
  if (bestPlayer) {
    return { type: 'player', id: bestPlayer.id };
  }
  return null;
}

function broadcastTurretAttack(turret, targetPayload, targetState, extra = {}) {
  if (!io || !turret || !targetPayload) {
    return;
  }
  const origin = {
    x: round2(turret.position.x),
    y: round2(TURRET_PROJECTILE_HEIGHT),
    z: round2(turret.position.z)
  };
  const targetX = round2(targetState?.position?.x ?? targetState?.x ?? 0);
  const targetZ = round2(targetState?.position?.z ?? targetState?.z ?? 0);
  const distance = Math.hypot(targetX - origin.x, targetZ - origin.z);
  const travelTime = distance > 0 ? distance / TURRET_PROJECTILE_SPEED : 0;
  const payload = {
    turretId: turret.uid,
    team: turret.team,
    targetType: targetPayload.type,
    targetId: targetPayload.id,
    origin,
    target: {
      x: targetX,
      y: round2(TURRET_PROJECTILE_HEIGHT),
      z: targetZ
    },
    speed: TURRET_PROJECTILE_SPEED,
    travelTime,
    lane: turret.lane,
    tier: turret.tier,
    ...extra
  };
  io.emit('turretAttack', payload);
}

function fireTurret(turret) {
  if (!turret || !turret.target) {
    return;
  }
  if (turret.target.type === 'minion') {
    const minion = MinionManager.getMinionById(turret.target.id);
    if (!minion || minion.dead || minion.team === turret.team) {
      turret.target = null;
      return;
    }
    const ratio = TURRET_MINION_DAMAGE_RATIOS[minion.type] ?? 0.5;
    const damage = Math.max(1, Math.round((minion.maxHp || 1) * ratio));
    const result = MinionManager.damageMinion(minion.id, damage, { attackerId: turret.uid, cause: 'turret' });
    broadcastTurretAttack(turret, turret.target, minion, { damage });
    if (!result.ok || result.killed) {
      turret.target = null;
    }
    return;
  }
  if (turret.target.type === 'player') {
    const player = players[turret.target.id];
    if (!player || player.dead || player.team === turret.team) {
      turret.target = null;
      return;
    }
    applyDamage(player.id, TURRET_DAMAGE_PLAYER, null, 'turret');
    broadcastTurretAttack(turret, turret.target, player, { damage: TURRET_DAMAGE_PLAYER });
    if (player.dead || player.hp <= 0) {
      turret.target = null;
    }
  }
}

function updateTurrets(dt) {
  if (!turretsReady || !turrets.length) {
    return;
  }
  turrets.forEach(turret => {
    turret.cooldown = Math.max(0, (turret.cooldown || 0) - dt);
    const validated = validateTurretTarget(turret);
    if (validated) {
      turret.target = validated;
    } else {
      turret.target = null;
    }
    if (!turret.target) {
      const candidate = acquireTurretTarget(turret);
      if (candidate) {
        turret.target = candidate;
      }
    }
    if (turret.target && turret.cooldown <= 0) {
      fireTurret(turret);
      turret.cooldown = TURRET_ATTACK_INTERVAL;
    }
  });
}

function regeneratePlayers(dt) {
  if (!io || dt <= 0) {
    return;
  }
  const regenPerTick = PLAYER_HP_REGEN_PER_SECOND * dt;
  if (regenPerTick <= 0) {
    return;
  }
  Object.values(players).forEach(player => {
    if (!player || player.dead) return;
    if (typeof player.hp !== 'number' || typeof player.maxHp !== 'number') return;
    if (player.hp >= player.maxHp) return;

    const nextHp = Math.min(player.maxHp, Math.round((player.hp + regenPerTick) * 100) / 100);
    if (nextHp <= player.hp) {
      return;
    }
    player.hp = nextHp;
    io.emit('playerHealthUpdate', {
      id: player.id,
      hp: player.hp,
      maxHp: player.maxHp,
      source: 'regen'
    });
  });
}


function ensureGameLoop() {
  if (gameLoop) return;
  lastTickAt = Date.now();
  gameLoop = setInterval(() => {
    const now = Date.now();
    const dtMs = now - lastTickAt;
    lastTickAt = now;
    const dt = Math.min(Math.max(dtMs, 0) / 1000, 0.25);
    updateProjectiles(dt);
    MinionManager.update(dt, {
      players,
      damagePlayer: applyDamage,
    });
    updateTurrets(dt);
    regeneratePlayers(dt);
  }, TICK_MS);
}

function startProjectileLoop() {
  ensureGameLoop();
}

function updateProjectiles(dt) {
  if (!activeProjectiles.length) {
    return;
  }
  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const p = activeProjectiles[i];
    const owner = players[p.ownerId];
    // homing: update direction toward current target position
    if (p.homing && p.targetId) {
      if (p.targetType === 'minion') {
        const tgt = MinionManager.getMinionById(p.targetId);
        if (tgt && !tgt.dead) {
          const dirX = (tgt.position.x - p.x);
          const dirZ = (tgt.position.z - p.z);
          const d = Math.hypot(dirX, dirZ) || 0.0001;
          p.dx = dirX / d;
          p.dz = dirZ / d;
        }
      } else {
        const tgt = players[p.targetId];
        if (tgt && !tgt.dead) {
          const dirX = (tgt.x - p.x);
          const dirZ = (tgt.z - p.z);
          const d = Math.hypot(dirX, dirZ) || 0.0001;
          p.dx = dirX / d;
          p.dz = dirZ / d;
        }
      }
    }
    // avance
    p.x += p.dx * p.speed * dt;
    p.z += p.dz * p.speed * dt;
    p.ttl -= dt;

    // collision simple avec joueurs (cercle rayon p.radius)
    let hit = false;
    let hitTargetId = null;
    let hitTargetType = null;

    if (!hit && p.targetType !== 'player') {
      MinionManager.forEachMinion((minion) => {
        if (hit) return;
        if (!minion || minion.dead) return;
        if (p.ownerId && owner && minion.team === owner.team) return;
        const dx = (minion.position.x ?? 0) - p.x;
        const dz = (minion.position.z ?? 0) - p.z;
        const dist2 = dx * dx + dz * dz;
        if (dist2 <= p.radius * p.radius) {
          MinionManager.damageMinion(minion.id, p.damage ?? 5, { attackerId: p.ownerId, cause: p.source || 'AA' });
          hitTargetId = minion.id;
          hitTargetType = 'minion';
          hit = true;
        }
      });
    }

    if (!hit && p.targetType !== 'minion') {
      for (const [id, pl] of Object.entries(players)) {
        if (id === p.ownerId) continue; // pas soi-même
        if (pl.dead) continue;
        if (areAllies(pl, owner)) continue;
        const dx = pl.x - p.x;
        const dz = pl.z - p.z;
        const dist2 = dx*dx + dz*dz;
        if (dist2 <= p.radius * p.radius) {
          applyDamage(id, p.damage ?? 5, p.ownerId, p.source || 'AA');
          hitTargetId = id;
          hitTargetType = 'player';
          hit = true;
          break;
        }
      }
    }

    if (hit) {
      const impact = { x: round2(p.x), y: 0.5, z: round2(p.z) };
      const msg = { id: p.id, ownerId: p.ownerId, targetId: hitTargetId, targetType: hitTargetType, pos: impact };
      logger.netOut('projectileHit', { to: 'all', data: msg });
      io.emit('projectileHit', msg);
    }

    if (hit || p.ttl <= 0) {
      activeProjectiles.splice(i, 1);
    }
  }
}

function applyDamage(targetId, amount, fromId, source) {
  const target = players[targetId];
  if (!target || target.dead) return;

  const attacker = fromId ? players[fromId] : null;
  if (areAllies(target, attacker)) return;

  // track last hitter for death summary
  target.lastHitFrom = fromId;
  target.lastHitSource = source;

  target.hp = Math.max(0, Math.min(target.maxHp, target.hp - amount));
  io.emit('playerDamaged', { id: targetId, hp: target.hp, maxHp: target.maxHp, from: fromId, source });

  if (target.hp === 0) {
    handleDeath(targetId);
  }
}

function handleDeath(id) {
  const p = players[id];
  if (!p || p.dead) return;
  const killerId = p.lastHitFrom || null;
  p.dead = true;
  p.hp = 0;
  io.emit('playerDied', { id, by: p.lastHitFrom || null, source: p.lastHitSource || null });

  if (killerId && killerId !== id) {
    awardKillExperience(killerId, p);
  }

  // Reset victim progression to level 1 baseline
  p.level = 1;
  p.xp = 0;
  p.xpToNext = xpRequiredForLevel(1);
  applyLevelScaling(p, { preserveHpRatio: false });
  p.hp = 0;
  broadcastProgress(p);

  setTimeout(() => {
    applyClassToPlayer(p, p.classId, { resetHp: true });
    p.x = round2(p.spawnX);
    p.z = round2(p.spawnZ);
    p.dead = false;
    io.emit('playerRespawned', { id, x: p.x, z: p.z, hp: p.hp, maxHp: p.maxHp, classId: p.classId, team: p.team });
    broadcastProgress(p);
  }, RESPAWN_MS);
}

module.exports = {
  attach: function(server) {
    const rawClientUrl = process.env.CLIENT_URL || '*';
    const parsedOrigins = rawClientUrl === '*'
      ? '*'
      : rawClientUrl.split(',').map(v => v.trim()).filter(Boolean);

    const originList = parsedOrigins === '*' || parsedOrigins.length === 0 ? '*' : parsedOrigins;
    const corsOrigin = originList === '*' ? '*' : (originList.length === 1 ? originList[0] : originList);
    const corsConfig = {
      origin: corsOrigin
    };
    if (corsOrigin !== '*') {
      corsConfig.credentials = true;
    }

    io = new Server(server, {
      cors: corsConfig
    });

    logger.info('Socket.io CORS configured', { cors: corsConfig });

    MinionManager.init({ io, logger })
      .catch(error => logger.error('Minion manager init error', { error: error.message }));
    loadTurrets().catch(error => logger.error('Turret load error', { error: error.message }));
    ensureGameLoop();

    // Avoid monkey-patching socket.io emit functions to prevent any side-effects on event loop

    io.on('connection', (socket) => {
      logger.netIn('connect', { from: socket.id, data: { address: socket.handshake?.address } });

      // No patching of emit; we'll log specific emissions below as needed
    const player = createPlayerState(socket.id);
    applyClassToPlayer(player, DEFAULT_CLASS_ID, { resetHp: true });
    player.team = pickTeam();
    players[socket.id] = player;

      const connectedPlayers = Object.values(players).map(serializePlayer);
      logger.netOut('playersList', { to: socket.id, data: connectedPlayers });
      socket.emit('playersList', connectedPlayers);
    socket.emit('teamAssignment', { id: socket.id, team: player.team });
    socket.broadcast.emit('teamAssignment', { id: socket.id, team: player.team });
    broadcastProgress(player, { targetSocket: socket });

    MinionManager.handleConnection(socket);

      const joinPayload = serializePlayer(players[socket.id]);
      logger.netOut('playerJoined', { from: socket.id, to: 'broadcast', data: joinPayload });
      socket.broadcast.emit('playerJoined', joinPayload);

    // Auto-attaque => projectile serveur (travel-time) + émission visuelle
    socket.on('autoattack', (data) => {
        // inbound log (sampled if configured)
        logger.netIn('autoattack', { from: socket.id, data });
        const fromId = socket.id;
        const targetId = data && data.targetId;
        const requestedTargetType = typeof data?.targetType === 'string' ? data.targetType : null;
        let targetType = requestedTargetType;
        if (!targetType) {
          targetType = typeof targetId === 'number' ? 'minion' : 'player';
        }
        targetType = targetType === 'minion' ? 'minion' : 'player';
        const from = players[fromId];
        if (!from || from.dead) return;
        let targetPlayer = null;
        let targetMinion = null;
        if (targetType === 'player') {
          targetPlayer = players[targetId];
          if (!targetPlayer || targetPlayer.dead) return;
          if (areAllies(from, targetPlayer)) return;
        } else if (targetType === 'minion' && typeof targetId === 'number') {
          targetMinion = MinionManager.getMinionById(targetId);
          if (!targetMinion || targetMinion.dead || targetMinion.team === from.team) return;
        } else {
          return;
        }

        const payloadPos = data && data.pos;
        if (payloadPos && typeof payloadPos.x === 'number' && typeof payloadPos.z === 'number') {
          from.x = round2(payloadPos.x);
          from.z = round2(payloadPos.z);
        }
        const range = from.aaRange || getClassDefinition(from.classId).stats.autoAttack.range;
        const targetXBase = targetType === 'player' ? (targetPlayer?.x ?? 0) : (targetMinion?.position?.x ?? 0);
        const targetZBase = targetType === 'player' ? (targetPlayer?.z ?? 0) : (targetMinion?.position?.z ?? 0);
        const dx0 = (from.x ?? 0) - targetXBase;
        const dz0 = (from.z ?? 0) - targetZBase;
        const dist2 = dx0*dx0 + dz0*dz0;
        if (dist2 > range * range) return; // hors portée

    const damage = (from.aaDamage ?? 5) + (from.nextAaBonus || 0);
        from.nextAaBonus = 0;

        if ((from.aaType || 'ranged') === 'melee') {
          // Attaque instantanée au corps à corps
          io.emit('autoattack', {
            type: 'melee',
            from: fromId,
            targetType,
            targetId: targetId
          });
          if (targetType === 'player') {
            applyDamage(targetId, damage, fromId, 'AA');
          } else {
            MinionManager.damageMinion(targetId, damage, { attackerId: fromId, cause: 'player-aa' });
          }

      socket.on('setMinionSpawning', ({ enabled } = {}) => {
        const normalized = Boolean(enabled);
        logger.netIn('setMinionSpawning', { from: socket.id, data: { enabled: normalized } });
        MinionManager.setSpawningEnabled(normalized, { source: socket.id });
      });

      socket.on('requestMinionSpawningStatus', () => {
        logger.netIn('requestMinionSpawningStatus', { from: socket.id });
        MinionManager.sendSpawningStatus(socket);
      });
        } else {
          // Attaque à distance avec projectile (travel-time)
          const startX = from.x;
          const startZ = from.z;
          const targetX = targetType === 'player' ? targetPlayer.x : targetMinion.position.x;
          const targetZ = targetType === 'player' ? targetPlayer.z : targetMinion.position.z;
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
            targetType,
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
            targetType,
            homing: true,
            damage,
            source: 'AA'
          });
          startProjectileLoop();
        }
      });

      // Sorts envoyés par le client => validation serveur et broadcast
      socket.on('spellCast', (data) => {
        logger.netIn('spellCast', { from: socket.id, data });
        const fromId = socket.id;
        const from = players[fromId];
        if (!from || from.dead) return;

        const spell = data && data.spell;
        if (!spell) return;

        if (spell === 'Q') {
          const classDef = getClassDefinition(from.classId);
          const qConfig = from.qConfig || (classDef.spells && classDef.spells.Q) || null;
          if (!qConfig) return;

          if (qConfig.type === 'projectile') {
            const dir = data && data.dir ? data.dir : null;
            if (!dir) return;
            const len = Math.hypot(dir.x || 0, dir.z || 0);
            if (len <= 0.0001) return;
            const dx = (dir.x || 0) / len;
            const dz = (dir.z || 0) / len;

            const startX = from.x;
            const startZ = from.z;

            const projectileSpeed = qConfig.projectileSpeed ?? 25;
            const projectileRadius = qConfig.projectileRadius ?? 0.6;
            const projectileTtl = qConfig.projectileTtl ?? 0.3;
            const damage = qConfig.damage ?? 10;

            const payload = {
              spell: 'Q',
              from: fromId,
              classId: from.classId,
              pos: { x: startX, y: 0.5, z: startZ },
              dir: { x: dx, y: 0, z: dz }
            };
            logger.netOut('spellCast', { to: 'all', data: payload });
            io.emit('spellCast', payload);

            activeProjectiles.push({
              ownerId: fromId,
              x: startX,
              z: startZ,
              dx,
              dz,
              speed: projectileSpeed,
              radius: projectileRadius,
              ttl: projectileTtl,
              damage,
              source: 'Q'
            });
            startProjectileLoop();
          } else if (qConfig.type === 'empower') {
            const bonus = qConfig.bonusDamage ?? 0;
            from.nextAaBonus = (from.nextAaBonus || 0) + bonus;
            const payload = { spell: 'Q', from: fromId, classId: from.classId };
            logger.netOut('spellCast', { to: 'all', data: payload });
            io.emit('spellCast', payload);
          }
          return;
        }

        if (spell === 'flash') {
          const MAX_FLASH_DISTANCE = 3;
          const cooldowns = from.summonerCooldowns || (from.summonerCooldowns = {});
          const now = Date.now();
          const cooldownMs = SUMMONER_COOLDOWNS_MS.flash || 0;
          if (cooldownMs > 0) {
            const elapsed = now - (cooldowns.flash || 0);
            if (elapsed < cooldownMs) {
              return;
            }
          }
          const origin = { x: from.x, y: 0.5, z: from.z };
          const rawTarget = data && data.target ? data.target : null;
          const desiredX = rawTarget && typeof rawTarget.x === 'number' ? rawTarget.x : origin.x;
          const desiredZ = rawTarget && typeof rawTarget.z === 'number' ? rawTarget.z : origin.z;
          const offsetX = desiredX - origin.x;
          const offsetZ = desiredZ - origin.z;
          const distance = Math.hypot(offsetX, offsetZ);
          const clampedDistance = Math.min(distance, MAX_FLASH_DISTANCE);
          const normX = distance > 0.0001 ? offsetX / distance : 0;
          const normZ = distance > 0.0001 ? offsetZ / distance : 0;
          const destX = round2(origin.x + normX * clampedDistance);
          const destZ = round2(origin.z + normZ * clampedDistance);

          from.x = destX;
          from.z = destZ;
          cooldowns.flash = now;

          const payload = {
            spell: 'flash',
            from: fromId,
            origin,
            pos: { x: destX, y: 0.5, z: destZ }
          };

          logger.netOut('spellCast', { to: 'all', data: payload });
          io.emit('spellCast', payload);

          socket.broadcast.emit('playerPositionUpdate', { id: fromId, x: destX, z: destZ, teleport: true });
        }
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
        const snapshot = Object.values(players).map(serializePlayer);
        logger.netOut('playersSnapshot', { to: socket.id, data: snapshot });
        socket.emit('playersSnapshot', snapshot);
      });

      socket.on('selectClass', (data = {}) => {
        const requested = typeof data.classId === 'string' ? data.classId : DEFAULT_CLASS_ID;
        const player = players[socket.id];
        if (!player) return;
        const classDef = getClassDefinition(requested);
        if (!CLASS_DEFS[requested]) {
          logger.warn(`Unknown class requested: ${requested}, defaulting to ${classDef.id}`);
        }
        const shouldResetHp = !player.dead && player.hp > 0;
        applyClassToPlayer(player, classDef.id, { resetHp: shouldResetHp });
        if (player.dead) {
          player.hp = 0;
        }
        const payload = { id: player.id, classId: player.classId, hp: player.hp, maxHp: player.maxHp };
        logger.netOut('playerClassChanged', { from: socket.id, to: 'all', data: payload });
        io.emit('playerClassChanged', payload);
        broadcastProgress(player);
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
        const snapshot = Object.values(players).map(serializePlayer);
        io.emit('playersSnapshot', snapshot);
      }, 1000); // every second
    }
  }
};
