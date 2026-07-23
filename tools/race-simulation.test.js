'use strict';

const assert = require('assert');
const Sim = require('../lib/race-simulation.js');

function test(name, fn) {
  try { fn(); console.log(`OK  ${name}`); }
  catch (e) { console.error(`NG  ${name}: ${e.message}`); process.exitCode = 1; }
}

const horses = [
  {num: 1, name: 'アルファ', score: 72, age3f: 34.8},
  {num: 2, name: 'ブラボー', score: 61, age3f: 36.1},
  {num: 3, name: 'チャーリー', score: 48, age3f: 35.4},
  {num: 4, name: 'デルタ', score: 55, age3f: null},
];

test('同じ入力なら同じ仮想脚質と展開を返す', () => {
  assert.deepStrictEqual(Sim.createPlan(horses, 'standard'), Sim.createPlan(horses, 'standard'));
});

test('全頭に表示可能な脚質を割り当てる', () => {
  const plan = Sim.createPlan(horses, 'standard');
  assert.strictEqual(plan.length, horses.length);
  assert.ok(plan.every(h => Sim.STYLES.includes(h.style)));
});

test('ハイペースは追込馬、スローは逃げ馬の終盤を相対的に押し上げる', () => {
  const custom = [
    {num: 1, name: '逃げ', score: 50, runningStyle: '逃げ'},
    {num: 2, name: '追込', score: 50, runningStyle: '追込'},
  ];
  const slow = Sim.createPlan(custom, 'slow');
  const high = Sim.createPlan(custom, 'high');
  const slowGap = Sim.progressFor(slow[1], 0.9) - Sim.progressFor(slow[0], 0.9);
  const highGap = Sim.progressFor(high[1], 0.9) - Sim.progressFor(high[0], 0.9);
  assert.ok(highGap > slowGap);
});

test('途中順位を進行度順で返す', () => {
  const ranked = Sim.rankAt(Sim.createPlan(horses, 'standard'), 0.8);
  assert.strictEqual(ranked.length, horses.length);
  assert.ok(ranked[0].raceProgress >= ranked[1].raceProgress);
});
