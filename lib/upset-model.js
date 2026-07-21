'use strict';

const fs = require('fs');
const path = require('path');
const WM = require('./win-model.js');

const MIN_ODDS = 4;
const MAX_ODDS = 30;
const CONTEXT_FEATURES = [
  'scoreZ', 'fieldZ', 'logOddsZ', 'marketRank01', 'marketTopProb', 'marketEntropy',
  'surfaceDirt', 'surfaceObstacle', 'distanceZ',
  'classMaiden', 'classConditions', 'classGraded',
];

const finite = v => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = x => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
const logit = p => Math.log(clamp(p, 1e-9, 1 - 1e-9) / (1 - clamp(p, 1e-9, 1 - 1e-9)));

function entropy(probs) {
  const ps = probs.filter(p => p > 0);
  return ps.length > 1 ? -ps.reduce((s, p) => s + p * Math.log(p), 0) / Math.log(ps.length) : 0;
}

function classFlags(name) {
  const s = String(name || '');
  return {
    classMaiden: /新馬|未勝利/.test(s) ? 1 : 0,
    classConditions: /1勝|2勝|3勝/.test(s) ? 1 : 0,
    classGraded: /G1|G2|G3|重賞|リステッド|L/.test(s) ? 1 : 0,
  };
}

function standardize(values) {
  const valid = values.filter(v => v != null);
  if (!valid.length) return values.map(() => 0);
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sd = Math.sqrt(valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length);
  return values.map(v => v == null || sd < 1e-9 ? 0 : (v - mean) / sd);
}

function encodeRace(row, horseFeatures) {
  const horses = Array.isArray(row && row.horses) ? row.horses : [];
  const feats = horseFeatures || WM.WIN_MODEL_FEATURES;
  const std = WM.standardizeFeaturesInRace(horses, feats);
  const market = horses.map(h => finite(h.marketProb) || 0);
  const order = market.map((p, i) => ({p, i})).sort((a, b) => b.p - a.p);
  const ranks = new Map(order.map((v, i) => [v.i, i + 1]));
  const scoreZ = standardize(horses.map(h => finite(h.score)));
  const ctx = {
    fieldZ: ((finite(row.field) || horses.length) - 12) / 4,
    marketTopProb: order[0] ? order[0].p : 0,
    marketEntropy: entropy(market),
    surfaceDirt: row.surface === 'ダ' ? 1 : 0,
    surfaceObstacle: row.surface === '障' ? 1 : 0,
    distanceZ: ((finite(row.distance) || 1800) - 1800) / 600,
    ...classFlags(row.race_class),
  };
  const names = [
    ...feats.map(f => `z_${f}`),
    ...feats.map(f => `missing_${f}`),
    ...CONTEXT_FEATURES,
  ];
  const items = horses.map((h, i) => {
    const odds = finite(h.odds);
    const p = market[i];
    if (!(odds >= MIN_ODDS && odds <= MAX_ODDS && p > 0)) return null;
    const values = [
      ...feats.map(f => std[i].z[f]),
      ...feats.map(f => std[i].missing[f]),
      scoreZ[i], ctx.fieldZ, (Math.log(odds) - Math.log(10)) / 0.7,
      (ranks.get(i) - 1) / Math.max(1, horses.length - 1),
      ctx.marketTopProb, ctx.marketEntropy, ctx.surfaceDirt, ctx.surfaceObstacle,
      ctx.distanceZ, ctx.classMaiden, ctx.classConditions, ctx.classGraded,
    ];
    return {
      index: i, num: h.num, odds, marketProb: p, base: logit(p), values,
      won: h.won === true || h.rank === 1,
    };
  }).filter(Boolean);
  return {items, featureNames: names};
}

function predictRace(row, model) {
  const horses = Array.isArray(row && row.horses) ? row.horses : [];
  const out = horses.map(() => null);
  if (!model || !Array.isArray(model.horseFeatures) || !Array.isArray(model.theta)) return out;
  const encoded = encodeRace(row, model.horseFeatures);
  for (const item of encoded.items) {
    let z = item.base;
    for (let k = 0; k < item.values.length; k++) z += (model.theta[k] || 0) * item.values[k];
    const p = sigmoid(z);
    out[item.index] = {
      num: item.num, odds: item.odds, marketProb: item.marketProb,
      predictedWinProb: p,
      expectedRoiPercent: p * item.odds * 0.95 * 100,
    };
  }
  return out;
}

function selectPick(row, model, threshold) {
  const minEv = finite(threshold) || finite(model && model.threshold) || 120;
  const predictions = predictRace(row, model).filter(Boolean);
  const eligible = predictions.filter(p => p.expectedRoiPercent >= minEv)
    .sort((a, b) => b.expectedRoiPercent - a.expectedRoiPercent || b.predictedWinProb - a.predictedWinProb || a.num - b.num);
  return {pick: eligible[0] || null, predictions, threshold: minEv};
}

const MODEL_PATH = path.join(__dirname, '..', 'models', 'upset-model.json');
function loadModel(file = MODEL_PATH) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

module.exports = {
  MIN_ODDS, MAX_ODDS, CONTEXT_FEATURES, MODEL_PATH,
  sigmoid, logit, entropy, encodeRace, predictRace, selectPick, loadModel,
};
