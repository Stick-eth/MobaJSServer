const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const {
  PLAYER_MELEE_ATTACK_RANGE,
  PLAYER_RANGED_ATTACK_RANGE
} = require('../data/classDefinitions');

const TEAM_BLUE = 'blue';
const TEAM_RED = 'red';
const TEAMS = [TEAM_BLUE, TEAM_RED];

const TERRAIN_SIZE = 100;
const LANE_COUNT = 3;

const MINION_BASE_SPEED = 2.6; // units per second
const MINION_SPACING = 1.5; // minimal distance along the path
const MINION_RADIUS = 0.45;
const MINION_MAX_FORCE = 15;
const MINION_DAMPING = 0.94;
const MINION_BROADCAST_INTERVAL_S = 0.1;
const WAVE_INTERVAL_S = 30;
const INITIAL_WAVE_DELAY_S = 5;
const MINION_PROJECTILE_HEIGHT = 0.55;
const PATH_STRAY_THRESHOLD = 4.5;
const MINION_RETARGET_COOLDOWN = 0.5;
const RETARGET_RANGE_MARGIN = 1.1;
const MOVEMENT_SMOOTHING_RATE = 6;
const PLAYER_TARGET_RADIUS = 0.45;
const PLAYER_AGGRO_RADIUS = 4.2;
const PLAYER_AGGRO_RADIUS_SQ = PLAYER_AGGRO_RADIUS * PLAYER_AGGRO_RADIUS;
const PLAYER_DISENGAGE_BUFFER = 1.0;

const PATH_LOOKAHEAD_PIXELS = 30;
const MIN_LOOKAHEAD_WORLD = 1.5;
const PATH_REJOIN_THRESHOLD = 1.2;
const PATH_CORRECTION_WEIGHT = 5.4;

const ALLY_SEPARATION_DISTANCE = MINION_RADIUS * 2.4;
const ENEMY_SEPARATION_DISTANCE = MINION_RADIUS * 2.8;
const ALLY_SEPARATION_WEIGHT = 6.75;
const ENEMY_SEPARATION_WEIGHT = 9.5;

const BASE_VISION_RADIUS = PLAYER_RANGED_ATTACK_RANGE * 1.5;
const ENABLE_MINION_TRAFFIC_LOGS = false;

const STUCK_SPEED_THRESHOLD = 0.25;
const STUCK_TIME_THRESHOLD = 0.45;
const STUCK_SIDE_FORCE = 6;

const CANNON_WAVE_FREQUENCY = 3;
const CANNON_INSERT_INDEX = 3;

const TURRET_TARGET_RADIUS = 1.4;
const TURRET_PROJECTILE_TARGET_HEIGHT = 2.4;

const WALKABLE_MAP_FILE = 'heightmap.png';
const WALKABLE_CLEARANCE_SAMPLES = 16;

const MINION_TYPES = {
  melee: {
    id: 'melee',
    maxHp: 480,
    damage: 12,
    attackRange: (PLAYER_MELEE_ATTACK_RANGE * 0.35 + 0.15) * 1.75,
    detectionRadius: BASE_VISION_RADIUS,
    attackInterval: 0.8,
    speedMultiplier: 1.0,
    radius: 0.48,
    holdDistanceFactor: 0
  },
  ranged: {
    id: 'ranged',
    maxHp: 300,
    damage: 24,
    attackRange: PLAYER_RANGED_ATTACK_RANGE,
  detectionRadius: BASE_VISION_RADIUS,
    attackInterval: 1.5,
    speedMultiplier: 0.95,
    radius: 0.4,
    holdDistanceFactor: 0,
    projectileSpeed: 14
  },
  cannon: {
    id: 'cannon',
    maxHp: 700,
    damage: 40,
    attackRange: PLAYER_RANGED_ATTACK_RANGE,
  detectionRadius: BASE_VISION_RADIUS,
    attackInterval: 1.0,
    speedMultiplier: 0.85,
    radius: 0.58,
    holdDistanceFactor: 0,
    projectileSpeed: 12
  }
};

const DEFAULT_MINION_TYPE = 'melee';
const BASE_WAVE_COMPOSITION = ['melee', 'melee', 'melee', 'ranged', 'ranged', 'ranged'];

const MAP_ROOT = path.resolve(__dirname, '..', 'maps', 'base_map');

const walkableMap = {
  width: 0,
  height: 0,
  data: null
};

const DIRECTIONS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1]
];

const state = {
  ready: false,
  lanes: {
    [TEAM_BLUE]: [],
    [TEAM_RED]: []
  },
  minions: new Map(),
  nextMinionId: 1,
  broadcastTimer: 0,
  waveTimer: 0,
  firstWaveDelay: INITIAL_WAVE_DELAY_S,
  pendingRemovals: [],
  waveCounts: {
    [TEAM_BLUE]: 0,
    [TEAM_RED]: 0
  },
  spawningEnabled: true
};

let ioRef = null;
let loggerRef = null;
let nextMinionProjectileId = 1;

