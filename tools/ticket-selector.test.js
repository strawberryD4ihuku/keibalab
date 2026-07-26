'use strict';

const assert = require('assert');
const TS = require('../lib/ticket-selector.js');

function test(name, fn) {
  try { fn(); console.log(`OK  ${name}`); }
  catch (e) { console.error(`NG  ${name}: ${e.message}`); process.exitCode = 1; }
}

const horses = [
  {num: 1, waku: 1, name: 'A', predictedWinProb: .5},
  {num: 2, waku: 1, name: 'B', predictedWinProb: .3},
  {num: 3, waku: 2, name: 'C', predictedWinProb: .2},
];

test('着順どおりの馬単・3連単確率は全組み合わせで1になる', () => {
  const maps = TS.buildProbabilityMaps(horses);
  const sum = m => [...m.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(maps['馬単']) - 1) < 1e-9);
  assert.ok(Math.abs(sum(maps['3連単']) - 1) < 1e-9);
});

test('順不同の組み合わせは同じ確率として扱う', () => {
  const maps = TS.buildProbabilityMaps(horses);
  assert.ok(maps['馬連'].get('1-2') > 0);
  assert.strictEqual(maps['馬連'].get('2-1'), undefined);
  assert.ok(maps['3連複'].get('1-2-3') > .999999);
});

test('枠連は馬番ではなく枠番でまとめる', () => {
  const maps = TS.buildProbabilityMaps(horses);
  assert.ok(maps['枠連'].get('1-1') > 0);
  assert.ok(maps['枠連'].get('1-2') > 0);
  assert.deepStrictEqual(TS.parseNums('枠連', '0101'), [1, 1]);
});

test('全券種のオッズを同じ一覧で比較できる', () => {
  const odds = {
    '単勝': {'1': ['2.0']}, '複勝': {'1': ['1.4', '1.6']}, '枠連': {'0102': ['3.5']},
    'ワイド': {'0102': ['3.0', '3.4']}, '馬連': {'0102': ['4.0']},
    '馬単': {'0102': ['6.0']}, '3連複': {'010203': ['5.0']}, '3連単': {'010203': ['12.0']},
  };
  const result = TS.selectBestTickets(horses, odds, {threshold: 1});
  assert.deepStrictEqual(result.byType.map(x => x.betType), TS.BET_TYPES);
});

test('条件を超えた買い目のうち100円の見込みが最大の1点を選ぶ', () => {
  const odds = {'単勝': {'1': ['2.0']}, '馬単': {'0102': ['20.0']}};
  const result = TS.selectBestTickets(horses, odds, {threshold: 110});
  assert.ok(result.best);
  assert.strictEqual(result.best.betType, '馬単');
  assert.deepStrictEqual(result.best.nums, [1, 2]);
});

test('どの買い目も条件未満ならレースを見送る', () => {
  const odds = {'単勝': {'1': ['1.1']}, '馬連': {'0102': ['1.1']}};
  const result = TS.selectBestTickets(horses, odds, {threshold: 110});
  assert.strictEqual(result.best, null);
  assert.strictEqual(result.skipRace, true);
});
