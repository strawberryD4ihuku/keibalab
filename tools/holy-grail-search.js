'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const FILE = argOf('--file', 'jvdata2000/verify_rows.json');
const MIN_TOTAL = Number(argOf('--min-total', 300));
const MIN_PERIOD = Number(argOf('--min-period', 40));
const MAX_AXES = Math.max(1, Math.min(3, Number(argOf('--max-axes', 3))));

const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const BETS = ['単勝', '複勝', 'ワイド', '馬連', '馬単', '3連複', '3連単'];
const PERIODS = [
  {name: '2015-18', test: r => r.date >= '2015-01-01' && r.date <= '2018-12-31'},
  {name: '2019-21', test: r => r.date >= '2019-01-01' && r.date <= '2021-12-31'},
  {name: '2022-23', test: r => r.date >= '2022-01-01' && r.date <= '2023-12-31'},
  {name: '2024-', test: r => r.date >= '2024-01-01'},
];

const classGroup = s => !s ? null : /新馬|未勝利/.test(s) ? '新馬未勝利' : /1勝|2勝|3勝/.test(s) ? '条件戦' : /G1|G2|G3|重賞|リステッド|L/.test(s) ? '重賞L' : 'OP他';
const season = date => {
  const m = Number(String(date).slice(5, 7));
  return m >= 3 && m <= 5 ? '春' : m <= 8 ? '夏' : m <= 11 ? '秋' : '冬';
};
const AXES = {
  頭数: r => r.field <= 9 ? '少頭数' : r.field <= 13 ? '中頭数' : '多頭数',
  馬場: r => r.surface || null,
  距離: r => r.distance <= 1400 ? '短距離' : r.distance <= 1800 ? 'マイル' : r.distance <= 2400 ? '中距離' : '長距離',
  クラス: r => classGroup(r.race_class),
  馬場状態: r => r.baba === '良' ? '良' : r.baba ? '道悪' : null,
  軸オッズ: r => r.axis_odds < 2 ? '1.9以下' : r.axis_odds < 3.5 ? '2.0-3.4' : r.axis_odds < 7 ? '3.5-6.9' : r.axis_odds < 15 ? '7.0-14.9' : '15以上',
  軸人気: r => r.axis_ninki <= 1 ? '1人気' : r.axis_ninki <= 3 ? '2-3人気' : r.axis_ninki <= 6 ? '4-6人気' : '7人気以下',
  スコア差: r => r.score_gap <= 1 ? '接戦' : r.score_gap <= 4 ? '中' : '明確',
  場: r => r.venue || null,
  季節: r => season(r.date),
  R帯: r => r.num <= 4 ? '前半' : r.num <= 8 ? '中盤' : '後半',
};

function combinations(xs, maxLen) {
  const out = [];
  function visit(start, picked, target) {
    if (picked.length === target) { out.push([...picked]); return; }
    for (let i = start; i < xs.length; i++) { picked.push(xs[i]); visit(i + 1, picked, target); picked.pop(); }
  }
  for (let n = 1; n <= maxLen; n++) visit(0, [], n);
  return out;
}

function fresh() { return {n: 0, hits: 0, invest: 0, ret: 0, sxx: 0, syy: 0, sxy: 0, maxRet: 0, maxInvest: 0}; }
function add(s, pb) {
  const x = Number(pb.invest) || 0, y = Number(pb.ret) || 0;
  if (!(x > 0)) return;
  s.n++; s.invest += x; s.ret += y; s.sxx += x * x; s.syy += y * y; s.sxy += x * y;
  if (y > 0) s.hits++;
  if (y > s.maxRet) { s.maxRet = y; s.maxInvest = x; }
}
function metrics(s) {
  if (!s.n || !s.invest) return {...s, roi: 0, lower: 0, hitRate: 0, withoutMax: 0, maxShare: 0};
  const ratio = s.ret / s.invest;
  const varZ = Math.max(0, (s.syy - 2 * ratio * s.sxy + ratio * ratio * s.sxx) / s.n);
  const se = Math.sqrt(varZ / s.n) / (s.invest / s.n);
  const investWithout = s.invest - s.maxInvest;
  return {
    ...s,
    roi: ratio * 100,
    lower: Math.max(0, (ratio - 1.645 * se) * 100),
    hitRate: s.hits / s.n * 100,
    withoutMax: investWithout > 0 ? (s.ret - s.maxRet) / investWithout * 100 : 0,
    maxShare: s.ret > 0 ? s.maxRet / s.ret * 100 : 0,
  };
}