class LinearPath {
  constructor(points) {
    this.points = points;
    this.segments = [];
    this.totalLength = 0;

    let cumulative = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const start = points[i];
      const end = points[i + 1];
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const length = Math.hypot(dx, dz);
      if (length <= 0.0001) {
        continue;
      }
      this.segments.push({
        start,
        end,
        length,
        cumulative
      });
      cumulative += length;
    }
    this.totalLength = cumulative;
  }

  clampDistance(distance) {
    if (this.totalLength <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(distance, this.totalLength));
  }

  getPointAtDistance(distance) {
    if (!this.segments.length) {
      const origin = this.points[0];
      return origin ? { x: origin.x, z: origin.z } : { x: 0, z: 0 };
    }
    const clamped = this.clampDistance(distance);
    for (let i = 0; i < this.segments.length; i += 1) {
      const segment = this.segments[i];
      const endDistance = segment.cumulative + segment.length;
      if (clamped <= endDistance + 1e-6) {
        const factor = segment.length > 0 ? (clamped - segment.cumulative) / segment.length : 0;
        return {
          x: segment.start.x + (segment.end.x - segment.start.x) * factor,
          z: segment.start.z + (segment.end.z - segment.start.z) * factor
        };
      }
    }

    const last = this.segments[this.segments.length - 1];
    return { x: last.end.x, z: last.end.z };
  }

  getTangentAtDistance(distance) {
    if (!this.segments.length) {
      return { x: 0, z: 1 };
    }

    const clamped = this.clampDistance(distance);
    for (let i = 0; i < this.segments.length; i += 1) {
      const segment = this.segments[i];
      const endDistance = segment.cumulative + segment.length;
      if (clamped <= endDistance + 1e-6 || i === this.segments.length - 1) {
        const dx = segment.end.x - segment.start.x;
        const dz = segment.end.z - segment.start.z;
        const len = Math.hypot(dx, dz) || 1;
        return { x: dx / len, z: dz / len };
      }
    }

    const last = this.segments[this.segments.length - 1];
    const dx = last.end.x - last.start.x;
    const dz = last.end.z - last.start.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  }

  projectPoint(point) {
    if (!this.segments.length) {
      const origin = this.points[0];
      if (!origin) {
        return null;
      }
      const dx = point.x - origin.x;
      const dz = point.z - origin.z;
      return {
        point: { x: origin.x, z: origin.z },
        distance: 0,
        dist2: dx * dx + dz * dz
      };
    }

    let best = null;
    for (let i = 0; i < this.segments.length; i += 1) {
      const segment = this.segments[i];
      const vx = segment.end.x - segment.start.x;
      const vz = segment.end.z - segment.start.z;
      const lenSq = segment.length * segment.length;
      if (lenSq <= 0) {
        continue;
      }
      const px = point.x - segment.start.x;
      const pz = point.z - segment.start.z;
      let t = (px * vx + pz * vz) / lenSq;
      t = clamp(t, 0, 1);
      const projX = segment.start.x + vx * t;
      const projZ = segment.start.z + vz * t;
      const dx = point.x - projX;
      const dz = point.z - projZ;
      const dist2 = dx * dx + dz * dz;
      if (!best || dist2 < best.dist2) {
        best = {
          point: { x: projX, z: projZ },
          distance: segment.cumulative + segment.length * t,
          dist2
        };
      }
    }

    return best;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function distanceSquared(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function getMinionType(type) {
  return MINION_TYPES[type] || MINION_TYPES[DEFAULT_MINION_TYPE];
}

function buildWaveComposition(waveIndex) {
  const composition = [...BASE_WAVE_COMPOSITION];
  if (waveIndex > 0 && waveIndex % CANNON_WAVE_FREQUENCY === 0) {
    composition.splice(CANNON_INSERT_INDEX, 0, 'cannon');
  }
  return composition;
}

function uvToWorld(u, v, terrainSize) {
  const half = terrainSize * 0.5;
  const x = (u - 0.5) * terrainSize;
  const z = -(v - 0.5) * terrainSize;
  return {
    x: clamp(x, -half, half),
    z: clamp(z, -half, half)
  };
}

function loadPng(filePath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(new PNG({ filterType: 4 }))
      .on('parsed', function parsed() { resolve(this); })
      .on('error', reject);
  });
}

function locateFirstOpaquePixel(png) {
  const { width, height, data } = png;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      if (alpha > 0) {
        return { x, y };
      }
    }
  }
  return null;
}

function locatePathPixels(png) {
  const { width, height, data } = png;
  const nodes = new Map();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      if (alpha <= 0) {
        continue;
      }
      const key = `${x}:${y}`;
      nodes.set(key, {
        key,
        x,
        y,
        neighbors: []
      });
    }
  }

  nodes.forEach(node => {
    DIRECTIONS.forEach(([dx, dy]) => {
      const nx = node.x + dx;
      const ny = node.y + dy;
      if (nx < 0 || ny < 0 || nx >= png.width || ny >= png.height) {
        return;
      }
      const neighborKey = `${nx}:${ny}`;
      if (nodes.has(neighborKey)) {
        node.neighbors.push(neighborKey);
      }
    });
  });

  return nodes;
}

function findClosestNode(nodes, x, y) {
  let closestKey = null;
  let bestDist = Number.POSITIVE_INFINITY;
  nodes.forEach(node => {
    const dx = node.x - x;
    const dy = node.y - y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      closestKey = node.key;
    }
  });
  return closestKey;
}

function orderNodesFromStart(nodes, startKey) {
  if (!startKey || !nodes.has(startKey)) {
    return Array.from(nodes.values());
  }

  const queue = [startKey];
  const visited = new Set([startKey]);
  const order = [];

  for (let i = 0; i < queue.length; i += 1) {
    const key = queue[i];
    const node = nodes.get(key);
    order.push(node);
    node.neighbors.forEach(nKey => {
      if (visited.has(nKey)) {
        return;
      }
      visited.add(nKey);
      queue.push(nKey);
    });
  }

  return order;
}

async function loadLaneConfig(team, laneIndex) {
  const teamDir = path.join(MAP_ROOT, team);
  const spawnPath = path.join(teamDir, `minionspawn${laneIndex}.png`);
  const lanePath = path.join(teamDir, `minionpath${laneIndex}.png`);

  if (!fs.existsSync(spawnPath)) {
    throw new Error(`Spawn texture missing: ${spawnPath}`);
  }
  if (!fs.existsSync(lanePath)) {
    throw new Error(`Path texture missing: ${lanePath}`);
  }

  const spawnPng = await loadPng(spawnPath);
  const pathPng = await loadPng(lanePath);

  const spawnPixel = locateFirstOpaquePixel(spawnPng);
  if (!spawnPixel) {
    throw new Error(`No spawn pixel found in ${spawnPath}`);
  }

  const spawnU = (spawnPixel.x + 0.5) / spawnPng.width;
  const spawnV = 1 - (spawnPixel.y + 0.5) / spawnPng.height;
  const spawnWorld = uvToWorld(spawnU, spawnV, TERRAIN_SIZE);

  const pathNodes = locatePathPixels(pathPng);
  if (!pathNodes.size) {
    throw new Error(`No path pixels detected in ${lanePath}`);
  }

  const spawnPxOnPathX = Math.round(spawnU * (pathPng.width - 1));
  const spawnPxOnPathY = Math.round((1 - spawnV) * (pathPng.height - 1));
  const startKey = findClosestNode(pathNodes, spawnPxOnPathX, spawnPxOnPathY);

  const orderedNodes = orderNodesFromStart(pathNodes, startKey);
  const worldPoints = [];
  let lastPoint = null;

  orderedNodes.forEach(node => {
    const u = (node.x + 0.5) / pathPng.width;
    const v = 1 - (node.y + 0.5) / pathPng.height;
    const worldPoint = uvToWorld(u, v, TERRAIN_SIZE);
    if (!lastPoint || Math.hypot(worldPoint.x - lastPoint.x, worldPoint.z - lastPoint.z) > 0.05) {
      worldPoints.push(worldPoint);
      lastPoint = worldPoint;
    }
  });

  if (!worldPoints.length) {
    worldPoints.push({ ...spawnWorld });
  } else {
    const first = worldPoints[0];
    const offset = Math.hypot(first.x - spawnWorld.x, first.z - spawnWorld.z);
    if (offset > 0.05) {
      worldPoints.unshift({ ...spawnWorld });
    }
  }

  if (worldPoints.length < 2) {
    worldPoints.push({ ...worldPoints[0] });
  }

  const pathData = new LinearPath(worldPoints);
  if (pathData.totalLength <= 0) {
    throw new Error(`Computed path has zero length for ${lanePath}`);
  }

  const scaleX = TERRAIN_SIZE / pathPng.width;
  const scaleZ = TERRAIN_SIZE / pathPng.height;
  const avgScale = (scaleX + scaleZ) * 0.5;
  const lookAheadWorld = Math.max(MIN_LOOKAHEAD_WORLD, avgScale * PATH_LOOKAHEAD_PIXELS);

  return {
    spawnWorld,
    path: pathData,
    pixelScale: avgScale,
    lookAhead: lookAheadWorld
  };
}

