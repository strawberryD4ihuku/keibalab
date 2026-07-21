'use strict';

const fs = require('fs');
const path = require('path');
const WM = require('../lib/win-model.js');
const RS = require('../lib/race-selector.js');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const DIR = argOf('--dir', 'jvdata2000');
const WIN_FILE = argOf('--win', path.join(DIR, 'win_value_rows.json'));
const VERIFY_FILE = argOf('--verify', path.join(DIR, 'verify_rows.json'));
const MODEL_FILE = argOf('--model', WM.MODEL_PATH);

const PERIODS = [
  {name: '学習・設計', from: '2015-01-01', to: '2021-12-31'},
  {name: '調整確認', from: '2022-01-01', to: '2023-12-31'},
  {name: '過去評価', from: '2024-01-01', to: '9999-12-31'},
  {name: '全期間', from: '0000-01-01', to: '9999-12-31'},
];
const PROFILES = ['stable', 'upset'];
const BET_TYPES = ['単勝', '複勝', 'ワイド', '馬連', '馬単', '3連複', '3連単'];

function newStat() {
  return {races: 0, buys: 0, hits: 0, invest: 0, ret: 0, cumNet: 0, peak: 0, maxDd: 0, loseStreak: 0, maxLoseStreak: 0, monthly: new Map()};
}

function addBet(st, date, pb, buy) {
  st.races++;
  if (!buy || !pb || !(pb.invest > 0)) return;
  st.buys++;
  st.invest += pb.invest;
  st.ret += pb.ret || 0;
  if (pb.ret > 0) { st.hits++; st.loseStreak = 0; }
  else { st.loseStreak++; st.maxLoseStreak = Math.max(st.maxLoseStreak, st.loseStreak); }
  st.cumNet += (pb.ret || 0) - pb.invest;
  st.peak = Math.max(st.peak, st.cumNet);
  st.maxDd = Math.max(st.maxDd, st.peak - st.cumNet);
  const month = date.slice(0, 7);
  const m = st.monthly.get(month) || {invest: 0, ret: 0};
  m.invest += pb.invest; m.ret += pb.ret || 0;
  st.monthly.set(month, m);
}

function pct(a, b, d = 1) { return b ? `${(a / b * 100).toFixed(d)}%` : '–'; }
function yen(n) { return `¥${Math.round(n).toLocaleString('ja-JP')}`; }
function plusMonths(st) {
  const months = [...st.monthly.values()].filter(m => m.invest > 0);
  return {plus: months.filter(m => m.ret > m.invest).length, total: months.length};
}

