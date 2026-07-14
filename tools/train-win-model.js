// 総合勝率モデル（市場オフセット付きsoftmax）の学習
// 実行: npm run train:win （= node tools/train-win-model.js [--dir jvdata2000]）
//
//   logit_i = log(marketProb_i) + Σ β_f・z_f + Σ γ_f・missing_f
//   p_i     = softmax(logit)_i
//
// - 学習データ: 2015-01-01〜2021-12-31 のみ。2022年以降では係数を一切学習しない
// - 損失: レース単位の交差エントロピー -log p(勝ち馬) の平均 + L2正則化
// - 最適化: 全バッチ勾配降下（初期値0＝市場確率から開始・決定的で乱数不使用）
// - ハイパーパラメータは下のHYPERで固定。多数の組み合わせを探索して良い結果だけ
//   採用することはしない
// - 学習後、調整確認期間(2022-2023)で市場単独と比較し、採用条件を判定して
//   models/win-model.json へ採用/不採用も含めて保存する
// - marketProb（=確定オッズ由来）が特徴量の基準。発売中オッズとは異なる点に注意
'use strict';
const fs = require('fs');
const path = require('path');
const WM = require('../lib/win-model.js');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const TRAIN_FROM = '2015-01-01';
const TRAIN_TO = '2021-12-31';       // ここより後のデータで係数を学習しない
const VALID_FROM = '2022-01-01';     // 調整確認（採用判定のみに使用）
const VALID_TO = '2023-12-31';

// 固定ハイパーパラメータ（探索しない。乱数は不使用だがseed欄は再現性の明示用）
const HYPER = {lr: 0.5, epochs: 500, l2: 1e-4, seed: 42};

const MODEL_VERSION = 'win-model-v1';

function isTrainRow(row) { return row.date >= TRAIN_FROM && row.date <= TRAIN_TO; }
function isValidRow(row) { return row.date >= VALID_FROM && row.date <= VALID_TO; }

// 1レース分を学習用構造へ（結果rank/wonは正解ラベルにのみ使用し、特徴量には混ぜない）
// 標準化は「出走全馬」で行い、softmaxにはmarketProbが有効な馬だけ入れる（実運用と同じ規約）
function buildRace(row, feats) {
  const std = WM.standardizeFeaturesInRace(row.horses, feats);
  const dim = feats.length * 2;
  const items = [];
  let winnerIdx = -1;
  row.horses.forEach((h, i) => {
    if (!(h.marketProb > 0)) return;
    const x = new Float64Array(dim);
    feats.forEach((f, k) => {
      x[k] = std[i].z[f];
      x[feats.length + k] = std[i].missing[f];
    });
    if (h.won === true || h.rank === 1) winnerIdx = items.length;
    items.push({base: Math.log(h.marketProb), x});
  });
  if (winnerIdx < 0 || items.length < 2) return null;   // 勝ち馬にオッズがない等は学習から除外
  return {items, winnerIdx, dim};
}

// 全バッチ勾配降下（凸問題なので決定的に収束する）
function trainModel(races, dim, hyper, onEpoch) {
  const theta = new Float64Array(dim);
  const n = races.length;
  let lastLoss = null;
  for (let ep = 1; ep <= hyper.epochs; ep++) {
    const grad = new Float64Array(dim);
    let loss = 0;
    for (const rc of races) {
      let mx = -Infinity;
      const lg = new Array(rc.items.length);
      for (let j = 0; j < rc.items.length; j++) {
        const it = rc.items[j];
        let v = it.base;
        for (let k = 0; k < dim; k++) v += theta[k] * it.x[k];
        lg[j] = v;
        if (v > mx) mx = v;
      }
      let tot = 0;
      for (let j = 0; j < lg.length; j++) { lg[j] = Math.exp(lg[j] - mx); tot += lg[j]; }
      loss += -Math.log(Math.max(lg[rc.winnerIdx] / tot, 1e-12));
      for (let j = 0; j < rc.items.length; j++) {
        const d = lg[j] / tot - (j === rc.winnerIdx ? 1 : 0);
        const x = rc.items[j].x;
        for (let k = 0; k < dim; k++) grad[k] += d * x[k];
      }
    }
    let l2p = 0;
    for (let k = 0; k < dim; k++) l2p += theta[k] * theta[k];
    loss = loss / n + hyper.l2 * l2p;
    for (let k = 0; k < dim; k++) theta[k] -= hyper.lr * (grad[k] / n + 2 * hyper.l2 * theta[k]);
    lastLoss = loss;
    if (onEpoch && (ep === 1 || ep % 100 === 0)) onEpoch(ep, loss);
  }
  return {theta, loss: lastLoss};
}