async function loadAllLanes() {
  const loadPromises = [];
  TEAMS.forEach(team => {
    for (let lane = 1; lane <= LANE_COUNT; lane += 1) {
      loadPromises.push(
        loadLaneConfig(team, lane)
          .then(config => ({ team, lane, config }))
      );
    }
  });

  const results = await Promise.all(loadPromises);
  results.forEach(entry => {
    const { team, lane, config } = entry;
    state.lanes[team][lane - 1] = config;
  });
}

async function loadWalkableMap() {
  const mapPath = path.join(MAP_ROOT, WALKABLE_MAP_FILE);
  if (!fs.existsSync(mapPath)) {
    throw new Error(`Walkable map texture missing: ${mapPath}`);
  }
  const png = await loadPng(mapPath);
  walkableMap.width = png.width;
  walkableMap.height = png.height;
  walkableMap.data = Buffer.from(png.data);
}

function worldToWalkablePixel(x, z) {
  const { width, height } = walkableMap;
  if (!width || !height) {
    return { u: -1, v: -1 };
  }
  const half = TERRAIN_SIZE * 0.5;
  const u = Math.floor(((x + half) / TERRAIN_SIZE) * width);
  const v = Math.floor(((z + half) / TERRAIN_SIZE) * height);
  return { u, v };
}

function isPixelWalkable(u, v) {
  const { width, height, data } = walkableMap;
  if (!data || width <= 0 || height <= 0) {
    return true;
  }
  if (u < 0 || v < 0 || u >= width || v >= height) {
    return false;
  }
  const idx = (v * width + u) * 4;
  const value = data[idx];
  return value === 0;
}

function isWalkableWorld(x, z) {
  const { u, v } = worldToWalkablePixel(x, z);
  return isPixelWalkable(u, v);
}

function isWalkableWithClearance(x, z, clearance = 0) {
  if (!isWalkableWorld(x, z)) {
    return false;
  }
  if (!clearance || clearance <= 0) {
    return true;
  }
  for (let i = 0; i < WALKABLE_CLEARANCE_SAMPLES; i += 1) {
    const angle = (i / WALKABLE_CLEARANCE_SAMPLES) * Math.PI * 2;
    const offsetX = Math.cos(angle) * clearance;
    const offsetZ = Math.sin(angle) * clearance;
    if (!isWalkableWorld(x + offsetX, z + offsetZ)) {
      return false;
    }
  }
  return true;
}

function serializeMinion(minion) {
  return {
    id: minion.id,
    team: minion.team,
    lane: minion.lane,
    type: minion.type,
    x: round2(minion.position.x),
    z: round2(minion.position.z),
    vx: round2(minion.velocity?.x || 0),
    vz: round2(minion.velocity?.z || 0),
    speed: round2(minion.speed || MINION_BASE_SPEED),
    hp: Math.max(0, Math.round(minion.hp ?? 0)),
    maxHp: Math.max(1, Math.round(minion.maxHp ?? 1)),
    targetId: minion.target?.type === 'minion' ? minion.target.id : null,
    targetPlayerId: minion.target?.type === 'player' ? minion.target.id : null,
    targetType: minion.target?.type || null,
    arrived: Boolean(minion.arrived)
  };
}

function queueMinionRemoval(minion, options = {}) {
  if (!minion || minion.dead) {
    return;
  }
  minion.dead = true;
  state.minions.delete(minion.id);
  state.pendingRemovals.push({
    id: minion.id,
    team: minion.team,
    lane: minion.lane,
    type: minion.type,
    cause: options.cause || 'combat',
    killerId: options.killerId || null
  });
}

function broadcastRemovals(removals) {
  if (!ioRef || !removals.length) {
    return;
  }
  const payload = { ids: removals.map(r => r.id), details: removals };
  if (ENABLE_MINION_TRAFFIC_LOGS) {
    loggerRef?.netOut('minionsRemoved', { to: 'all', data: payload });
  }
  ioRef.emit('minionsRemoved', payload);
}

function broadcastMinionProjectile(minion, targetState) {
  if (!ioRef || !minion || !targetState || !targetState.entity) {
    return;
  }

  const { entity, type } = targetState;
  const origin = {
    x: round2(minion.position.x),
    y: round2(MINION_PROJECTILE_HEIGHT),
    z: round2(minion.position.z)
  };

  const extractPosition = (source, fallbackX, fallbackZ) => {
    if (source) {
      if (typeof source.x === 'number' && typeof source.z === 'number') {
        return { x: source.x, z: source.z };
      }
      if (source.position && typeof source.position.x === 'number' && typeof source.position.z === 'number') {
        return { x: source.position.x, z: source.position.z };
      }
    }
    return { x: fallbackX, z: fallbackZ };
  };

  const { x: destX, z: destZ } = extractPosition(entity, minion.position.x, minion.position.z);
  let destinationY = MINION_PROJECTILE_HEIGHT;
  let targetId = null;

  if (type === 'turret') {
    destinationY = round2(entity.projectileTargetHeight || TURRET_PROJECTILE_TARGET_HEIGHT);
    targetId = entity.uid ?? entity.id ?? null;
  } else {
    destinationY = round2(entity.projectileTargetHeight || MINION_PROJECTILE_HEIGHT);
    targetId = entity.id ?? null;
  }

  const destination = {
    x: round2(destX),
    y: destinationY,
    z: round2(destZ)
  };

  const projectileId = nextMinionProjectileId++;
  const speed = Math.max(1, minion.projectileSpeed || 12);

  const payload = {
    id: projectileId,
    fromId: minion.id,
    fromTeam: minion.team,
    type: minion.type,
    origin,
    destination,
    targetType: type,
    targetId,
    speed
  };

  if (ENABLE_MINION_TRAFFIC_LOGS) {
    loggerRef?.netOut('minionProjectile', { to: 'all', data: payload });
  }
  ioRef.emit('minionProjectile', payload);
}

