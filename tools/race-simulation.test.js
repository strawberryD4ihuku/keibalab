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

test('標準ペースでは同能力の逃げ馬より差し追込馬が終盤に伸びる', () => {
  const custom = [
    {num: 1, name: '逃げ', score: 50, runningStyle: '逃げ'},
    {num: 2, name: '追込', score: 50, runningStyle: '追込'},
  ];
  const plan = Sim.createPlan(custom, 'standard').map(h => ({...h, finishBias: 0}));
  assert.ok(Sim.progressFor(plan[1], 1) > Sim.progressFor(plan[0], 1));
});

test('序盤の位置取り乱数と終盤の伸び乱数を分離する', () => {
  const plan = Sim.createPlan(horses, 'standard');
  assert.ok(plan.every(h => h.seed !== h.finishSeed));
});

test('標準ペースで序盤先頭馬が勝ち続ける偏りを抑える', () => {
  let leaderWins = 0;
  const races = 500;
  for (let race = 0; race < races; race++) {
    const field = Array.from({length: 18}, (_, i) => ({
      num: i + 1,
      name: `race-${race}-horse-${i}`,
      score: 35 + ((race * 17 + i * 13) % 45),
      age3f: 33.5 + ((race * 7 + i * 11) % 40) / 10,
    }));
    const plan = Sim.createPlan(field, 'standard');
    const earlyLeader = Sim.rankAt(plan, 0.18)[0].num;
    if (Sim.rankAt(plan, 1)[0].num === earlyLeader) leaderWins++;
  }
  assert.ok(leaderWins / races < 0.14, `序盤先頭馬の勝率が高すぎる: ${leaderWins}/${races}`);
});

test('途中順位を進行度順で返す', () => {
  const ranked = Sim.rankAt(Sim.createPlan(horses, 'standard'), 0.8);
  assert.strictEqual(ranked.length, horses.length);
  assert.ok(ranked[0].raceProgress >= ranked[1].raceProgress);
});