// 係数配列 → モデルJSONの形
function toModelJson(theta, feats, extra) {
  const coef = {}, missingCoef = {};
  feats.forEach((f, k) => {
    coef[f] = Number(theta[k].toFixed(6));
    missingCoef[f] = Number(theta[feats.length + k].toFixed(6));
  });
  return Object.assign({
    version: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    features: feats,
    coef, missingCoef,
    train: {from: TRAIN_FROM, to: TRAIN_TO},
    hyper: HYPER,
    note: '市場オフセット付きsoftmax。係数が全て0なら市場確率と一致。marketProbは確定オッズ由来',
  }, extra || {});
}

// ---- 評価（市場単独 vs モデル）----
// LogLoss: レースごとの -log p(勝ち馬) の平均 / Brier: 全馬の (p-won)^2 の平均
function evaluate(rows, model) {
  const st = {
    races: 0, horses: 0,
    market: {sumLL: 0, sumBrier: 0, top1: 0},
    model: {sumLL: 0, sumBrier: 0, top1: 0, badSum: 0, nan: 0},
    // 予測勝率帯の校正（モデル側）: [下限%, 上限%)
    bands: [0, 2, 5, 10, 20, 30, 50, 101].slice(0, -1).map((lo, i, a) => ({lo, hi: [2, 5, 10, 20, 30, 50, 101][i], n: 0, sumP: 0, wins: 0})),
    // 期待回収率帯（安全率0.95込み）ごとの実回収率（モデル側）
    roiBands: [{lo: 0, hi: 80}, {lo: 80, hi: 90}, {lo: 90, hi: 100}, {lo: 100, hi: 110}, {lo: 110, hi: 1e9}]
      .map(b => ({...b, n: 0, wins: 0, ret: 0})),
  };
  for (const row of rows) {
    const preds = model ? WM.predictWinModel(row.horses, model) : null;
    let mTop = null, pTop = null, winnerM = null, winnerP = null, psum = 0, hasP = false;
    row.horses.forEach((h, i) => {
      const mp = h.marketProb;
      if (!(mp > 0)) return;
      const p = preds ? preds[i].predictedWinProb : mp;
      const won = h.won === true || h.rank === 1;
      st.horses++;
      st.market.sumBrier += (mp - (won ? 1 : 0)) ** 2;
      st.model.sumBrier += (p - (won ? 1 : 0)) ** 2;
      if (!Number.isFinite(p)) st.model.nan++;
      psum += p; hasP = true;
      if (mTop == null || mp > mTop.p) mTop = {p: mp, won};
      if (pTop == null || p > pTop.p) pTop = {p, won};
      if (won) { winnerM = mp; winnerP = p; }
      const band = st.bands.find(b => p * 100 >= b.lo && p * 100 < b.hi);
      if (band) { band.n++; band.sumP += p; if (won) band.wins++; }
      if (h.odds > 0) {
        const roi = p * h.odds * 0.95 * 100;
        const rb = st.roiBands.find(b => roi >= b.lo && roi < b.hi);
        if (rb) { rb.n++; if (won) { rb.wins++; rb.ret += h.odds * 100; } }
      }
    });
    if (winnerM == null) continue;   // 勝ち馬のオッズなし等は評価から除外
    st.races++;
    st.market.sumLL += -Math.log(Math.max(winnerM, 1e-12));
    st.model.sumLL += -Math.log(Math.max(winnerP, 1e-12));
    if (mTop && mTop.won) st.market.top1++;
    if (pTop && pTop.won) st.model.top1++;
    if (hasP && Math.abs(psum - 1) > 1e-6) st.model.badSum++;
  }
  return st;
}