function hasProjectile(minion) {
  return typeof minion?.projectileSpeed === 'number' && minion.projectileSpeed > 0;
}

function performMinionAttack(minion, targetState, handlers = {}) {
  if (!minion || !targetState || !targetState.entity) {
    return false;
  }

  if (hasProjectile(minion)) {
    broadcastMinionProjectile(minion, targetState);
  }

  const targetEntity = targetState.entity;
  const attackDamage = Math.max(0, minion.damage || 0);

  if (targetState.type === 'minion') {
    const killed = applyDamageToMinion(minion, targetEntity, attackDamage, { cause: 'combat' });
    if (killed) {
      clearMinionTarget(minion);
      minion.mode = 'path';
    }
  } else if (targetState.type === 'player') {
    if (typeof handlers.damagePlayer === 'function' && typeof targetEntity.id !== 'undefined') {
      handlers.damagePlayer(targetEntity.id, attackDamage, `minion:${minion.id}`, 'minion');
    }
  } else if (targetState.type === 'turret') {
    if (typeof handlers.damageTurret === 'function') {
      const turretId = targetEntity.uid ?? minion.target?.id;
      const result = handlers.damageTurret(turretId, attackDamage, {
        attackerId: minion.id,
        source: 'minion'
      });
      if (result?.destroyed) {
        clearMinionTarget(minion);
        minion.mode = 'path';
      }
    }
  }

  minion.attackTimer = minion.attackInterval;
  return true;
}

function sendSpawningStatus(targetSocket = null) {
  const payload = { enabled: Boolean(state.spawningEnabled) };
  if (targetSocket && typeof targetSocket.emit === 'function') {
    targetSocket.emit('minionSpawningStatus', payload);
  } else if (ioRef) {
    ioRef.emit('minionSpawningStatus', payload);
  }
}

function removeAllMinions(cause = 'disabled') {
  const removals = [];
  state.minions.forEach((minion) => {
    removals.push({
      id: minion.id,
      team: minion.team,
      lane: minion.lane,
      type: minion.type,
      cause,
      killerId: null
    });
  });
  state.minions.clear();
  if (state.pendingRemovals.length) {
    removals.push(...state.pendingRemovals.splice(0, state.pendingRemovals.length));
  }
  return removals;
}

function setSpawningEnabled(value, { source } = {}) {
  const enabled = Boolean(value);
  if (enabled === state.spawningEnabled) {
    sendSpawningStatus();
    return;
  }

  state.spawningEnabled = enabled;
  state.waveTimer = 0;
  state.broadcastTimer = 0;
  state.firstWaveDelay = INITIAL_WAVE_DELAY_S;
  state.waveCounts[TEAM_BLUE] = 0;
  state.waveCounts[TEAM_RED] = 0;

  if (!enabled) {
    const removals = removeAllMinions('disabled');
    if (removals.length) {
      broadcastRemovals(removals);
    }
    loggerRef?.info('Minion spawning disabled', { source: source || null });
  } else {
    loggerRef?.info('Minion spawning enabled', { source: source || null });
  }

  sendSpawningStatus();
}

function isSpawningEnabled() {
  return Boolean(state.spawningEnabled);
}

function applyDamageToMinion(attacker, target, amount, { cause = 'combat', killerId = null } = {}) {
  if (!target || target.dead) {
    return false;
  }
  const damage = Math.max(0, amount || 0);
  if (damage <= 0) {
    return false;
  }
  target.hp = Math.max(0, (target.hp ?? target.maxHp) - damage);
  if (target.hp === 0) {
    const killer = killerId !== null ? killerId : (attacker?.id || null);
    queueMinionRemoval(target, { cause, killerId: killer });
    return true;
  }
  return false;
}

function broadcastSnapshot(target) {
  if (!ioRef) {
    return;
  }
  const payload = {
    minions: Array.from(state.minions.values()).map(serializeMinion)
  };
  if (target) {
    if (ENABLE_MINION_TRAFFIC_LOGS) {
      loggerRef?.netOut('minionSnapshot', { to: target.id, data: payload });
    }
    target.emit('minionSnapshot', payload);
  } else {
    if (ENABLE_MINION_TRAFFIC_LOGS) {
      loggerRef?.netOut('minionSnapshot', { to: 'all', data: payload });
    }
    ioRef.emit('minionSnapshot', payload);
  }
}

function broadcastSpawn(minions) {
  if (!ioRef || !minions.length) {
    return;
  }
  const payload = {
    minions: minions.map(serializeMinion)
  };
  if (ENABLE_MINION_TRAFFIC_LOGS) {
    loggerRef?.netOut('minionsSpawned', { to: 'all', data: payload });
  }
  ioRef.emit('minionsSpawned', payload);
}

function broadcastUpdates() {
  if (!ioRef || !state.minions.size) {
    return;
  }
  const payload = {
    minions: Array.from(state.minions.values()).map(serializeMinion)
  };
  ioRef.emit('minionsUpdated', payload);
}

function createMinion({ team, lane, type, path, baseDistance, lookAhead }) {
  const typeDef = getMinionType(type);
  const clamped = path.clampDistance(baseDistance);
  const position = path.getPointAtDistance(clamped);
  const id = state.nextMinionId;
  state.nextMinionId += 1;
  return {
    id,
    team,
    lane,
    type: typeDef.id,
    path,
    distance: clamped,
    speed: MINION_BASE_SPEED * (typeDef.speedMultiplier || 1),
    radius: typeDef.radius ?? MINION_RADIUS,
    position: { ...position },
    velocity: { x: 0, z: 0 },
    stuckTimer: 0,
    lookAhead: Math.max(lookAhead || MIN_LOOKAHEAD_WORLD, MIN_LOOKAHEAD_WORLD),
    maxHp: typeDef.maxHp,
    hp: typeDef.maxHp,
    damage: typeDef.damage,
    attackRange: typeDef.attackRange,
    detectionRadius: typeDef.detectionRadius,
    attackInterval: typeDef.attackInterval,
    attackTimer: 0,
    holdDistanceFactor: typeDef.holdDistanceFactor ?? 0.75,
    projectileSpeed: typeDef.projectileSpeed || 0,
    retargetCooldown: 0,
    targetId: null,
    targetPlayerId: null,
  targetTurretId: null,
    target: null,
    mode: 'path',
    arrived: path.totalLength > 0 && clamped >= path.totalLength - 0.05,
    dead: false,
    anchored: false
  };
}

