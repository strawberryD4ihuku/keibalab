// 単勝・期待値判定（lib/win-value.js 経由で index.html から抽出）の自動テスト
// 実行: npm test （= node tools/win-value.test.js）
'use strict';
const assert = require('assert');
const WV = require('../lib/win-value.js');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- 確率の基本性質 ----

test('1. 全馬の市場確率合計がほぼ1になる', () => {
  const probs = WV.normalizeMarketProbabilities([{odds: 2.1}, {odds: 5.4}, {odds: 12.3}, {odds: 48.0}]);
  const sum = probs.reduce((s, p) => s + p, 0);
  assert.ok(approx(sum, 1, 1e-9), `合計=${sum}`);
  probs.forEach(p => assert.ok(p > 0 && p < 1));
});

test('2. 全馬の予測勝率合計がほぼ1になる', () => {
  const horses = [{odds: 1.8, score: 80}, {odds: 4.2, score: 65}, {odds: 9.9, score: 55}, {odds: 30.5, score: 40}];
  const out = WV.estimateWinProbabilities(horses);
  const sum = out.reduce((s, o) => s + o.predictedWinProb, 0);
  assert.ok(approx(sum, 1, 1e-9), `合計=${sum}`);
  out.forEach(o => assert.ok(o.predictedWinProb > 0 && o.predictedWinProb < 1));
});

test('3. 同一オッズならスコアが高い馬ほど予測勝率が高い', () => {
  const out = WV.estimateWinProbabilities([
    {odds: 5.0, score: 80}, {odds: 5.0, score: 50}, {odds: 5.0, score: 20},
  ]);
  assert.ok(out[0].predictedWinProb > out[1].predictedWinProb);
  assert.ok(out[1].predictedWinProb > out[2].predictedWinProb);
});

test('4. 同一スコアならオッズが低い馬ほど予測勝率が高い', () => {
  const out = WV.estimateWinProbabilities([
    {odds: 2.0, score: 60}, {odds: 8.0, score: 60}, {odds: 25.0, score: 60},
  ]);
  assert.ok(out[0].predictedWinProb > out[1].predictedWinProb);
  assert.ok(out[1].predictedWinProb > out[2].predictedWinProb);
});

test('5. スコアの標準偏差が0でもNaNにならない（市場確率がそのまま残る）', () => {
  const out = WV.estimateWinProbabilities([
    {odds: 2.0, score: 60}, {odds: 4.0, score: 60}, {odds: 8.0, score: 60},
  ]);
  const sum = out.reduce((s, o) => s + o.predictedWinProb, 0);
  out.forEach(o => {
    assert.ok(Number.isFinite(o.predictedWinProb), 'NaN/Infinityが出ている');
    assert.ok(Number.isFinite(o.marketProb));
  });
  assert.ok(approx(sum, 1, 1e-9));
  // 補正材料がないので市場確率と一致するはず
  out.forEach(o => assert.ok(approx(o.predictedWinProb, o.marketProb, 1e-9)));
});

test('6. oddsがnull・0・文字列でも壊れない', () => {
  const horses = [{odds: null, score: 70}, {odds: 0, score: 60}, {odds: '3.5', score: 50}, {odds: 'abc', score: 40}, {odds: 7.0, score: 30}];
  const out = WV.estimateWinProbabilities(horses);
  assert.strictEqual(out[0].predictedWinProb, null);   // null → 判定不能
  assert.strictEqual(out[1].predictedWinProb, null);   // 0 → 判定不能
  assert.ok(out[2].predictedWinProb > 0, '数値文字列はパースして扱う');
  assert.strictEqual(out[3].predictedWinProb, null);   // 数値にならない文字列 → 判定不能
  assert.ok(out[4].predictedWinProb > 0);
  const sum = out.reduce((s, o) => s + (o.predictedWinProb || 0), 0);
  assert.ok(approx(sum, 1, 1e-9), 'オッズ有効馬だけで合計1');
  // 全馬オッズ欠損でも例外にならない
  const empty = WV.estimateWinProbabilities([{odds: null, score: 50}, {odds: undefined, score: 60}]);
  empty.forEach(o => assert.strictEqual(o.predictedWinProb, null));
});

