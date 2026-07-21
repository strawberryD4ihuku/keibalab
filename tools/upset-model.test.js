'use strict';

const assert = require('assert');
const UM = require('../lib/upset-model.js');

function row() {
  return {
    field: 4, surface: '芝', distance: 1600, race_class: 'G3',
    horses: [
      {num: 1, odds: 2, marketProb: 0.5, score: 80, form: 80},
      {num: 2, odds: 5, marketProb: 0.2, score: 70, form: 70},
      {num: 3, odds: 10, marketProb: 0.1, score: 60, form: 60},
      {num: 4, odds: 40, marketProb: 0.025, score: 50, form: 50},
    ],
  };
}
const model = theta => ({horseFeatures: ['form'], theta});

assert.deepStrictEqual(UM.encodeRace(row(), ['form']).items.map(x => x.num), [2, 3], '4〜30倍以外を除外できない');

const encoded = UM.encodeRace(row(), ['form']);
const zero = model(new Array(encoded.featureNames.length).fill(0));
const predictions = UM.predictRace(row(), zero);
assert.strictEqual(predictions[0], null);
assert.ok(Math.abs(predictions[1].predictedWinProb - 0.2) < 1e-12, '係数0で市場確率へ戻らない');

const picked = UM.selectPick(row(), zero, 90);
assert.strictEqual(picked.pick.num, 3, '期待回収率最大の穴馬を選べない');
assert.strictEqual(UM.selectPick(row(), zero, 120).pick, null, '閾値未満を見送れない');

console.log('All upset-model tests passed');
