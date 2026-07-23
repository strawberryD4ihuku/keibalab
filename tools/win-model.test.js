// 総合勝率モデル（市場オフセット付きsoftmax）の自動テスト
// 実行: npm test （win-value.test.js に続いて実行される）
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WM = require('../lib/win-model.js');
const TR = require('./train-win-model.js');

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const FEATS = WM.WIN_MODEL_FEATURES;
const mkModel = (coef, missingCoef) => ({
  version: 'test', features: FEATS,
  coef: Object.fromEntries(FEATS.map(f => [f, coef?.[f] ?? 0])),
  missingCoef: Object.fromEntries(FEATS.map(f => [f, missingCoef?.[f] ?? 0])),
});
// 3頭のサンプル（全特徴量あり）
const sample = () => [
  {num: 1, odds: 2.0, form: 80, career: 70, fit: 60, venueFit: 55, agari: 65, jockey: 90, kinryo: 50},
  {num: 2, odds: 5.0, form: 50, career: 50, fit: 50, venueFit: 50, agari: 50, jockey: 50, kinryo: 50},
  {num: 3, odds: 10.0, form: 20, career: 30, fit: 40, venueFit: 45, agari: 35, jockey: 30, kinryo: 50},
];

test('1. レース内標準化値の平均がほぼ0（欠損のない特徴量）', () => {
  const std = WM.standardizeFeaturesInRace(sample());
  for (const f of ['form', 'career', 'jockey']) {
    const mean = std.reduce((s, r) => s + r.z[f], 0) / std.length;
    assert.ok(approx(mean, 0, 1e-9), `${f}の平均z=${mean}`);
  }
});

test('2. 標準偏差0でもNaNにならない（z=0になる）', () => {
  const std = WM.standardizeFeaturesInRace(sample());   // kinryoは全馬50で標準偏差0
  std.forEach(r => {
    assert.strictEqual(r.z.kinryo, 0);
    for (const f of FEATS) assert.ok(Number.isFinite(r.z[f]), `${f}がNaN`);
  });
});

test('3. 欠損値はz=0＋missingフラグ1が生成される', () => {
  const horses = sample();
  horses[1].form = null;       // 欠損
  horses[2].agari = undefined; // 欠損
  const std = WM.standardizeFeaturesInRace(horses);
  assert.strictEqual(std[1].z.form, 0);
  assert.strictEqual(std[1].missing.form, 1);
  assert.strictEqual(std[0].missing.form, 0);
  assert.strictEqual(std[2].missing.agari, 1);
  // 欠損は分布計算から除外される（残り2頭のformで標準化）
  assert.ok(std[0].z.form > 0 && std[2].z.form < 0);
});

test('4. softmaxの合計がほぼ1', () => {
  const preds = WM.predictWinModel(sample(), mkModel({form: 0.5, jockey: -0.3}));
  const sum = preds.reduce((s, p) => s + p.predictedWinProb, 0);
  assert.ok(approx(sum, 1, 1e-9), `合計=${sum}`);
  preds.forEach(p => assert.ok(p.predictedWinProb > 0 && p.predictedWinProb < 1));
});

test('5. 係数が全て0なら市場確率と一致する', () => {
  const preds = WM.predictWinModel(sample(), mkModel({}));
  preds.forEach(p => assert.ok(approx(p.predictedWinProb, p.marketProb, 1e-9),
    `p=${p.predictedWinProb} market=${p.marketProb}`));
});

test('6. 正の係数で特徴量の高い馬の確率が上がる', () => {
  const base = WM.predictWinModel(sample(), mkModel({}));
  const preds = WM.predictWinModel(sample(), mkModel({form: 0.5}));
  assert.ok(preds[0].predictedWinProb > base[0].predictedWinProb, 'form最高の馬が上がっていない');
  assert.ok(preds[2].predictedWinProb < base[2].predictedWinProb, 'form最低の馬が下がっていない');
});