function spawnWaveForTeam(team) {
  const lanes = state.lanes[team];
  if (!lanes || !lanes.length) {
    return;
  }

  state.waveCounts[team] = (state.waveCounts[team] || 0) + 1;
  const composition = buildWaveComposition(state.waveCounts[team]);

  const spawned = [];
  lanes.forEach((laneConfig, index) => {
    if (!laneConfig?.path) {
      return;
    }
    const slots = composition.length;
    composition.forEach((typeKey, slotIndex) => {
      const frontOffset = Math.max(0, (slots - 1 - slotIndex) * MINION_SPACING);
      const minion = createMinion({
        team,
        lane: index + 1,
        type: typeKey,
        path: laneConfig.path,
        baseDistance: frontOffset,
        lookAhead: laneConfig.lookAhead
      });
      // adjust id increment (createMinion increments after creation)
      state.minions.set(minion.id, minion);
      spawned.push(minion);
    });
  });

  if (spawned.length) {
    broadcastSpawn(spawned);
  }
}

function limitVector(vec, maxLength) {
  const length = Math.hypot(vec.x, vec.z);
  if (length <= maxLength || length === 0) {
    return vec;
  }
  const scale = maxLength / length;
  vec.x *= scale;
  vec.z *= scale;
  return vec;
}

