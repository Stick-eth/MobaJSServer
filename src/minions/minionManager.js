const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const TEAM_BLUE = 'blue';
const TEAM_RED = 'red';
const TEAMS = [TEAM_BLUE, TEAM_RED];

const TERRAIN_SIZE = 100;
const LANE_COUNT = 3;

const MINIONS_PER_WAVE = 6;
const MINION_BASE_SPEED = 2.6; // units per second
const MINION_SPACING = 1.5; // minimal distance along the path
const MINION_RADIUS = 0.55;
const MINION_MAX_FORCE = 18;
const MINION_DAMPING = 0.94;
const MINION_BROADCAST_INTERVAL_S = 0.1;
const WAVE_INTERVAL_S = 30;
const INITIAL_WAVE_DELAY_S = 5;

const PATH_LOOKAHEAD_PIXELS = 30;
const MIN_LOOKAHEAD_WORLD = 1.5;
const PATH_REJOIN_THRESHOLD = 1.2;
const PATH_CORRECTION_WEIGHT = 6.5;

const ALLY_SEPARATION_DISTANCE = MINION_RADIUS * 2.4;
const ENEMY_SEPARATION_DISTANCE = MINION_RADIUS * 2.8;
const ALLY_SEPARATION_WEIGHT = 8;
const ENEMY_SEPARATION_WEIGHT = 13;

const STUCK_SPEED_THRESHOLD = 0.25;
const STUCK_TIME_THRESHOLD = 0.45;
const STUCK_SIDE_FORCE = 6;

const MAP_ROOT = path.resolve(__dirname, '..', 'maps', 'base_map');

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
  firstWaveDelay: INITIAL_WAVE_DELAY_S
};

let ioRef = null;
let loggerRef = null;

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

function serializeMinion(minion) {
  return {
    id: minion.id,
    team: minion.team,
    lane: minion.lane,
    x: round2(minion.position.x),
    z: round2(minion.position.z),
    vx: round2(minion.velocity?.x || 0),
    vz: round2(minion.velocity?.z || 0),
    speed: round2(minion.speed || MINION_BASE_SPEED),
    arrived: Boolean(minion.arrived)
  };
}

