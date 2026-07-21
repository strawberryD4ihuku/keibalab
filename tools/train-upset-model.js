'use strict';

const fs = require('fs');
const path = require('path');
const WM = require('../lib/win-model.js');
const UM = require('../lib/upset-model.js');

const args = process.argv.slice(2);
const argOf = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const TRAIN_FROM = '2015-01-01', TRAIN_TO = '2021-12-31';
const VALID_FROM = '2022-01-01', VALID_TO = '2023-12-31';
const TEST_FROM = '2024-01-01';
const HYPER = {lr: 0.2, epochs: 250, l2: 0.0005};
const THRESHOLDS = [100, 105, 110, 115, 120, 125, 130, 140, 150];

function buildItems(rows, horseFeatures) {
  const items = [];
  let featureNames = null;
  for (const row of rows) {
    const encoded = UM.encodeRace(row, horseFeatures);
    featureNames = encoded.featureNames;
    for (const item of encoded.items) items.push(item);
  }
  return {items, featureNames};
}

function train(items, dim, hyper, onEpoch) {
  const theta = new Float64Array(dim);
  for (let ep = 1; ep <= hyper.epochs; ep++) {
    const grad = new Float64Array(dim);
    let loss = 0;
    for (const item of items) {
      let z = item.base;
      for (let k = 0; k < dim; k++) z += theta[k] * item.values[k];
      const p = UM.sigmoid(z), y = item.won ? 1 : 0;
      loss += -(y * Math.log(Math.max(p, 1e-12)) + (1 - y) * Math.log(Math.max(1 - p, 1e-12)));
      const d = p - y;
      for (let k = 0; k < dim; k++) grad[k] += d * item.values[k];
    }
    let penalty = 0;
    for (let k = 0; k < dim; k++) penalty += theta[k] ** 2;
    loss = loss / items.length + hyper.l2 * penalty;
    for (let k = 0; k < dim; k++) theta[k] -= hyper.lr * (grad[k] / items.length + 2 * hyper.l2 * theta[k]);
    if (onEpoch && (ep === 1 || ep % 50 === 0)) onEpoch(ep, loss);
  }
  return theta;
}

function emptyStat() { return {races: 0, bets: 0, hits: 0, invest: 0, ret: 0, maxRet: 0, sxx: 0, syy: 0, sxy: 0}; }
function finish(s) {
  const r = s.invest ? s.ret / s.invest : 0;
  const varZ = s.bets ? Math.max(0, (s.syy - 2 * r * s.sxy + r * r * s.sxx) / s.bets) : 0;
  const se = s.bets && s.invest ? Math.sqrt(varZ / s.bets) / (s.invest / s.bets) : 0;
  return {...s, roi: r * 100, lower: Math.max(0, (r - 1.645 * se) * 100), hitRate: s.bets ? s.hits / s.bets * 100 : 0};
}
function evaluate(rows, model, threshold) {
  const s = emptyStat();
  for (const row of rows) {
    s.races++;
    const {pick} = UM.selectPick(row, model, threshold);
    if (!pick) continue;
    const horse = row.horses.find(h => h.num === pick.num);
    const ret = horse && (horse.won || horse.rank === 1) ? horse.odds * 100 : 0;
    s.bets++; s.invest += 100; s.ret += ret; if (ret > 0) s.hits++;
    s.maxRet = Math.max(s.maxRet, ret); s.sxx += 10000; s.syy += ret * ret; s.sxy += 100 * ret;
  }
  return finish(s);
}

function chooseThreshold(rows, model, trainRows) {
  const table = THRESHOLDS.map(threshold => ({threshold, ...evaluate(rows, model, threshold)}));
  const trainTable = trainRows ? THRESHOLDS.map(threshold => ({threshold, ...evaluate(trainRows, model, threshold)})) : [];
  const eligible = table.filter(x => x.bets >= 100 && x.roi >= 100);
  const chosen = eligible.sort((a, b) => b.lower - a.lower || b.roi - a.roi)[0] || null;
  const exploratory = table.filter(x => x.bets >= 50 && x.roi >= 100)
    .sort((a, b) => b.lower - a.lower || b.roi - a.roi)[0] || null;
  const watch = table.map(v => ({validation: v, train: trainTable.find(t => t.threshold === v.threshold)}))
    .filter(x => x.train && x.train.bets >= 30 && x.validation.bets >= 10 && x.train.roi >= 100 && x.validation.roi >= 100)
    .sort((a, b) => b.validation.threshold - a.validation.threshold)[0] || null;
  return {table, trainTable, chosen, exploratory, watch};
}