function advanceMinions(dt, playersMap = {}, damagePlayer, extra = {}) {
  if (!state.minions.size) {
    return;
  }

  const damageTurretFn = typeof extra.damageTurret === 'function' ? extra.damageTurret : null;
  const getTurretsForTeamFn = typeof extra.getAttackableTurretsForTeam === 'function'
    ? extra.getAttackableTurretsForTeam
    : null;
  const turretStateLookup = typeof extra.getTurretState === 'function' ? extra.getTurretState : null;
  const attackHandlers = {
    damagePlayer,
    damageTurret: damageTurretFn
  };

  const attackableTurretsCache = getTurretsForTeamFn
    ? {
        [TEAM_BLUE]: getTurretsForTeamFn(TEAM_BLUE) || [],
        [TEAM_RED]: getTurretsForTeamFn(TEAM_RED) || []
      }
    : null;

  const minionList = Array.from(state.minions.values());

  minionList.forEach(minion => {
    if (!minion.velocity) {
      minion.velocity = { x: 0, z: 0 };
    }
    minion.attackTimer = Math.max(0, (minion.attackTimer || 0) - dt);
    minion.retargetCooldown = Math.max(0, (minion.retargetCooldown || 0) - dt);
    if (minion.arrived) {
      minion.velocity.x = 0;
      minion.velocity.z = 0;
    }
    if (minion.dead || minion.arrived) {
      minion.smoothedVelocity = null;
      clearMinionTarget(minion);
      return;
    }
    const targetState = getMinionTargetState(minion, playersMap, turretStateLookup);
    if (!targetState) {
      clearMinionTarget(minion);
      if (minion.mode === 'engage') {
        minion.mode = 'path';
      }
    }
  });

  minionList.forEach(minion => {
    if (minion.dead || minion.arrived) {
      return;
    }
    const detection = Math.max(minion.detectionRadius || 0, minion.attackRange || 0);
    const detectionSq = detection * detection;
    const playerAggro = Math.min(PLAYER_AGGRO_RADIUS, detection);
    const playerAggroSq = Math.min(PLAYER_AGGRO_RADIUS_SQ, detectionSq);

    let targetState = getMinionTargetState(minion, playersMap, turretStateLookup);
    if (targetState) {
      const targetPos = targetState.type === 'minion'
        ? targetState.entity.position
        : targetState.type === 'player'
          ? { x: targetState.entity.x, z: targetState.entity.z }
          : targetState.entity.position;
      const distSq = distanceSquared(minion.position.x, minion.position.z, targetPos.x, targetPos.z);
      if (distSq > detectionSq) {
        targetState = null;
      }
    }

    let closestTurret = null;
    if (attackableTurretsCache) {
      const available = attackableTurretsCache[minion.team] || [];
      available.forEach(turret => {
        const distSq = distanceSquared(minion.position.x, minion.position.z, turret.position.x, turret.position.z);
        if (distSq > detectionSq) {
          return;
        }
        if (!closestTurret || distSq < closestTurret.distSq) {
          closestTurret = { turret, distSq };
        }
      });
    }

    if (closestTurret) {
      if (!(targetState && targetState.type === 'player')) {
        if (!targetState || targetState.type !== 'turret' || targetState.entity.uid !== closestTurret.turret.uid) {
          setMinionTarget(minion, { type: 'turret', id: closestTurret.turret.uid });
        }
        minion.mode = 'engage';
        minion.retargetCooldown = MINION_RETARGET_COOLDOWN;
        return;
      }
    }

    let closestMinion = null;
    let closestMinionDistSq = Number.POSITIVE_INFINITY;
    minionList.forEach(other => {
      if (other === minion || other.dead || other.team === minion.team) {
        return;
      }
      const distSq = distanceSquared(minion.position.x, minion.position.z, other.position.x, other.position.z);
      if (distSq > detectionSq) {
        return;
      }
      if (distSq < closestMinionDistSq) {
        closestMinion = other;
        closestMinionDistSq = distSq;
      }
    });

    if (closestMinion && !(targetState && targetState.type === 'player')) {
      if (!targetState || targetState.type !== 'minion' || targetState.entity.id !== closestMinion.id) {
        setMinionTarget(minion, { type: 'minion', id: closestMinion.id });
      }
      minion.mode = 'engage';
      minion.retargetCooldown = MINION_RETARGET_COOLDOWN;
      return;
    }

    if (targetState && (targetState.type === 'player' || targetState.type === 'turret')) {
      minion.mode = 'engage';
      return;
    }

    let closestPlayer = null;
    let closestPlayerDistSq = Number.POSITIVE_INFINITY;
    Object.values(playersMap).forEach(player => {
      if (!player || player.dead || !player.team || player.team === minion.team) {
        return;
      }
      const distSq = distanceSquared(minion.position.x, minion.position.z, player.x, player.z);
      if (distSq > playerAggroSq) {
        return;
      }
      if (distSq < closestPlayerDistSq) {
        closestPlayer = player;
        closestPlayerDistSq = distSq;
      }
    });

    if (closestPlayer) {
      setMinionTarget(minion, { type: 'player', id: closestPlayer.id });
      minion.mode = 'engage';
      minion.retargetCooldown = MINION_RETARGET_COOLDOWN;
    } else {
      clearMinionTarget(minion);
      minion.mode = 'path';
    }
  });

  minionList.forEach(minion => {
    if (minion.dead || minion.arrived) {
      return;
    }

    const targetState = getMinionTargetState(minion, playersMap, turretStateLookup);
    const targetEntity = targetState?.entity || null;
    const targetType = targetState?.type || null;
    let engaged = Boolean(targetEntity && minion.mode === 'engage');
    const selfRadius = minion.radius || MINION_RADIUS;

    const pathProjection = minion.path.projectPoint(minion.position);
    if (pathProjection && Number.isFinite(pathProjection.distance)) {
      minion.distance = Math.max(minion.distance, pathProjection.distance - 0.2);
    }

    let deviation = pathProjection ? Math.sqrt(pathProjection.dist2) : 0;

    if (deviation > PATH_STRAY_THRESHOLD) {
      clearMinionTarget(minion);
      engaged = false;
      minion.mode = 'path';
      minion.retargetCooldown = Math.max(minion.retargetCooldown, MINION_RETARGET_COOLDOWN * 0.5);
    }

    const lookAhead = !engaged && deviation <= PATH_REJOIN_THRESHOLD
      ? Math.max(minion.lookAhead * 0.5, MIN_LOOKAHEAD_WORLD)
      : minion.lookAhead;

    const targetDistance = engaged
      ? minion.distance
      : minion.path.clampDistance(minion.distance + lookAhead);

    const targetPoint = (engaged && targetEntity)
      ? (targetType === 'minion'
        ? { x: targetEntity.position.x, z: targetEntity.position.z }
        : targetType === 'player'
          ? { x: targetEntity.x, z: targetEntity.z }
          : { x: targetEntity.position.x, z: targetEntity.position.z })
      : minion.path.getPointAtDistance(targetDistance);

    let desiredDir = { x: 0, z: 1 };
    const toTarget = {
      x: targetPoint.x - minion.position.x,
      z: targetPoint.z - minion.position.z
    };
    const toTargetLen = Math.hypot(toTarget.x, toTarget.z);
    const targetRadius = targetType === 'minion'
      ? (targetEntity?.radius || MINION_RADIUS)
      : targetType === 'player'
        ? PLAYER_TARGET_RADIUS
        : (targetEntity?.radius || TURRET_TARGET_RADIUS);
    const effectiveRange = engaged && targetEntity
      ? minion.attackRange + selfRadius + targetRadius * 0.5
      : 0;
    const anchoredInCombat = engaged && targetEntity
      ? toTargetLen <= Math.max(effectiveRange * 0.98, selfRadius * 1.1)
      : false;
    minion.anchored = anchoredInCombat;

    const maxSpeed = minion.speed;

    if (engaged && targetEntity) {
      const dist = toTargetLen || 0.0001;
      const norm = { x: toTarget.x / dist, z: toTarget.z / dist };
      const holdRange = (minion.holdDistanceFactor > 0 && effectiveRange > 0)
        ? effectiveRange * minion.holdDistanceFactor
        : 0;

      if (dist > effectiveRange * 0.92) {
        desiredDir = norm;
      } else if (holdRange > 0 && dist < holdRange) {
        desiredDir = { x: -norm.x, z: -norm.z };
      } else {
        desiredDir = { x: 0, z: 0 };
      }
      deviation = 0;
    } else if (toTargetLen > 1e-4) {
      desiredDir = { x: toTarget.x / toTargetLen, z: toTarget.z / toTargetLen };
    } else {
      desiredDir = minion.path.getTangentAtDistance(targetDistance);
    }

    const rawDesiredVelocity = {
      x: desiredDir.x * maxSpeed,
      z: desiredDir.z * maxSpeed
    };
    const smoothingBlend = clamp(dt * MOVEMENT_SMOOTHING_RATE, 0, 1);
    if (!minion.smoothedVelocity) {
      minion.smoothedVelocity = { x: rawDesiredVelocity.x, z: rawDesiredVelocity.z };
    } else {
      minion.smoothedVelocity.x += (rawDesiredVelocity.x - minion.smoothedVelocity.x) * smoothingBlend;
      minion.smoothedVelocity.z += (rawDesiredVelocity.z - minion.smoothedVelocity.z) * smoothingBlend;
    }

    const desiredVelocity = minion.smoothedVelocity;

    const steer = limitVector({
      x: desiredVelocity.x - minion.velocity.x,
      z: desiredVelocity.z - minion.velocity.z
    }, MINION_MAX_FORCE);

    const force = {
      x: steer.x,
      z: steer.z
    };

    if (!engaged && pathProjection && pathProjection.point && deviation > 0.01) {
      const toPath = {
        x: pathProjection.point.x - minion.position.x,
        z: pathProjection.point.z - minion.position.z
      };
      const correctionScale = Math.min(1.0, deviation / PATH_REJOIN_THRESHOLD);
      force.x += toPath.x * PATH_CORRECTION_WEIGHT * correctionScale;
      force.z += toPath.z * PATH_CORRECTION_WEIGHT * correctionScale;
    }

    let closestEnemy = Number.POSITIVE_INFINITY;

    minionList.forEach(other => {
      if (other === minion || other.dead) {
        return;
      }
      const dx = minion.position.x - other.position.x;
      const dz = minion.position.z - other.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= 1e-5) {
        return;
      }
      const otherRadius = other.radius || MINION_RADIUS;
      const baseGap = selfRadius + otherRadius + 0.1;
      let desiredGap = other.team === minion.team ? ALLY_SEPARATION_DISTANCE : ENEMY_SEPARATION_DISTANCE;
      if (other.team !== minion.team && dist < closestEnemy) {
        closestEnemy = dist;
      }
      if (other.team !== minion.team && (minion.anchored || other.anchored)) {
        desiredGap = baseGap;
      }
      const range = Math.max(desiredGap, baseGap);
      if (dist >= range) {
        return;
      }
      const overlap = range - dist;
      let weight = other.team === minion.team ? ALLY_SEPARATION_WEIGHT : ENEMY_SEPARATION_WEIGHT;
      if (other.team !== minion.team && (minion.anchored || other.anchored)) {
        weight *= (minion.anchored && other.anchored) ? 0.05 : 0.2;
      }
      const pushStrength = weight * (overlap / range);
      force.x += (dx / dist) * pushStrength;
      force.z += (dz / dist) * pushStrength;
    });

    const speed = Math.hypot(minion.velocity.x, minion.velocity.z);
    if (closestEnemy < ENEMY_SEPARATION_DISTANCE && speed < STUCK_SPEED_THRESHOLD) {
      minion.stuckTimer = (minion.stuckTimer || 0) + dt;
      if (minion.stuckTimer > STUCK_TIME_THRESHOLD) {
        const tangent = minion.path.getTangentAtDistance(minion.distance);
        const lateral = { x: -tangent.z, z: tangent.x };
        const sideSign = ((minion.id % 2 === 0) ? 1 : -1) * (minion.team === TEAM_BLUE ? 1 : -1);
        force.x += lateral.x * STUCK_SIDE_FORCE * sideSign;
        force.z += lateral.z * STUCK_SIDE_FORCE * sideSign;
      }
    } else {
      minion.stuckTimer = 0;
    }

    const finalForce = limitVector(force, MINION_MAX_FORCE);

    minion.velocity.x += finalForce.x * dt;
    minion.velocity.z += finalForce.z * dt;

    minion.velocity.x *= MINION_DAMPING;
    minion.velocity.z *= MINION_DAMPING;

    const velMag = Math.hypot(minion.velocity.x, minion.velocity.z);
    if (velMag > maxSpeed) {
      const clampScale = maxSpeed / velMag;
      minion.velocity.x *= clampScale;
      minion.velocity.z *= clampScale;
    }

    const halfSize = TERRAIN_SIZE * 0.5;
    const prevX = minion.position.x;
    const prevZ = minion.position.z;
    let nextX = clamp(prevX + minion.velocity.x * dt, -halfSize, halfSize);
    let nextZ = clamp(prevZ + minion.velocity.z * dt, -halfSize, halfSize);
    if (!isWalkableWithClearance(nextX, nextZ, selfRadius)) {
      const canMoveX = isWalkableWithClearance(nextX, prevZ, selfRadius);
      const canMoveZ = isWalkableWithClearance(prevX, nextZ, selfRadius);
      if (canMoveX && !canMoveZ) {
        nextZ = prevZ;
        minion.velocity.z = 0;
      } else if (!canMoveX && canMoveZ) {
        nextX = prevX;
        minion.velocity.x = 0;
      } else if (canMoveX && canMoveZ) {
        if (Math.abs(nextX - prevX) > Math.abs(nextZ - prevZ)) {
          nextX = prevX;
          minion.velocity.x = 0;
        } else {
          nextZ = prevZ;
          minion.velocity.z = 0;
        }
      } else {
        nextX = prevX;
        nextZ = prevZ;
        minion.velocity.x = 0;
        minion.velocity.z = 0;
      }
    }
    minion.position.x = nextX;
    minion.position.z = nextZ;

    const updatedProjection = minion.path.projectPoint(minion.position);
    if (updatedProjection) {
      minion.distance = Math.max(minion.distance, updatedProjection.distance);
    }

    minion.distance = minion.path.clampDistance(minion.distance);

    const remaining = minion.path.totalLength - minion.distance;
    if (!engaged && remaining <= 0.3) {
      const goal = minion.path.getPointAtDistance(minion.path.totalLength);
      const goalDist = Math.hypot(minion.position.x - goal.x, minion.position.z - goal.z);
      if (goalDist <= 0.4) {
        minion.position.x = goal.x;
        minion.position.z = goal.z;
        minion.velocity.x = 0;
        minion.velocity.z = 0;
        minion.arrived = true;
      }
    }
  });

  minionList.forEach(minion => {
    if (minion.dead || minion.arrived) {
      return;
    }
    const targetState = getMinionTargetState(minion, playersMap, turretStateLookup);
    if (!targetState) {
      clearMinionTarget(minion);
      minion.mode = 'path';
      return;
    }
    const targetEntity = targetState.entity;
    const targetType = targetState.type;
    if (!targetEntity || (targetType === 'player' && (targetEntity.dead || targetEntity.team === minion.team))) {
      clearMinionTarget(minion);
      minion.mode = 'path';
      return;
    }

    const targetPos = targetType === 'minion'
      ? targetEntity.position
      : targetType === 'player'
        ? { x: targetEntity.x, z: targetEntity.z }
        : targetType === 'turret' && targetEntity.position
          ? targetEntity.position
          : { x: targetEntity.position?.x ?? targetEntity.x, z: targetEntity.position?.z ?? targetEntity.z };
    const dist = Math.hypot(targetPos.x - minion.position.x, targetPos.z - minion.position.z);
    const detection = Math.max(minion.detectionRadius || 0, minion.attackRange || 0);
    const disengageRange = targetType === 'player'
      ? Math.max(minion.attackRange + PLAYER_DISENGAGE_BUFFER, detection)
      : detection;
    if (dist > disengageRange) {
      clearMinionTarget(minion);
      minion.mode = 'path';
      return;
    }

    const targetRadius = targetType === 'minion'
      ? (targetEntity.radius || MINION_RADIUS)
      : targetType === 'turret'
        ? (targetEntity.radius || TURRET_TARGET_RADIUS)
        : PLAYER_TARGET_RADIUS;
    const effectiveRange = minion.attackRange + minion.radius + targetRadius * 0.5;
    if (dist <= effectiveRange && (minion.attackTimer || 0) <= 0) {
      performMinionAttack(minion, targetState, attackHandlers);
    }
  });
}

