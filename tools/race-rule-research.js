'use strict';

const fs = require('fs');

const file = process.argv[2] || 'jvdata2000/verify_rows.json';
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
const BETS = ['単勝', '複勝', 'ワイド', '馬連', '馬単', '3連複', '3連単'];
const PERIODS = {
  train: r => r.date >= '2015-01-01' && r.date <= '2021-12-31',
  calibration: r => r.date >= '2022-01-01' && r.date <= '2023-12-31',
  test: r => r.date >= '2024-01-01',
};

const classGroup = s => !s ? null : /新馬|未勝利/.test(s) ? '新馬未勝利' : /1勝|2勝|3勝/.test(s) ? '条件戦' : /G1|G2|G3|重賞|リステッド|L/.test(s) ? '重賞L' : 'OP他';
const axes = {
  field: r => r.field <= 9 ? 'small' : r.field <= 13 ? 'medium' : 'large',
  surface: r => r.surface || null,
  distance: r => r.distance <= 1400 ? 'sprint' : r.distance <= 1800 ? 'mile' : r.distance <= 2400 ? 'middle' : 'long',
  class: r => classGroup(r.race_class),
  baba: r => r.baba === '良' ? 'good' : r.baba ? 'soft' : null,
  axisOdds: r => r.axis_odds < 2 ? 'lt2' : r.axis_odds < 3.5 ? '2-3.4' : r.axis_odds < 7 ? '3.5-6.9' : r.axis_odds < 15 ? '7-14.9' : '15+',
  axisPopularity: r => r.axis_ninki <= 1 ? '1' : r.axis_ninki <= 3 ? '2-3' : r.axis_ninki <= 6 ? '4-6' : '7+',
  scoreGap: r => r.score_gap <= 1 ? 'close' : r.score_gap <= 4 ? 'medium' : 'clear',
};
const axisNames = Object.keys(axes);
const axisSets = axisNames.map(a => [a]);
for (let i = 0; i < axisNames.length; i++) for (let j = i + 1; j < axisNames.length; j++) axisSets.push([axisNames[i], axisNames[j]]);

function stat() { return {n: 0, hits: 0, invest: 0, ret: 0, z2: 0}; }
function add(s, pb) {
  s.n++; s.invest += pb.invest; s.ret += pb.ret || 0;
  if (pb.ret > 0) s.hits++;
}
function finish(s) {
  s.roi = s.invest ? s.ret / s.invest * 100 : 0;
  s.hitRate = s.n ? s.hits / s.n * 100 : 0;
  return s;
}
function matches(r, conds) { return conds.every(c => axes[c.axis](r) === c.value); }
function evaluate(conds, bet, pred) {
  const s = stat();
  for (const r of rows) {
    if (!pred(r) || !matches(r, conds)) continue;
    const pb = r.per_bet && r.per_bet[bet];
    if (pb && pb.invest) add(s, pb);
  }
  return finish(s);
}

const candidates = [];
for (const set of axisSets) {
  const groups = new Map();
  for (const r of rows) {
    if (!PERIODS.train(r)) continue;
    const vals = set.map(a => axes[a](r));
    if (vals.some(v => v == null)) continue;
    const key = vals.join('|');
    if (!groups.has(key)) groups.set(key, {conds: set.map((axis, i) => ({axis, value: vals[i]})), bets: Object.fromEntries(BETS.map(b => [b, stat()]))});
    const g = groups.get(key);
    for (const bet of BETS) {
      const pb = r.per_bet && r.per_bet[bet];
      if (pb && pb.invest) add(g.bets[bet], pb);
    }
  }
  for (const g of groups.values()) for (const bet of BETS) {
    const train = finish(g.bets[bet]);
    if (train.n < 300) continue;
    candidates.push({bet, conds: g.conds, train});
  }
}

for (const c of candidates) {
  c.calibration = evaluate(c.conds, c.bet, PERIODS.calibration);
  c.test = evaluate(c.conds, c.bet, PERIODS.test);
}

const stable = candidates.filter(c => c.calibration.n >= 150 && c.train.hitRate >= 35 && c.calibration.hitRate >= 35)
  .sort((a, b) => (b.calibration.roi + b.calibration.hitRate * 0.15) - (a.calibration.roi + a.calibration.hitRate * 0.15));
const upset = candidates.filter(c => c.calibration.n >= 100 && c.train.roi >= 80)
  .sort((a, b) => b.calibration.roi - a.calibration.roi);

function show(title, xs) {
  console.log(`\n■ ${title}`);
  console.log('券種   条件                                      学習 n/的中/ROI       調整 n/的中/ROI       過去評価 n/的中/ROI');
  for (const c of xs.slice(0, 20)) {
    const cond = c.conds.map(x => `${x.axis}=${x.value}`).join(',');
    const fmt = s => `${String(s.n).padStart(5)}/${s.hitRate.toFixed(1).padStart(4)}%/${s.roi.toFixed(1).padStart(5)}%`;
    console.log(`${c.bet.padEnd(4, '　')} ${cond.padEnd(40)} ${fmt(c.train)}  ${fmt(c.calibration)}  ${fmt(c.test)}`);
  }
}

console.log(`候補ルール ${candidates.length.toLocaleString()}件（学習期300R以上）`);
show('安定候補（学習・調整とも的中率35%以上、調整期順）', stable);
show('荒れ候補（学習ROI80%以上、調整期ROI順）', upset);
