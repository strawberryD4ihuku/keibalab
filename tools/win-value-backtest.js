// 単勝の時系列バックテスト＋予測モデル比較
// 実行: npm run backtest:win （= node tools/win-value-backtest.js [--dir jvdata2000]）
//
// 比較する3モデル：
//   [市場]   市場確率のみ（正規化した1/オッズ）
//   [旧方式] 市場logit + SCORE_COEF×スコアz（前回MVPの方式・保存済みの値）
//   [総合]   市場オフセット付きsoftmax（models/win-model.json・2015-2021で学習）
//
// 指標: LogLoss（レースごとの勝ち馬の-log p平均）/ Brier（全馬の(p-won)^2平均）/
//       1位予測的中率 / 予測勝率帯の校正 / 期待回収率帯の実回収率 / 購入成績
//
// 重要な制約:
//   - オッズは「確定オッズ」。発売中に同じオッズで買える保証はない
//   - 2024年以降は既存方式の確認で参照済みのため「過去評価」であり完全未使用テストではない
//   - 閾値120%・安全率0.95は固定。回収率だけでモデルを選ばない
'use strict';
const fs = require('fs');
const path = require('path');
const WV = require('../lib/win-value.js');
const WM = require('../lib/win-model.js');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const DIR = argOf('--dir', 'jvdata2000');
const WIN_FILE = argOf('--win', path.join(DIR, 'win_value_rows.json'));
const VERIFY_FILE = argOf('--verify', path.join(DIR, 'verify_rows.json'));
const MODEL_FILE = argOf('--model', WM.MODEL_PATH);

const THRESHOLD = WV.WIN_VALUE_CONFIG.VALUE_BET_THRESHOLD;   // 120（固定）
const SAFETY = WV.WIN_VALUE_CONFIG.ODDS_SAFETY_FACTOR;       // 0.95（固定）

// 時系列分割（固定）。2024以降は既存方式の確認で参照済みのため「過去評価」と呼ぶ
const PERIODS = [
  {name: '学習・設計 2015-01-01〜2021-12-31', from: '2015-01-01', to: '2021-12-31'},
  {name: '調整確認   2022-01-01〜2023-12-31', from: '2022-01-01', to: '2023-12-31'},
  {name: '過去評価   2024-01-01〜データ最終日（完全未使用テストではない）', from: '2024-01-01', to: '9999-12-31'},
  {name: '全期間', from: '0000-01-01', to: '9999-12-31'},
];

const MODELS = ['市場', '旧方式', '総合'];
const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
const pct = (a, b, d = 1) => b ? (a / b * 100).toFixed(d) + '%' : '–';

const PROB_BANDS = [[0, 2], [2, 5], [5, 10], [10, 20], [20, 30], [30, 50], [50, 101]];
const ROI_BANDS = [[0, 60], [60, 80], [80, 90], [90, 100], [100, 110], [110, 1e9]];

function newModelStat() {
  return {
    sumLL: 0, llRaces: 0, sumBrier: 0, horses: 0, top1: 0, races: 0,
    bands: PROB_BANDS.map(([lo, hi]) => ({lo, hi, n: 0, sumP: 0, wins: 0})),
    roiBands: ROI_BANDS.map(([lo, hi]) => ({lo, hi, n: 0, ret: 0, wins: 0})),
    bet: {n: 0, hits: 0, invest: 0, ret: 0, loseStreak: 0, maxLoseStreak: 0, cumNet: 0, minCumNet: 0,
      sumOdds: 0, sumProb: 0, sumEv: 0},
  };
}

// 1レース分・1モデル分の確率配列を統計へ反映（購入は閾値120%・1レース最大1点）
function addRace(st, horses, probs) {
  let top = null, winnerP = null, pick = null;
  horses.forEach((h, i) => {
    const p = probs[i];
    if (p == null || !(p > 0)) return;
    const won = h.won === true || h.rank === 1;
    st.horses++;
    st.sumBrier += (p - (won ? 1 : 0)) ** 2;
    if (!top || p > top.p) top = {p, won};
    if (won) winnerP = p;
    const b = st.bands.find(x => p * 100 >= x.lo && p * 100 < x.hi);
    if (b) { b.n++; b.sumP += p; if (won) b.wins++; }
    if (h.odds > 0) {
      const ev = p * h.odds * SAFETY * 100;
      const rb = st.roiBands.find(x => ev >= x.lo && ev < x.hi);
      if (rb) { rb.n++; if (won) { rb.wins++; rb.ret += h.odds * 100; } }
      if (ev >= THRESHOLD && (!pick || ev > pick.ev || (ev === pick.ev && (p > pick.p || (p === pick.p && h.num < pick.num))))) {
        pick = {ev, p, num: h.num, odds: h.odds, won};
      }
    }
  });
  st.races++;
  if (winnerP != null) { st.sumLL += -Math.log(Math.max(winnerP, 1e-12)); st.llRaces++; }
  if (top && top.won) st.top1++;
  const bt = st.bet;
  if (pick) {
    bt.n++; bt.invest += 100;
    bt.sumOdds += pick.odds; bt.sumProb += pick.p; bt.sumEv += pick.ev;
    const ret = pick.won ? pick.odds * 100 : 0;
    bt.ret += ret;
    if (ret > 0) { bt.hits++; bt.loseStreak = 0; }
    else { bt.loseStreak++; if (bt.loseStreak > bt.maxLoseStreak) bt.maxLoseStreak = bt.loseStreak; }
    bt.cumNet += ret - 100;
    if (bt.cumNet < bt.minCumNet) bt.minCumNet = bt.cumNet;
  }
}

