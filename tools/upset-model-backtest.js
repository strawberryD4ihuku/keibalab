'use strict';

const fs = require('fs');
const UM = require('../lib/upset-model.js');

const rows = JSON.parse(fs.readFileSync(process.argv[2] || 'jvdata2000/win_value_rows.json', 'utf8'));
const model = UM.loadModel(process.argv[3] || UM.MODEL_PATH);
if (!model) throw new Error('穴モデルを読み込めません');

const classGroup = s => /G1|G2|G3|重賞|リステッド|L/.test(String(s || '')) ? '重賞L' : /新馬|未勝利/.test(String(s || '')) ? '新馬未勝利' : /1勝|2勝|3勝/.test(String(s || '')) ? '条件戦' : 'OP他';
const axes = {
  class: r => classGroup(r.race_class),
  surface: r => r.surface,
  field: r => r.field <= 9 ? '少' : r.field <= 13 ? '中' : '多',
  distance: r => r.distance <= 1400 ? '短' : r.distance <= 1800 ? 'マイル' : r.distance <= 2400 ? '中距離' : '長',
};
const periods = [
  {name: '学習2015-21', test: r => r.date >= '2015-01-01' && r.date <= '2021-12-31'},
  {name: '調整2022-23', test: r => r.date >= '2022-01-01' && r.date <= '2023-12-31'},
  {name: '評価2024-', test: r => r.date >= '2024-01-01'},
];

function stat() { return {n: 0, hits: 0, ret: 0}; }
function add(s, row, pick) {
  const h = row.horses.find(x => x.num === pick.num);
  s.n++; if (h && (h.won || h.rank === 1)) { s.hits++; s.ret += h.odds * 100; }
}
function fmt(s) { return `${s.n}件 的${s.n ? (s.hits / s.n * 100).toFixed(1) : '–'}% 回${s.n ? (s.ret / s.n).toFixed(1) : '–'}%`; }

for (const threshold of [95, 100, 105, 110]) {
  console.log(`\n■ 予測EV ${threshold}%以上`);
  for (const period of periods) {
    const all = stat(), groups = new Map();
    for (const row of rows) {
      if (!period.test(row)) continue;
      const {pick} = UM.selectPick(row, model, threshold);
      if (!pick) continue;
      add(all, row, pick);
      for (const [axis, fn] of Object.entries(axes)) {
        const key = `${axis}=${fn(row)}`;
        if (!groups.has(key)) groups.set(key, stat());
        add(groups.get(key), row, pick);
      }
    }
    console.log(`  ${period.name}: 全体 ${fmt(all)}`);
    console.log('    ' + [...groups.entries()].filter(([, s]) => s.n >= 10)
      .sort((a, b) => b[1].n - a[1].n).map(([k, s]) => `${k} ${fmt(s)}`).join(' / '));
  }
}