function broadcastSnapshot(target) {
  if (!ioRef) {
    return;
  }
  const payload = {
    minions: Array.from(state.minions.values()).map(serializeMinion)
  };
  if (target) {
    loggerRef?.netOut('minionSnapshot', { to: target.id, data: payload });
    target.emit('minionSnapshot', payload);
  } else {
    loggerRef?.netOut('minionSnapshot', { to: 'all', data: payload });
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
  loggerRef?.netOut('minionsSpawned', { to: 'all', data: payload });
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

function createMinion({ team, lane, path, baseDistance, lookAhead }) {
  const clamped = path.clampDistance(baseDistance);
  const position = path.getPointAtDistance(clamped);
  const id = state.nextMinionId;
  state.nextMinionId += 1;
  return {
    id,
    team,
    lane,
    path,
    distance: clamped,
    speed: MINION_BASE_SPEED,
    radius: MINION_RADIUS,
    position: { ...position },
    velocity: { x: 0, z: 0 },
    stuckTimer: 0,
    lookAhead: Math.max(lookAhead || MIN_LOOKAHEAD_WORLD, MIN_LOOKAHEAD_WORLD),
    arrived: path.totalLength > 0 && clamped >= path.totalLength - 0.05
  };
}

function spawnWaveForTeam(team) {
  const lanes = state.lanes[team];
  if (!lanes || !lanes.length) {
    return;
  }

  const spawned = [];
  lanes.forEach((laneConfig, index) => {
    if (!laneConfig?.path) {
      return;
    }
    for (let i = 0; i < MINIONS_PER_WAVE; i += 1) {
      const minion = createMinion({
        team,
        lane: index + 1,
        path: laneConfig.path,
        baseDistance: Math.max(0, i * MINION_SPACING),
        lookAhead: laneConfig.lookAhead
      });
      // adjust id increment (createMinion increments after creation)
      state.minions.set(minion.id, minion);
      spawned.push(minion);
    }
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

function advanceMinions(dt) {
  if (!state.minions.size) {
    return;
  }

  const minionList = Array.from(state.minions.values());

  minionList.forEach(minion => {
    if (!minion.velocity) {
      minion.velocity = { x: 0, z: 0 };
    }
  });

  minionList.forEach(minion => {
    if (minion.arrived) {
      minion.velocity.x = 0;
      minion.velocity.z = 0;
      return;
    }

    const pathProjection = minion.path.projectPoint(minion.position);
    let projectedDistance = minion.distance;
    let deviation = 0;
    if (pathProjection) {
      deviation = Math.sqrt(pathProjection.dist2);
      if (Number.isFinite(pathProjection.distance)) {
        projectedDistance = Math.max(minion.distance, pathProjection.distance - 0.2);
        minion.distance = projectedDistance;
      }
    }

    const lookAhead = deviation > PATH_REJOIN_THRESHOLD
      ? minion.lookAhead
      : Math.max(minion.lookAhead * 0.5, MIN_LOOKAHEAD_WORLD);

    const targetDistance = minion.path.clampDistance(projectedDistance + lookAhead);
    const targetPoint = minion.path.getPointAtDistance(targetDistance);
    const toTarget = {
      x: targetPoint.x - minion.position.x,
      z: targetPoint.z - minion.position.z
    };
    const toTargetLen = Math.hypot(toTarget.x, toTarget.z);
    let desiredDir = { x: 0, z: 1 };
    if (toTargetLen > 1e-4) {
      desiredDir = { x: toTarget.x / toTargetLen, z: toTarget.z / toTargetLen };
    } else {
      desiredDir = minion.path.getTangentAtDistance(targetDistance);
    }

    const maxSpeed = minion.speed;
    const desiredVelocity = {
      x: desiredDir.x * maxSpeed,
      z: desiredDir.z * maxSpeed
    };

    const steer = limitVector({
      x: desiredVelocity.x - minion.velocity.x,
      z: desiredVelocity.z - minion.velocity.z
    }, MINION_MAX_FORCE);

    const force = {
      x: steer.x,
      z: steer.z
    };

    if (pathProjection && pathProjection.point && deviation > 0.01) {
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
      if (other === minion) {
        return;
      }
      const dx = minion.position.x - other.position.x;
      const dz = minion.position.z - other.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= 1e-5) {
        return;
      }
      const range = other.team === minion.team ? ALLY_SEPARATION_DISTANCE : ENEMY_SEPARATION_DISTANCE;
      if (other.team !== minion.team && dist < closestEnemy) {
        closestEnemy = dist;
      }
      if (dist >= range) {
        return;
      }
      const overlap = range - dist;
      const weight = other.team === minion.team ? ALLY_SEPARATION_WEIGHT : ENEMY_SEPARATION_WEIGHT;
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

    minion.position.x += minion.velocity.x * dt;
    minion.position.z += minion.velocity.z * dt;
  const halfSize = TERRAIN_SIZE * 0.5;
  minion.position.x = clamp(minion.position.x, -halfSize, halfSize);
  minion.position.z = clamp(minion.position.z, -halfSize, halfSize);

    const updatedProjection = minion.path.projectPoint(minion.position);
    if (updatedProjection) {
      minion.distance = Math.max(minion.distance, updatedProjection.distance);
    }

    minion.distance = minion.path.clampDistance(minion.distance);

    const remaining = minion.path.totalLength - minion.distance;
    if (remaining <= 0.3) {
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
}

function update(dt) {
  if (!state.ready) {
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

  advanceMinions(dt);

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
    await loadAllLanes();
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

function handleConnection(socket) {
  if (!state.ready || !socket) {
    return;
  }
  broadcastSnapshot(socket);
}

module.exports = {
  init,
  update,
  handleConnection
};