function main() {
  const file = argOf('--win', path.join(argOf('--dir', 'jvdata2000'), 'win_value_rows.json'));
  const outFile = argOf('--out', path.join(__dirname, '..', 'models', 'upset-model.json'));
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).sort((a, b) => a.date.localeCompare(b.date));
  const trainRows = rows.filter(r => r.date >= TRAIN_FROM && r.date <= TRAIN_TO);
  const validRows = rows.filter(r => r.date >= VALID_FROM && r.date <= VALID_TO);
  const testRows = rows.filter(r => r.date >= TEST_FROM);
  const incumbent = WM.loadModel();
  const horseFeatures = incumbent && Array.isArray(incumbent.features) && incumbent.features.length
    ? incumbent.features
    : WM.WIN_MODEL_FEATURES;
  const encoded = buildItems(trainRows, horseFeatures);
  console.log(`穴候補 ${UM.MIN_ODDS}〜${UM.MAX_ODDS}倍 / 学習${trainRows.length}R・${encoded.items.length}頭 / ${encoded.featureNames.length}特徴`);
  const theta = train(encoded.items, encoded.featureNames.length, HYPER,
    (ep, loss) => console.log(`  epoch ${ep} loss=${loss.toFixed(6)}`));
  const baseModel = {
    version: 'upset-model-v1', generatedAt: new Date().toISOString(),
    horseFeatures, featureNames: encoded.featureNames, theta: [...theta].map(v => Number(v.toFixed(7))),
    oddsRange: {min: UM.MIN_ODDS, max: UM.MAX_ODDS}, hyper: HYPER,
    train: {from: TRAIN_FROM, to: TRAIN_TO, races: trainRows.length, horses: encoded.items.length},
  };
  const selection = chooseThreshold(validRows, baseModel, trainRows);
  console.log('\n■ 調整確認期間の購入閾値');
  for (const x of selection.table) console.log(`  EV${x.threshold}%: ${x.bets}件 的中${x.hitRate.toFixed(1)}% 回収${x.roi.toFixed(1)}% 下限${x.lower.toFixed(1)}%`);
  const threshold = selection.chosen && selection.chosen.threshold;
  const watchThreshold = selection.watch && selection.watch.validation.threshold;
  const researchThreshold = threshold || watchThreshold || (selection.exploratory && selection.exploratory.threshold);
  const test = researchThreshold ? evaluate(testRows, baseModel, researchThreshold) : null;
  const watchTest = watchThreshold ? evaluate(testRows, baseModel, watchThreshold) : null;
  const adopted = Boolean(selection.chosen && selection.chosen.lower >= 80);
  const model = {...baseModel, threshold: threshold || 999, adopted,
    watchCandidate: selection.watch ? {threshold: watchThreshold, train: selection.watch.train, validation: selection.watch.validation} : null,
    validation: {from: VALID_FROM, to: VALID_TO, chosen: selection.chosen, exploratory: selection.exploratory, table: selection.table},
    test: test ? {from: TEST_FROM, ...test} : null,
    watchTest: watchTest ? {from: TEST_FROM, threshold: watchThreshold, ...watchTest} : null,
    rejectReasons: adopted ? [] : ['調整確認期間で100件以上・回収率100%以上・90%片側下限80%以上を満たす閾値がない'],
    note: '確定単勝オッズ4〜30倍専用。市場確率logitを馬特徴・レース文脈で補正。2024年以降は採用判断に不使用',
  };
  fs.mkdirSync(path.dirname(outFile), {recursive: true});
  fs.writeFileSync(outFile, JSON.stringify(model, null, 2));
  const productionFile = path.join(__dirname, '..', 'models', 'upset-model.json');
  if (path.resolve(outFile) === path.resolve(productionFile)) {
    const edgeFile = path.join(__dirname, '..', 'supabase', 'functions', 'race-data', 'upset-model.json');
    fs.writeFileSync(edgeFile, JSON.stringify(model, null, 2));
  }
  console.log(`\n採用=${adopted} 閾値=${threshold || 'なし'}`);
  if (selection.watch) console.log(`前向き監視候補=EV${watchThreshold}%（学習${selection.watch.train.roi.toFixed(1)}% / 調整${selection.watch.validation.roi.toFixed(1)}%）`);
  if (test) console.log(`過去評価2024〜（参考閾値EV${researchThreshold}%）: ${test.bets}件 的中${test.hitRate.toFixed(1)}% 回収${test.roi.toFixed(1)}% 下限${test.lower.toFixed(1)}%`);
  if (watchTest && watchThreshold !== researchThreshold) console.log(`前向き監視候補の過去評価EV${watchThreshold}%: ${watchTest.bets}件 的中${watchTest.hitRate.toFixed(1)}% 回収${watchTest.roi.toFixed(1)}%`);
  console.log(`保存: ${outFile}`);
}

module.exports = {buildItems, train, evaluate, chooseThreshold, HYPER, THRESHOLDS};
if (require.main === module) main();
