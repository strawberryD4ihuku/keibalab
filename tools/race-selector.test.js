'use strict';

const assert = require('assert');
const RS = require('../lib/race-selector.js');

function test(name, fn) {
  try { fn(); console.log(`OK  ${name}`); }
  catch (e) { console.error(`NG  ${name}: ${e.message}`); process.exitCode = 1; }
}

test('確率を正規化してエントロピーを計算する', () => {
  assert.deepStrictEqual(RS.normalize([2, 1]).map(x => Number(x.toFixed(3))), [0.667, 0.333]);
  assert.ok(RS.normalizedEntropy([0.5, 0.5]) > RS.normalizedEntropy([0.9, 0.1]));
});

test('安定型は9頭以下かつ軸1.9倍以下のレースを買う', () => {
  const signals = {
    field: 9, topProb: 0.36, probGap: 0.16, entropy: 0.75,
    modelTopMarketRank: 1, scoreGap: 8, axisOdds: 1.9,
    axisPopularity: 1, coverage: 0.8,
  };
  assert.strictEqual(RS.evaluateStable(signals).decision, 'buy');
  assert.strictEqual(RS.evaluateUpset(signals).decision, 'skip');
});

test('安定型は多頭数または軸2倍以上なら見送る', () => {
  const base = {field: 9, axisOdds: 1.9};
  assert.strictEqual(RS.evaluateStable({...base, field: 10}).decision, 'skip');
  assert.strictEqual(RS.evaluateStable({...base, axisOdds: 2}).decision, 'skip');
});

test('荒れ狙い型は予測不能ではなく市場とのズレがあるレースを買う', () => {
  const signals = {
    field: 16, marketTopProb: 0.25, entropy: 0.84, topProb: 0.2,
    probGap: 0.04, bestEdge: 0.04, modelTopMarketRank: 4,
    valuePickNum: 7, scoreGap: 5, axisOdds: 9.5, coverage: 0.75,
  };
  assert.strictEqual(RS.evaluateUpset(signals).decision, 'buy');
});

test('荒れそうでも根拠がなければ見送る', () => {
  const signals = {
    field: 16, marketTopProb: 0.2, entropy: 0.95, topProb: 0.09,
    probGap: 0.002, bestEdge: 0.005, modelTopMarketRank: 9,
    valuePickNum: null, scoreGap: 0, axisOdds: 18, coverage: 0.8,
  };
  const result = RS.evaluateUpset(signals);
  assert.strictEqual(result.decision, 'skip');
  assert.ok(result.reasons.some(r => r.code === 'bestEdge'));
});

test('欠損の多いレースは両タイプとも見送る', () => {
  const base = {
    field: 12, marketTopProb: 0.25, entropy: 0.8, topProb: 0.3,
    probGap: 0.1, bestEdge: 0.04, modelTopMarketRank: 2,
    scoreGap: 8, axisOdds: 4, axisPopularity: 2, coverage: 0.1,
  };
  const result = RS.evaluateRace(base);
  assert.strictEqual(result.stable.decision, 'skip');
  assert.strictEqual(result.upset.decision, 'skip');
});