function update(dt, context = {}) {
  if (!state.ready) {
    return;
  }

  if (!state.spawningEnabled) {
    state.waveTimer = 0;
    state.broadcastTimer = 0;
    return;
  }

  if (state.firstWaveDelay > 0) {
    state.firstWaveDelay = Math.max(0, state.firstWaveDelay - dt);
    if (state.firstWaveDelay === 0) {
      TEAMS.forEach(spawnWaveForTeam);
    }
  } else {
    state.waveTimer += dt;
    while (state.waveTimer >= WAVE_INTERVAL_S) {
      state.waveTimer -= WAVE_INTERVAL_S;
      TEAMS.forEach(spawnWaveForTeam);
    }
  }

  const playersMap = context.players || {};
  const damagePlayer = typeof context.damagePlayer === 'function' ? context.damagePlayer : null;

  advanceMinions(dt, playersMap, damagePlayer, {
    damageTurret: typeof context.damageTurret === 'function' ? context.damageTurret : null,
    getAttackableTurretsForTeam: typeof context.getAttackableTurretsForTeam === 'function'
      ? context.getAttackableTurretsForTeam
      : null,
    getTurretState: typeof context.getTurretState === 'function' ? context.getTurretState : null
  });

  if (state.pendingRemovals.length) {
    const removals = state.pendingRemovals.splice(0, state.pendingRemovals.length);
    broadcastRemovals(removals);
  }

  state.broadcastTimer += dt;
  if (state.broadcastTimer >= MINION_BROADCAST_INTERVAL_S) {
    state.broadcastTimer = 0;
    broadcastUpdates();
  }
}