// 採用条件の自動判定（調整確認期間 2022-2023 のみで判断）
function decideAdoption(st, incumbentSt) {
  const reasons = [];
  const llMarket = st.market.sumLL / st.races;
  const llModel = st.model.sumLL / st.races;
  const brMarket = st.market.sumBrier / st.horses;
  const brModel = st.model.sumBrier / st.horses;
  if (!(llModel < llMarket)) reasons.push(`LogLossが市場単独より改善していない (model=${llModel.toFixed(5)} >= market=${llMarket.toFixed(5)})`);
  if (brModel > brMarket + 1e-9) reasons.push(`Brier Scoreが市場単独より悪化 (model=${brModel.toFixed(6)} > market=${brMarket.toFixed(6)})`);
  if (st.model.nan > 0) reasons.push(`NaNが${st.model.nan}件`);
  if (st.model.badSum > 0) reasons.push(`確率合計が1にならないレースが${st.model.badSum}件`);
  // 校正の大きな逆転：十分な頭数(200頭以上)の帯で、上の帯の実勝率が下の帯の実勝率を大きく下回らないこと
  const solid = st.bands.filter(b => b.n >= 200);
  for (let i = 1; i < solid.length; i++) {
    const prev = solid[i - 1].wins / solid[i - 1].n;
    const cur = solid[i].wins / solid[i].n;
    if (cur < prev * 0.8) {
      reasons.push(`予測勝率帯の逆転: ${solid[i - 1].lo}-${solid[i - 1].hi}%帯の実勝率${(prev * 100).toFixed(1)}% > ${solid[i].lo}-${solid[i].hi}%帯${(cur * 100).toFixed(1)}%`);
      break;
    }
  }
  // 期待値が高い帯で実回収率が極端に落ちる現象：EV100%以上の帯の実回収率が全体平均(約78%)の6割未満なら不合格
  const hi = st.roiBands.filter(b => b.lo >= 100).reduce((a, b) => ({n: a.n + b.n, ret: a.ret + b.ret}), {n: 0, ret: 0});
  if (hi.n >= 50 && hi.ret / (hi.n * 100) < 0.47) {
    reasons.push(`期待回収率100%以上の帯の実回収率が極端に低い (${(hi.ret / hi.n).toFixed(1)}%)`);
  }
  if (incumbentSt && incumbentSt.races) {
    const incumbentLL = incumbentSt.model.sumLL / incumbentSt.races;
    const incumbentBrier = incumbentSt.model.sumBrier / incumbentSt.horses;
    if (!(llModel < incumbentLL - 1e-9)) {
      reasons.push(`現行採用モデルよりLogLossが改善していない (candidate=${llModel.toFixed(5)} >= incumbent=${incumbentLL.toFixed(5)})`);
    }
    if (brModel > incumbentBrier + 1e-9) {
      reasons.push(`現行採用モデルよりBrier Scoreが悪化 (candidate=${brModel.toFixed(6)} > incumbent=${incumbentBrier.toFixed(6)})`);
    }
  }
  return {
    adopted: reasons.length === 0,
    reasons,
    metrics: {
      races: st.races, horses: st.horses,
      logLossMarket: Number(llMarket.toFixed(5)), logLossModel: Number(llModel.toFixed(5)),
      brierMarket: Number(brMarket.toFixed(6)), brierModel: Number(brModel.toFixed(6)),
      top1Market: Number((st.market.top1 / st.races).toFixed(4)), top1Model: Number((st.model.top1 / st.races).toFixed(4)),
      incumbentLogLoss: incumbentSt && incumbentSt.races ? Number((incumbentSt.model.sumLL / incumbentSt.races).toFixed(5)) : null,
      incumbentBrier: incumbentSt && incumbentSt.horses ? Number((incumbentSt.model.sumBrier / incumbentSt.horses).toFixed(6)) : null,
    },
  };
}