function main() {
  if (!fs.existsSync(WIN_FILE)) {
    console.error(`${WIN_FILE} がありません。先に node tools/jv-import.js --dir ${DIR} を実行してください`);
    process.exit(1);
  }
  const model = WM.loadModel(MODEL_FILE);
  const rows = JSON.parse(fs.readFileSync(WIN_FILE, 'utf8')).sort((a, b) => a.date.localeCompare(b.date));

  // 期間×モデルの統計
  const stats = PERIODS.map(() => Object.fromEntries(MODELS.map(m => [m, newModelStat()])));
  for (const row of rows) {
    const preds = model ? WM.predictWinModel(row.horses, model) : null;
    const probsBy = {
      '市場': row.horses.map(h => (h.marketProb > 0 ? h.marketProb : null)),
      '旧方式': row.horses.map(h => (h.predictedWinProb > 0 ? h.predictedWinProb : null)),
      '総合': preds ? preds.map(p => p.predictedWinProb) : row.horses.map(h => (h.marketProb > 0 ? h.marketProb : null)),
    };
    PERIODS.forEach((p, pi) => {
      if (row.date < p.from || row.date > p.to) return;
      for (const m of MODELS) addRace(stats[pi][m], row.horses, probsBy[m]);
    });
  }

  // ---- 出力 ----
  const last = rows.length ? rows[rows.length - 1].date : '?';
  console.log('====================================================================');
  console.log(' 単勝バックテスト（時系列分割・3モデル比較）');
  console.log(` データ: ${rows.length}レース（〜${last}） / 1点100円`);
  console.log(` 購入条件: 期待回収率${THRESHOLD}%以上のみ・1レース最大1点（安全率${SAFETY}）`);
  console.log(model
    ? ` 総合モデル: ${model.version}（学習 ${model.train.from}〜${model.train.to}・採用=${model.adopted ? '採用' : '不採用'}）`
    : ' 総合モデル: models/win-model.json なし → 市場確率で代替表示');
  console.log(' ※ オッズは確定オッズ。発売中オッズでの再現性は保証されない');
  console.log(' ※ 2024年以降は「過去評価」（既存方式の確認で参照済み・完全未使用テストではない）');
  console.log('====================================================================');

  PERIODS.forEach((p, pi) => {
    console.log(`\n■ ${p.name}`);
    const s0 = stats[pi][MODELS[0]];
    console.log(`  対象 ${s0.races.toLocaleString()}レース・${s0.horses.toLocaleString()}頭`);
    console.log('  モデル     LogLoss   Brier     1位的中   購入   的中(率)      投資→払戻            回収率  最大連敗/DD');
    for (const m of MODELS) {
      const st = stats[pi][m];
      const bt = st.bet;
      console.log(`  ${m.padEnd(4, '　')} ${(st.sumLL / (st.llRaces || 1)).toFixed(5)}  ${(st.sumBrier / (st.horses || 1)).toFixed(6)}  ${pct(st.top1, st.races).padStart(6)}  ${String(bt.n).padStart(5)}  ${String(bt.hits).padStart(4)}(${pct(bt.hits, bt.n, 0).padStart(4)})  ${(yen(bt.invest) + '→' + yen(bt.ret)).padStart(18)}  ${pct(bt.ret, bt.invest).padStart(6)}  ${bt.n ? bt.maxLoseStreak + '/' + yen(bt.minCumNet) : '–'}`);
    }
    // 校正表と期待回収率帯（学習期間以外で表示。全期間は省略）
    if (pi === 1 || pi === 2) {
      console.log('  --- 予測勝率帯の校正（予測平均% → 実勝率%）と期待回収率帯の実回収率% ---');
      for (const m of MODELS) {
        const st = stats[pi][m];
        const cal = st.bands.filter(b => b.n).map(b =>
          `${b.lo}-${b.hi === 101 ? '' : b.hi}%:${(b.sumP / b.n * 100).toFixed(1)}→${pct(b.wins, b.n)}`).join(' ');
        const roi = st.roiBands.filter(b => b.n).map(b =>
          `${b.lo}-${b.hi === 1e9 ? '' : b.hi}:${pct(b.ret, b.n * 100, 0)}(${b.n})`).join(' ');
        console.log(`  [${m}] 校正: ${cal}`);
        console.log(`  [${m}] EV帯: ${roi}`);
      }
    }
  });

  // ---- 参考：現行方式（毎レース◎の単勝を固定購入） ----
  if (fs.existsSync(VERIFY_FILE)) {
    const vr = JSON.parse(fs.readFileSync(VERIFY_FILE, 'utf8'));
    console.log('\n■ 参考：全レースで◎の単勝を固定購入した場合（現行の固定購入方式）');
    PERIODS.forEach(p => {
      let n = 0, hits = 0, invest = 0, ret = 0;
      for (const r of vr) {
        if (r.date < p.from || r.date > p.to) continue;
        const pb = r.per_bet && r.per_bet['単勝'];
        if (!pb || !pb.invest) continue;
        n++; invest += pb.invest; ret += pb.ret;
        if (pb.ret > 0) hits++;
      }
      if (n) console.log(`  ${p.name.split('（')[0].padEnd(24, '　').slice(0, 24)} ${String(n).padStart(6)}R  的中${pct(hits, n).padStart(6)}  ${yen(invest)}→${yen(ret)}  回収率${pct(ret, invest).padStart(6)}`);
    });
  }
  console.log('\n※ DD=最大ドローダウン簡易値（購入を続けた場合の累積損益の最小値）');
  console.log('※ Brier Score = 全馬の(予測勝率-勝敗)^2の平均。小さいほど良い');
}

main();