function main() {
  for (const file of [WIN_FILE, VERIFY_FILE]) {
    if (!fs.existsSync(file)) throw new Error(`${file} がありません`);
  }
  const model = WM.loadModel(MODEL_FILE);
  if (!model) throw new Error(`${MODEL_FILE} を読み込めません`);
  const winRows = JSON.parse(fs.readFileSync(WIN_FILE, 'utf8'));
  const verifyRows = JSON.parse(fs.readFileSync(VERIFY_FILE, 'utf8'));
  const verifyById = new Map(verifyRows.map(r => [r.race_id, r]));
  const stats = PERIODS.map(() => ({
    baseline: Object.fromEntries(BET_TYPES.map(bt => [bt, newStat()])),
    stable: Object.fromEntries(BET_TYPES.map(bt => [bt, newStat()])),
    upset: Object.fromEntries(BET_TYPES.map(bt => [bt, newStat()])),
    modelWin: {stable: newStat(), upset: newStat()},
    decisions: {stable: 0, upset: 0},
    failures: {stable: new Map(), upset: new Map()},
  }));

  let joined = 0;
  for (const row of winRows) {
    const verify = verifyById.get(row.race_id);
    if (!verify) continue;
    joined++;
    const predicted = WM.predictWinModel(row.horses, model);
    const signals = RS.summarizeRace(row, verify, predicted, model.features || []);
    const decisions = RS.evaluateRace(signals);
    PERIODS.forEach((period, pi) => {
      if (row.date < period.from || row.date > period.to) return;
      const ps = stats[pi];
      for (const bt of BET_TYPES) addBet(ps.baseline[bt], row.date, verify.per_bet && verify.per_bet[bt], true);
      for (const profile of PROFILES) {
        const decision = decisions[profile];
        const buy = decision.decision === 'buy';
        if (buy) ps.decisions[profile]++;
        else for (const reason of decision.reasons) ps.failures[profile].set(reason.code, (ps.failures[profile].get(reason.code) || 0) + 1);
        for (const bt of BET_TYPES) addBet(ps[profile][bt], row.date, verify.per_bet && verify.per_bet[bt], buy);
        const pickNum = profile === 'stable' ? signals.modelTopNum : signals.valuePickNum;
        const picked = row.horses.find(h => h.num === pickNum);
        const modelPb = picked ? {invest: 100, ret: picked.won && picked.odds > 0 ? picked.odds * 100 : 0} : null;
        addBet(ps.modelWin[profile], row.date, modelPb, buy);
      }
    });
  }

  console.log('================================================================================');
  console.log(' レース選別バックテスト（安定型／荒れ狙い型・買う／買わない）');
  console.log(` 結合データ: ${joined.toLocaleString()}レース / モデル: ${model.version}`);
  console.log(' ※ 買い目は既存keibaLabの券種別固定ルール。オッズ・払戻は確定値。');
  console.log(' ※ 閾値は初期仮説であり未調整。ここでは選別信号の有効性を測る。');
  console.log('================================================================================');

  PERIODS.forEach((period, pi) => {
    const ps = stats[pi];
    const raceCount = ps.baseline[BET_TYPES[0]].races;
    console.log(`\n■ ${period.name} ${period.from}〜${period.to === '9999-12-31' ? '最終日' : period.to}（${raceCount.toLocaleString()}R）`);
    for (const profile of PROFILES) {
      const label = RS.DEFAULT_PROFILES[profile].label;
      console.log(`\n  [${label}] 買う ${ps.decisions[profile].toLocaleString()}R / ${pct(ps.decisions[profile], raceCount)}を選別`);
      console.log('  券種       購入R  的中率    投資→払戻             回収率  最大連敗  最大DD     月間プラス');
      for (const bt of BET_TYPES) {
        const st = ps[profile][bt];
        const pm = plusMonths(st);
        console.log(`  ${bt.padEnd(4, '　')} ${String(st.buys).padStart(6)}  ${pct(st.hits, st.buys).padStart(7)}  ${(yen(st.invest) + '→' + yen(st.ret)).padStart(21)}  ${pct(st.ret, st.invest).padStart(7)}  ${String(st.maxLoseStreak).padStart(8)}  ${yen(st.maxDd).padStart(9)}  ${pct(pm.plus, pm.total).padStart(10)}`);
      }
      const mw = ps.modelWin[profile], mwMonths = plusMonths(mw);
      console.log(`  AI単勝　 ${String(mw.buys).padStart(6)}  ${pct(mw.hits, mw.buys).padStart(7)}  ${(yen(mw.invest) + '→' + yen(mw.ret)).padStart(21)}  ${pct(mw.ret, mw.invest).padStart(7)}  ${String(mw.maxLoseStreak).padStart(8)}  ${yen(mw.maxDd).padStart(9)}  ${pct(mwMonths.plus, mwMonths.total).padStart(10)}`);
      const failures = [...ps.failures[profile].entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`  主な見送り理由: ${failures.map(([k, n]) => `${k}=${n.toLocaleString()}`).join(' / ')}`);
    }
    console.log('\n  [比較：全レース購入]');
    console.log('  ' + BET_TYPES.map(bt => `${bt} ${pct(ps.baseline[bt].ret, ps.baseline[bt].invest)}`).join(' / '));
  });
}

main();