test('7. 負の係数で特徴量の高い馬の確率が下がる', () => {
  const base = WM.predictWinModel(sample(), mkModel({}));
  const preds = WM.predictWinModel(sample(), mkModel({form: -0.5}));
  assert.ok(preds[0].predictedWinProb < base[0].predictedWinProb);
  assert.ok(preds[2].predictedWinProb > base[2].predictedWinProb);
});

test('8. モデルJSONの保存・読み込み後も予測が一致する', () => {
  const model = mkModel({form: 0.31, career: -0.12, jockey: 0.07}, {form: -0.05});
  const tmp = path.join(os.tmpdir(), `win-model-test-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(model));
  const loaded = WM.loadModel(tmp);
  fs.unlinkSync(tmp);
  const a = WM.predictWinModel(sample(), model);
  const b = WM.predictWinModel(sample(), loaded);
  a.forEach((p, i) => assert.ok(approx(p.predictedWinProb, b[i].predictedWinProb, 1e-12)));
});

test('9. 学習対象に2022年以降が混入しない', () => {
  assert.strictEqual(TR.isTrainRow({date: '2015-01-01'}), true);
  assert.strictEqual(TR.isTrainRow({date: '2021-12-31'}), true);
  assert.strictEqual(TR.isTrainRow({date: '2022-01-01'}), false);
  assert.strictEqual(TR.isTrainRow({date: '2024-06-01'}), false);
  const rows = [{date: '2021-12-31'}, {date: '2022-01-01'}, {date: '2023-05-05'}, {date: '2015-01-04'}];
  const train = rows.filter(TR.isTrainRow);
  assert.strictEqual(train.length, 2);
  assert.ok(train.every(r => r.date <= TR.TRAIN_TO));
});

test('10. モデル取得失敗時に市場確率へフォールバックする', () => {
  for (const bad of [null, undefined, {}, {coef: null}, {features: 'x'}]) {
    const preds = WM.predictWinModel(sample(), bad);
    preds.forEach(p => assert.ok(approx(p.predictedWinProb, p.marketProb, 1e-12), `model=${JSON.stringify(bad)}`));
  }
  // 存在しないファイルはnull（呼び出し側はnullでフォールバック）
  assert.strictEqual(WM.loadModel(path.join(os.tmpdir(), 'no-such-model-xyz.json')), null);
});

test('11. 軸切り替えUI削除後も既存予想（スコア・序列）が動く', () => {
  // index.htmlから抽出したcomputeScore一式がcurrentAxis固定で正常動作すること
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!html.includes('setAxis('), '軸切り替えUIの残骸がある');
  const scoring = loadScoring(html);
  // computeScoreに渡すのは特徴量形式ではなく出馬表形式（jockeyは騎手名）
  const horses = sample().map(h => ({...h, jockey: 'ルメール', name: `馬${h.num}`, p1: 1, p2: 2, career: {n: 10, w: 2, p3: 5, fitN: 3, fitP3: 2, venueN: 2, venueP3: 1}}));
  horses.forEach(h => { h.score = scoring.computeScore(h); });
  horses.forEach(h => assert.ok(h.score >= 1 && h.score <= 99));
  const comps = scoring.computeScoreComponents(horses[0]);
  assert.ok(comps.form != null && comps.career != null);
  assert.strictEqual(typeof scoring.rankForBet(horses, scoring.BET_CONFIG['馬連'])[0].num, 'number');
});

test('12. 単勝以外の券種が従来どおり生成される', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scoring = loadScoring(html);
  const horses = sample().map((h, i) => ({...h, name: `馬${h.num}`, score: 80 - i * 10}));
  for (const [bt, points] of [['複勝', 2], ['ワイド', 2], ['馬連', 2], ['馬単', 2], ['3連複', 1], ['3連単', 2]]) {
    const cfg = scoring.BET_CONFIG[bt];
    const picks = scoring.rankForBet(horses, cfg).slice(0, cfg.marks.length);
    const combos = scoring.buildCombos(bt, picks);
    assert.ok(combos.length >= points, `${bt}の買い目が${combos.length}点しか出ない`);
  }
});

test('13. 小さい人工データで学習後に損失が低下する', () => {
  // form が本当に勝敗を決める人工データ（marketは一様）を作る
  const feats = FEATS;
  const rows = [];
  for (let r = 0; r < 60; r++) {
    const horses = [0, 1, 2, 3].map(i => ({
      num: i + 1, marketProb: 0.25, rank: null, won: false,
      form: (i === r % 4) ? 90 : 30, career: 50, fit: 50, venueFit: 50, agari: 50, jockey: 50, kinryo: 50,
    }));
    horses[r % 4].won = true;   // formが高い馬が必ず勝つ
    rows.push({date: '2015-06-01', horses});
  }
  const races = rows.map(row => TR.buildRace(row, feats)).filter(Boolean);
  assert.strictEqual(races.length, 60);
  const lossAt = [];
  TR.trainModel(races, feats.length * 2, {lr: 0.5, epochs: 100, l2: 1e-4},
    (ep, loss) => lossAt.push(loss));
  const first = lossAt[0], last = lossAt[lossAt.length - 1];
  assert.ok(last < first - 0.1, `損失が低下していない first=${first} last=${last}`);
  assert.ok(first <= Math.log(4) + 0.01, '初期損失が市場一様(-log 0.25)を超えている');
});

test('14. 市場より良くても現行採用モデルより悪い候補は不採用になる', () => {
  const st = {
    races: 10, horses: 100,
    market: {sumLL: 20, sumBrier: 6, top1: 3},
    model: {sumLL: 19, sumBrier: 5, top1: 4, nan: 0, badSum: 0},
    bands: [], roiBands: [],
  };
  const incumbent = {
    races: 10, horses: 100,
    model: {sumLL: 18, sumBrier: 4.9},
  };
  const d = TR.decideAdoption(st, incumbent);
  assert.strictEqual(d.adopted, false);
  assert.ok(d.reasons.some(r => r.includes('現行採用モデルよりLogLoss')));
});

test('15. 血統切替UIの廃止後も馬名下の産駒情報を常時表示する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes("${h.sire ? `<div"), '馬名欄に産駒情報の表示がない');
  assert.ok(!html.includes("currentAxis === '血統' && h.sire"), '廃止した血統切替に表示が依存している');
});

test('16. 馬名欄から戦績・血統と最新記事へ移動できる', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('function horseInfoLinks(h)'), '馬情報リンクの生成処理がない');
  assert.ok(html.includes('https://db.netkeiba.com/horse/'), 'netkeibaの馬プロフィール導線がない');
  assert.ok(html.includes('https://news.netkeiba.com/?pid=news_search&keyword='), 'netkeibaの馬名ニュース検索導線がない');
  assert.ok(html.includes('${horseInfoLinks(h)}'), '馬名欄に馬情報リンクが表示されていない');
});

// ---- index.html からスコアリング一式を抽出（jv-import.jsと同方式の簡易版）----
function loadScoring(html) {
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const extract = name => {
    let start = src.indexOf(`function ${name}(`);
    let isFunc = start >= 0;
    if (!isFunc) start = src.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `${name} を抽出できない`);
    let i = src.indexOf(isFunc ? '{' : '=', start);
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{' || (!isFunc && (c === '[' || c === '('))) depth++;
      else if (c === '}' || (!isFunc && (c === ']' || c === ')'))) { depth--; if (isFunc && depth === 0) return src.slice(start, i + 1); }
      else if (!isFunc && c === ';' && depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`${name} 抽出失敗`);
  };
  const names = ['hashStr', 'JOCKEY_RATING', 'jockeyRating', 'jockeyRateComp', 'AXIS_WEIGHTS',
    'sireFitComp', 'computeScoreComponents', 'computeScore', 'BET_CONFIG', 'rankForBet', 'buildCombos'];
  const decls = names.map(extract).join('\n');
  return new Function(`
    let currentAxis = '馬柱';
    let currentRaceSurface = '芝';
    ${decls}
    return {computeScoreComponents, computeScore, rankForBet, buildCombos, BET_CONFIG};
  `)();
}

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
