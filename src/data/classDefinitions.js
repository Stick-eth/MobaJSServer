const CLASS_DEFS = {
  marksman: {
    id: 'marksman',
    label: 'Tireur',
    stats: {
      maxHp: 1200,
      moveSpeed: 4.5,
      autoAttack: {
        type: 'ranged',
        damage: 55,
        range: 4,
        cooldownMs: 650,
        projectileSpeed: 14,
        projectileRadius: 0.6,
        projectileTtl: 2.0
      }
    },
    spells: {
      Q: {
        type: 'projectile',
        damage: 280,
        projectileSpeed: 25,
        projectileRadius: 0.6,
        projectileTtl: 0.3
      }
    }
  },
  melee: {
    id: 'melee',
    label: 'M\u00eal\u00e9e',
    stats: {
      maxHp: 1200,
      moveSpeed: 4.5,
      autoAttack: {
        type: 'melee',
        damage: 85,
        range: 1.0,
        cooldownMs: 1000,
        projectileSpeed: 0,
        projectileRadius: 1.0,
        projectileTtl: 0
      }
    },
    spells: {
      Q: {
        type: 'empower',
        bonusDamage: 160
      }
    }
  }
};

const DEFAULT_CLASS_ID = 'marksman';

const PLAYER_MELEE_ATTACK_RANGE = CLASS_DEFS.melee.stats.autoAttack.range;
const PLAYER_RANGED_ATTACK_RANGE = CLASS_DEFS.marksman.stats.autoAttack.range;

module.exports = {
  CLASS_DEFS,
  DEFAULT_CLASS_ID,
  PLAYER_MELEE_ATTACK_RANGE,
  PLAYER_RANGED_ATTACK_RANGE
};