function main() {
  const DIR = argOf('--dir', 'jvdata2000');
  const file = argOf('--win', path.join(DIR, 'win_value_rows.json'));
  const outFile = argOf('--out', path.join(__dirname, '..', 'models', 'win-model.json'));
  const productionFile = path.join(__dirname, '..', 'models', 'win-model.json');
  const incumbentFile = argOf('--incumbent', productionFile);
  if (!fs.existsSync(file)) {
    console.error(`${file} がありません。先に node tools/jv-import.js --dir ${DIR} を実行してください`);
    process.exit(1);
  }
  const featureArg = argOf('--features', '');
  const feats = featureArg ? featureArg.split(',').map(s => s.trim()).filter(Boolean) : WM.WIN_MODEL_FEATURES;
  console.log(`特徴量: ${feats.join(', ')}（sireFit・market・着順は不使用）`);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).sort((a, b) => a.date.localeCompare(b.date));
  let incumbent = null;
  try { incumbent = JSON.parse(fs.readFileSync(incumbentFile, 'utf8')); } catch { /* 初回学習は比較対象なし */ }

  const trainRows = rows.filter(isTrainRow);
  const validRows = rows.filter(isValidRow);
  console.log(`学習: ${trainRows.length}レース（${TRAIN_FROM}〜${TRAIN_TO}） / 調整確認: ${validRows.length}レース（${VALID_FROM}〜${VALID_TO}）`);

  const races = trainRows.map(r => buildRace(r, feats)).filter(Boolean);
  console.log(`学習可能レース: ${races.length} / ハイパーパラメータ固定: lr=${HYPER.lr} epochs=${HYPER.epochs} l2=${HYPER.l2}`);
  const t0 = Date.now();
  const {theta, loss} = trainModel(races, feats.length * 2, HYPER,
    (ep, l) => console.log(`  epoch ${String(ep).padStart(4)}  loss=${l.toFixed(6)}`));
  console.log(`学習完了 (${((Date.now() - t0) / 1000).toFixed(1)}秒)  最終loss=${loss.toFixed(6)}`);

  // 学習期間の市場単独LogLoss（参考）
  const trainEval = evaluate(trainRows, toModelJson(theta, feats));
  console.log(`学習期間: LogLoss 市場=${(trainEval.market.sumLL / trainEval.races).toFixed(5)} → モデル=${(trainEval.model.sumLL / trainEval.races).toFixed(5)}`);

  // 調整確認期間で採用判定
  const model = toModelJson(theta, feats);
  const validEval = evaluate(validRows, model);
  const incumbentEval = incumbent && incumbent.adopted !== false ? evaluate(validRows, incumbent) : null;
  const decision = decideAdoption(validEval, incumbentEval);
  console.log(`\n■ 調整確認（${VALID_FROM}〜${VALID_TO}）による採用判定`);
  console.log(`  LogLoss: 市場=${decision.metrics.logLossMarket} → モデル=${decision.metrics.logLossModel}`);
  console.log(`  Brier:   市場=${decision.metrics.brierMarket} → モデル=${decision.metrics.brierModel}`);
  console.log(`  1位的中: 市場=${(decision.metrics.top1Market * 100).toFixed(1)}% → モデル=${(decision.metrics.top1Model * 100).toFixed(1)}%`);
  if (decision.metrics.incumbentLogLoss != null) {
    console.log(`  現行採用モデル: LogLoss=${decision.metrics.incumbentLogLoss} / Brier=${decision.metrics.incumbentBrier}`);
  }
  console.log(decision.adopted ? '  → ✅ 採用条件を満たした' : `  → ❌ 不採用: ${decision.reasons.join(' / ')}`);

  const out = toModelJson(theta, feats, {
    trainLoss: Number(loss.toFixed(6)),
    trainRaces: races.length,
    validation: {from: VALID_FROM, to: VALID_TO, ...decision.metrics},
    adopted: decision.adopted,
    rejectReasons: decision.reasons,
  });
  const isProduction = path.resolve(outFile) === path.resolve(productionFile);
  const saveFile = isProduction && !out.adopted
    ? path.join(path.dirname(outFile), 'win-model-candidate.json')
    : outFile;
  fs.mkdirSync(path.dirname(saveFile), {recursive: true});
  fs.writeFileSync(saveFile, JSON.stringify(out, null, 2));
  console.log(`\n保存: ${saveFile}（adopted=${out.adopted}）`);
  if (isProduction && !out.adopted) console.log(`現行採用モデル ${outFile} は上書きしません`);
  feats.forEach(f => console.log(`  β ${f.padEnd(8)} = ${String(out.coef[f]).padStart(10)}   γ missing_${f.padEnd(8)} = ${out.missingCoef[f]}`));
}

module.exports = {isTrainRow, isValidRow, buildRace, trainModel, toModelJson, evaluate, decideAdoption,
  TRAIN_FROM, TRAIN_TO, VALID_FROM, VALID_TO, HYPER};

if (require.main === module) main();
