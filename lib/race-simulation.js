(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RaceSimulation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STYLES = ['逃げ', '先行', '差し', '追込'];
  const STYLE_WEIGHTS = [1, 4, 4, 3];
  const EARLY_BIAS = {'逃げ': 0.032, '先行': 0.018, '差し': -0.004, '追込': -0.021};
  const LATE_BIAS = {'逃げ': -0.0008, '先行': -0.0002, '差し': 0, '追込': 0.0003};
  const PACE_BIAS = {
    slow: {'逃げ': 0.004, '先行': 0.002, '差し': -0.001, '追込': -0.003},
    standard: {'逃げ': 0, '先行': 0, '差し': 0, '追込': 0},
    high: {'逃げ': -0.008, '先行': -0.003, '差し': 0.003, '追込': 0.007},
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function hashStr(value) {
    const s = String(value || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function styleFromSeed(seed) {
    const total = STYLE_WEIGHTS.reduce((a, b) => a + b, 0);
    let n = seed % total;
    for (let i = 0; i < STYLES.length; i++) {
      if (n < STYLE_WEIGHTS[i]) return STYLES[i];
      n -= STYLE_WEIGHTS[i];
    }
    return '差し';
  }

  function createPlan(horses, pace) {
    const selectedPace = PACE_BIAS[pace] ? pace : 'standard';
    return (horses || []).map((horse, index) => {
      const seedKey = `${horse.name || ''}|${horse.num || index + 1}`;
      // 序盤の位置取りと終盤の伸びを同じ乱数から作ると、
      // 最初に前へ出た馬がそのまま勝ちやすくなるため、要因を分離する。
      const positionSeed = hashStr(`${seedKey}|position`);
      const finishSeed = hashStr(`${seedKey}|finish`);
      const style = horse.runningStyle && STYLES.includes(horse.runningStyle)
        ? horse.runningStyle
        : styleFromSeed(positionSeed);
      const score = clamp(Number(horse.score) || 50, 1, 99);
      const agari = Number(horse.age3f);
      const closing = Number.isFinite(agari) && agari > 0
        ? clamp((36.5 - agari) / 6, -0.5, 0.5)
        : 0;
      const draw = Number(horse.num) || index + 1;
      const positionNoise = ((positionSeed % 1000) / 999 - 0.5) * 0.01;
      const finishNoise = ((finishSeed % 1000) / 999 - 0.5) * 0.008;
      const finishBias = (score - 50) / 50 * 0.025 + closing * 0.012 + finishNoise;
      return {
        ...horse,
        num: draw,
        style,
        seed: positionSeed,
        finishSeed,
        lane: index,
        earlyBias: EARLY_BIAS[style] + positionNoise,
        lateBias: LATE_BIAS[style],
        paceBias: PACE_BIAS[selectedPace][style],
        finishBias,
      };
    });
  }

  function progressFor(entry, raceProgress) {
    const p = clamp(Number(raceProgress) || 0, 0, 1);
    const early = entry.earlyBias * Math.sin(Math.PI * p);
    const pace = entry.paceBias * p * p;
    const latePhase = clamp((p - 0.55) / 0.45, 0, 1);
    const late = entry.lateBias * Math.pow(latePhase, 1.6);
    const finish = entry.finishBias * Math.pow(p, 2.4);
    return clamp(p + early + pace + late + finish, 0, 1.06);
  }

  function rankAt(plan, raceProgress) {
    return (plan || [])
      .map(entry => ({...entry, raceProgress: progressFor(entry, raceProgress)}))
      .sort((a, b) => b.raceProgress - a.raceProgress || a.num - b.num);
  }

  return {STYLES, createPlan, progressFor, rankAt, hashStr};
});