const axisSets = combinations(Object.keys(AXES), MAX_AXES);
const periodIndex = rows.map(r => PERIODS.findIndex(p => p.test(r)));
const groups = new Map();

for (let ri = 0; ri < rows.length; ri++) {
  const r = rows[ri], pi = periodIndex[ri];
  if (pi < 0) continue;
  const vals = Object.fromEntries(Object.entries(AXES).map(([name, fn]) => [name, fn(r)]));
  for (const axes of axisSets) {
    if (axes.some(a => vals[a] == null)) continue;
    const conds = axes.map(a => `${a}=${vals[a]}`);
    const keyBase = conds.join('|');
    for (const bet of BETS) {
      const pb = r.per_bet && r.per_bet[bet];
      if (!pb || !(pb.invest > 0)) continue;
      const key = `${bet}|${keyBase}`;
      let g = groups.get(key);
      if (!g) {
        g = {bet, conds, periods: PERIODS.map(() => fresh()), total: fresh()};
        groups.set(key, g);
      }
      add(g.periods[pi], pb); add(g.total, pb);
    }
  }
}

const results = [];
for (const g of groups.values()) {
  g.periods = g.periods.map(metrics); g.total = metrics(g.total);
  if (g.total.n < MIN_TOTAL || g.periods.some(s => s.n < MIN_PERIOD)) continue;
  g.positivePeriods = g.periods.filter(s => s.roi >= 100).length;
  g.worstPeriodRoi = Math.min(...g.periods.map(s => s.roi));
  g.stability = g.periods.reduce((s, x) => s + Math.abs(x.roi - g.total.roi), 0) / g.periods.length;
  results.push(g);
}

const durable = results.filter(g => g.positivePeriods >= 3 && g.total.roi >= 100 && g.total.withoutMax >= 95)
  .sort((a, b) => b.positivePeriods - a.positivePeriods || b.worstPeriodRoi - a.worstPeriodRoi || b.total.lower - a.total.lower);
const profitable = results.filter(g => g.total.roi >= 100)
  .sort((a, b) => b.total.lower - a.total.lower || b.total.roi - a.total.roi);
const mirages = results.filter(g => g.total.roi >= 105 && (g.positivePeriods <= 1 || g.total.withoutMax < 90 || g.total.maxShare >= 35))
  .sort((a, b) => b.total.roi - a.total.roi);

function fmt(s) { return `${s.n}R 的${s.hitRate.toFixed(1)}% 回${s.roi.toFixed(1)}%`; }
function show(title, list, limit = 25) {
  console.log(`\n■ ${title}（${list.length.toLocaleString()}件）`);
  if (!list.length) { console.log('  該当なし'); return; }
  for (const g of list.slice(0, limit)) {
    console.log(`\n  ${g.bet}｜${g.conds.join('・')}`);
    console.log(`  全体 ${fmt(g.total)} 下限${g.total.lower.toFixed(1)}% 最大払戻除外${g.total.withoutMax.toFixed(1)}% 最大寄与${g.total.maxShare.toFixed(1)}%`);
    console.log(`  ${g.periods.map((s, i) => `${PERIODS[i].name} ${s.roi.toFixed(1)}%(${s.n})`).join(' / ')}`);
  }
}

console.log('================================================================================');
console.log(' 聖杯候補探索：条件1〜3個 × 7券種 × 4期間');
console.log(` 元データ ${rows.length.toLocaleString()}R / 条件軸組 ${axisSets.length} / 集計群 ${groups.size.toLocaleString()}`);
console.log(` 採用最低件数 全体${MIN_TOTAL}R・各期間${MIN_PERIOD}R`);
console.log(' 「耐久候補」は4期間中3期間以上プラス、全体プラス、最大払戻を除いて回収率95%以上。');
console.log('================================================================================');
show('期間をまたいで残った耐久候補', durable);
show('全期間プラス収支（統計的下限順）', profitable);
show('一発配当・特定期間依存の疑いが強い候補', mirages, 15);

const summary = {};
for (const g of durable) {
  summary[g.bet] = summary[g.bet] || {count: 0, axes: new Map(), values: new Map()};
  const s = summary[g.bet]; s.count++;
  for (const cond of g.conds) {
    const [axis, value] = cond.split('=');
    s.axes.set(axis, (s.axes.get(axis) || 0) + 1);
    s.values.set(cond, (s.values.get(cond) || 0) + 1);
  }
}
console.log('\n■ 耐久候補に多い共通傾向');
for (const [bet, s] of Object.entries(summary)) {
  const top = [...s.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}(${n})`).join(' / ');
  console.log(`  ${bet}: ${s.count}候補｜${top}`);
}
