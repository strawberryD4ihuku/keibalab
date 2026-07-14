'use strict';
const assert = require('assert');
const PF = require('../lib/performance-features.js');

const tests = [];
const test = (name, fn) => tests.push({name, fn});

test('クラスを一貫した序列へ変換する', () => {
  assert.strictEqual(PF.raceClassLevel('3歳未勝利'), 0);
  assert.strictEqual(PF.raceClassLevel('2勝クラス'), 2);
  assert.strictEqual(PF.raceClassLevel('G1'), 8);
  assert.strictEqual(PF.raceClassLevel('J・G2'), 7);
});

test('着差を距離1000m当たりへ換算し、高いほど好内容になる', () => {
  assert(PF.marginPerformance(-0.2, 1200) > 0);
  assert(PF.marginPerformance(0.2, 1200) < 0);
  assert(PF.marginPerformance(0.2, 1200) < PF.marginPerformance(0.2, 2400));
});

test('異常なタイム差は欠損として扱う', () => {
  assert.strictEqual(PF.marginPerformance(null, 1600), null);
  assert.strictEqual(PF.marginPerformance(99.9, 1600), null);
  assert.strictEqual(PF.marginPerformance(0.3, null), null);
});

test('直近走ほど重く集約する', () => {
  const goodRecent = PF.summarizePerformance([
    {timeDiffSec: -0.3, distance: 1600, raceClass: 'G1'},
    {timeDiffSec: 2.0, distance: 1600, raceClass: '未勝利'},
  ]);
  const goodOld = PF.summarizePerformance([
    {timeDiffSec: 2.0, distance: 1600, raceClass: '未勝利'},
    {timeDiffSec: -0.3, distance: 1600, raceClass: 'G1'},
  ]);
  assert(goodRecent.marginForm > goodOld.marginForm);
  assert(goodRecent.classLevel > goodOld.classLevel);
});

let failed = 0;
for (const [i, t] of tests.entries()) {
  try { t.fn(); console.log(`  ✅ ${i + 1}. ${t.name}`); }
  catch (e) { failed++; console.error(`  ❌ ${i + 1}. ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`\n${failed ? `${failed}件失敗` : `全${tests.length}件成功`}`);
if (failed) process.exit(1);