// ---- 期待値の計算 ----

test('7. 適正オッズ = 1 / 予測勝率', () => {
  const v = WV.calculateWinValue({odds: 8.0, predictedWinProb: 0.25});
  assert.ok(approx(v.fairOdds, 4.0), `fairOdds=${v.fairOdds}`);
});

test('8. 安全率込み期待回収率 = 勝率 × オッズ × 安全率 × 100', () => {
  const v = WV.calculateWinValue({odds: 10.0, predictedWinProb: 0.20}, {safetyFactor: 0.95, threshold: 120});
  assert.ok(approx(v.effectiveOdds, 9.5));
  assert.ok(approx(v.expectedRoiPercent, 190), `roi=${v.expectedRoiPercent}`);
  assert.strictEqual(v.decision, 'buy');
});

test('9. 期待回収率が閾値(120%)未満なら見送りになる', () => {
  // 0.10 × 10.0 × 0.95 × 100 = 95% < 120%
  const v = WV.calculateWinValue({odds: 10.0, predictedWinProb: 0.10});
  assert.ok(v.expectedRoiPercent < 120);
  assert.strictEqual(v.decision, 'skip');
  // ちょうど閾値なら購入候補（以上）
  const v2 = WV.calculateWinValue({odds: 10.0, predictedWinProb: 0.12}, {safetyFactor: 1.0, threshold: 120});
  assert.ok(approx(v2.expectedRoiPercent, 120));
  assert.strictEqual(v2.decision, 'buy');
  // オッズ欠損は判定不能
  assert.strictEqual(WV.calculateWinValue({odds: null, predictedWinProb: 0.2}).decision, 'no-odds');
});

test('10. 購入候補が複数でも期待回収率が最大の1頭だけを選ぶ', () => {
  // 市場より大幅に高スコアの人気薄を作り、複数頭がbuyになる係数で確認
  const {horses, pick} = WV.evaluateWinRace([
    {num: 1, odds: 3.0, score: 90},
    {num: 2, odds: 12.0, score: 88},
    {num: 3, odds: 6.0, score: 20},
  ], {scoreCoef: 1.2, threshold: 110});
  const buys = horses.filter(h => h.decision === 'buy');
  assert.ok(buys.length >= 2, `buy候補が${buys.length}頭（前提が崩れている）`);
  const best = buys.reduce((a, b) => (b.expectedRoiPercent > a.expectedRoiPercent ? b : a));
  assert.strictEqual(pick.num, best.num, '最大期待値の馬を推奨していない');
  // 同点なら予測勝率が高い方 → それも同じなら馬番の小さい方
  const tie = WV.evaluateWinRace([
    {num: 7, odds: 4.0, score: 50}, {num: 2, odds: 4.0, score: 50},
  ], {threshold: 100, scoreCoef: 0.2});
  if (tie.pick) assert.strictEqual(tie.pick.num, 2);
});

test('11. 全候補が閾値未満ならレース見送りになる', () => {
  // 市場確率どおり（スコア差なし）なら控除率のぶん期待回収率は100%未満 → 全頭skip
  const {horses, pick, skipRace} = WV.evaluateWinRace([
    {num: 1, odds: 2.0, score: 60}, {num: 2, odds: 4.0, score: 60}, {num: 3, odds: 8.0, score: 60},
  ]);
  assert.ok(horses.every(h => h.decision === 'skip'), '全頭見送りになっていない');
  assert.strictEqual(pick, null);
  assert.strictEqual(skipRace, true);
});

// ---- 実行 ----
let failed = 0;
for (const {name, fn} of tests) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}\n     ${e.message}`);
  }
}
console.log(failed ? `\n${failed}/${tests.length} 件失敗` : `\n全${tests.length}件成功`);
process.exit(failed ? 1 : 0);