async function init({ io, logger }) {
  ioRef = io;
  loggerRef = logger;
  try {
    await Promise.all([
      loadAllLanes(),
      loadWalkableMap()
    ]);
    state.ready = true;
    loggerRef?.info('Minion manager ready', {
      lanes: {
        blue: state.lanes.blue.length,
        red: state.lanes.red.length
      }
    });
  } catch (error) {
    state.ready = false;
    loggerRef?.error('Failed to initialize minion manager', { error: error.message });
  }
}

function getMinionById(id) {
  if (typeof id !== 'number') return null;
  return state.minions.get(id) || null;
}

function forEachMinion(callback) {
  if (typeof callback !== 'function') return;
  state.minions.forEach((minion, id) => {
    callback(minion, id);
  });
}

function damageMinion(minionId, amount, { attackerId = null, cause = 'combat' } = {}) {
  const minion = getMinionById(minionId);
  if (!minion || minion.dead) {
    return { ok: false, killed: false, hp: 0, maxHp: 0 };
  }
  const killed = applyDamageToMinion({ id: attackerId }, minion, amount, { cause, killerId: attackerId });
  return {
    ok: true,
    killed,
    hp: Math.max(0, minion.hp ?? 0),
    maxHp: Math.max(1, minion.maxHp ?? 1)
  };
}

function clearMinionTarget(minion) {
  if (!minion) return;
  minion.target = null;
  minion.targetId = null;
  minion.targetPlayerId = null;
  minion.targetTurretId = null;
}

function setMinionTarget(minion, target) {
  if (!minion) return;
  if (!target || !target.type || target.id === undefined || target.id === null) {
    clearMinionTarget(minion);
    return;
  }
  if (target.type === 'minion') {
    minion.target = { type: 'minion', id: target.id };
    minion.targetId = target.id;
    minion.targetPlayerId = null;
    minion.targetTurretId = null;
  } else if (target.type === 'player') {
    minion.target = { type: 'player', id: target.id };
    minion.targetPlayerId = target.id;
    minion.targetId = null;
    minion.targetTurretId = null;
  } else if (target.type === 'turret') {
    minion.target = { type: 'turret', id: target.id };
    minion.targetTurretId = target.id;
    minion.targetId = null;
    minion.targetPlayerId = null;
  } else {
    clearMinionTarget(minion);
  }
}

function getMinionTargetState(minion, playersMap, turretStateGetter) {
  if (!minion || !minion.target) {
    return null;
  }
  if (minion.target.type === 'minion') {
    const targetMinion = state.minions.get(minion.target.id);
    if (targetMinion && !targetMinion.dead && targetMinion.team !== minion.team) {
      return { type: 'minion', entity: targetMinion };
    }
    return null;
  }
  if (minion.target.type === 'player') {
    if (!playersMap) return null;
    const player = playersMap[minion.target.id];
    if (player && !player.dead && player.team && player.team !== minion.team) {
      return { type: 'player', entity: player };
    }
  }
  if (minion.target.type === 'turret') {
    if (typeof turretStateGetter !== 'function') {
      return null;
    }
    const turret = turretStateGetter(minion.target.id);
    if (turret && !turret.destroyed && turret.team !== minion.team && turret.attackable) {
      return {
        type: 'turret',
        entity: {
          uid: turret.uid,
          team: turret.team,
          position: { x: turret.position.x, z: turret.position.z },
          radius: turret.hitRadius || TURRET_TARGET_RADIUS,
          hp: turret.hp,
          maxHp: turret.maxHp
        }
      };
    }
    return null;
  }
  return null;
}

// Forces defending team minions within range to target the specified enemy player.
function forceMinionAggroOnPlayer(team, player, { radius = null } = {}) {
  if (!team || !player || !player.id) {
    return 0;
  }
  const posX = Number.isFinite(player.x) ? player.x : 0;
  const posZ = Number.isFinite(player.z) ? player.z : 0;
  let affected = 0;
  state.minions.forEach(minion => {
    if (!minion || minion.dead || minion.arrived || minion.team !== team) {
      return;
    }
    const detection = Math.max(minion.detectionRadius || 0, minion.attackRange || 0);
    if (detection <= 0) {
      return;
    }
    const effectiveRadius = radius && radius > 0 ? Math.min(radius, detection) : detection;
    const dx = minion.position.x - posX;
    const dz = minion.position.z - posZ;
    if ((dx * dx + dz * dz) > effectiveRadius * effectiveRadius) {
      return;
    }
    setMinionTarget(minion, { type: 'player', id: player.id });
    minion.mode = 'engage';
    minion.retargetCooldown = MINION_RETARGET_COOLDOWN;
    minion.anchored = false;
    affected += 1;
  });
  return affected;
}

function handleConnection(socket) {
  if (!state.ready || !socket) {
    return;
  }
  broadcastSnapshot(socket);
  sendSpawningStatus(socket);
  socket.on('requestMinionSnapshot', () => {
    broadcastSnapshot(socket);
  });
}

module.exports = {
  init,
  update,
  handleConnection,
  setSpawningEnabled,
  isSpawningEnabled,
  sendSpawningStatus,
  getMinionById,
  forEachMinion,
  damageMinion,
  forceMinionAggroOnPlayer
};
