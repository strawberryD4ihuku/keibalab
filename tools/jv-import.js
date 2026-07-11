// JV-Link の生データ(jvdata/RA.txt, SE.txt, HR.txt)から
// verify_results 互換の検証行を生成する。
//
// 使い方: node tools/jv-import.js [--dir jvdata] [--min-date 2026-01-01] [--out jvdata/verify_rows.json]
//
// スコアリングは index.html から computeScore 等を実行時に抽出して使う
// （フロントと完全に同一のロジック・重みを保証し、将来の変更にも自動追従）。
// 産駒補正(sireFit)はJV-DataのRACE系に血統がないため null（フロントの欠損時挙動と同じ＝重み再配分）。
'use strict';
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

// ---- 引数 ----
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const DIR = argOf('--dir', 'jvdata');
const MIN_DATE = argOf('--min-date', '0000-00-00');
const OUT = argOf('--out', path.join(DIR, 'verify_rows.json'));

const VENUE = {'01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京', '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉'};

// ---- index.html からスコアリング関数を抽出 ----
// `function NAME(` / `const NAME =` から括弧の対応で宣言全体を切り出す
function extractDecl(src, name) {
  let start = src.indexOf(`function ${name}(`);
  let isFunc = start >= 0;
  if (!isFunc) start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`index.htmlから ${name} を抽出できません`);
  let i = src.indexOf(isFunc ? '{' : '=', start);
  if (isFunc) {
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
  } else {
    // const: 深さ0のセミコロンまで
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
      else if (c === ';' && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} の抽出で括弧が閉じません`);
}

function loadScoring() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const names = ['hashStr', 'JOCKEY_RATING', 'jockeyRating', 'jockeyRateComp', 'AXIS_WEIGHTS',
    'sireFitComp', 'computeScore', 'BET_CONFIG', 'rankForBet', 'buildCombos', 'ORDERED_BETS', 'comboPayout'];
  const decls = names.map(n => extractDecl(src, n)).join('\n');
  const factory = new Function(`
    let currentAxis = '馬柱';
    let currentRaceSurface = null;
    ${decls}
    return {
      setSurface: s => { currentRaceSurface = s; },
      computeScore, rankForBet, buildCombos, comboPayout, BET_CONFIG,
    };
  `);
  return factory();
}

// ---- 生レコード読み込みヘルパー ----
const g = (b, off, len) => b.slice(off, off + len).toString('latin1');
const gz = (b, off, len) => iconv.decode(b.slice(off, off + len), 'cp932');
const num = (b, off, len) => {
  const s = g(b, off, len).trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : 0;
};
function readLines(file) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => iconv.encode(l, 'cp932'));
}

// ---- RA: レース情報（キー→最後のレコードを採用） ----
function parseRA() {
  const races = new Map();
  for (const b of readLines('RA.txt')) {
    const key = g(b, 11, 27 - 11);
    const venueCode = key.slice(8, 10);
    if (!VENUE[venueCode]) continue;   // 地方・海外はスキップ
    const track = num(b, 705, 2);
    races.set(key, {
      key,
      date: `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
      venueCode,
      venue: VENUE[venueCode],
      raceNum: parseInt(key.slice(14, 16), 10),
      raceId: key.slice(0, 4) + key.slice(8, 16),   // netkeiba互換12桁
      distance: num(b, 697, 4) || null,
      surface: track >= 51 ? '障' : track >= 23 ? 'ダ' : track >= 10 ? '芝' : null,
      field: num(b, 883, 2) || null,
    });
  }
  return races;
}

// ---- SE: 出走馬（キー＋馬番→最後のレコードを採用） ----
function parseSE() {
  const entries = new Map();
  for (const b of readLines('SE.txt')) {
    const key = g(b, 11, 16);
    if (!VENUE[key.slice(8, 10)]) continue;
    const umaban = num(b, 28, 2);
    if (!umaban) continue;
    entries.set(key + '#' + umaban, {
      key,
      umaban,
      horseId: g(b, 30, 10),
      name: gz(b, 40, 36).replace(/[\s　]+$/g, ''),
      kinryo: num(b, 288, 3) / 10 || null,
      jockeyCode: g(b, 296, 5),
      jockeyName: gz(b, 306, 8).replace(/[\s　]+$/g, ''),
      rank: num(b, 334, 2),                    // 0 = 取消・除外・中止
      odds: num(b, 359, 4) / 10 || null,       // 単勝オッズ（確定）
      ninki: num(b, 363, 2) || null,
      agari: num(b, 390, 3) / 10 || null,      // 後3F
    });
  }
  return [...entries.values()];
}

// ---- HR: 払戻（フロントの comboPayout 互換形式に変換） ----
function parseHR() {
  const BLOCKS = [
    {bet: '単勝', start: 102, count: 3, numLen: 2, yenLen: 9, ninLen: 2},
    {bet: '複勝', start: 141, count: 5, numLen: 2, yenLen: 9, ninLen: 2},
    {bet: '馬連', start: 245, count: 3, numLen: 4, yenLen: 9, ninLen: 3},
    {bet: 'ワイド', start: 293, count: 7, numLen: 4, yenLen: 9, ninLen: 3},
    {bet: '馬単', start: 453, count: 6, numLen: 4, yenLen: 9, ninLen: 3},
    {bet: '3連複', start: 549, count: 3, numLen: 6, yenLen: 9, ninLen: 3},
    {bet: '3連単', start: 603, count: 6, numLen: 6, yenLen: 9, ninLen: 4},
  ];
  const payoutsByKey = new Map();
  for (const b of readLines('HR.txt')) {
    const key = g(b, 11, 16);
    if (!VENUE[key.slice(8, 10)]) continue;
    const payouts = {};
    for (const blk of BLOCKS) {
      const entrySize = blk.numLen + blk.yenLen + blk.ninLen;
      const list = [];
      for (let i = 0; i < blk.count; i++) {
        const off = blk.start + i * entrySize;
        const numsStr = g(b, off, blk.numLen);
        const yen = num(b, off + blk.numLen, blk.yenLen);
        if (!yen || !/^\d+$/.test(numsStr)) continue;
        const nums = [];
        for (let j = 0; j < blk.numLen; j += 2) nums.push(parseInt(numsStr.slice(j, j + 2), 10));
        if (nums.some(n => n === 0)) continue;
        list.push({nums, yen});
      }
      if (list.length) payouts[blk.bet] = list;
    }
    if (Object.keys(payouts).length) payoutsByKey.set(key, payouts);
  }
  return payoutsByKey;
}

// ---- メイン ----
function main() {
  const scoring = loadScoring();
  const races = parseRA();
  const seAll = parseSE();
  const payoutsByKey = parseHR();
  console.log(`RA=${races.size}レース SE=${seAll.length}頭走 HR=${payoutsByKey.size}レース分の払戻`);

  // 馬・騎手の走歴インデックス（日付昇順）
  const byHorse = new Map();
  const byJockey = new Map();
  for (const e of seAll) {
    const race = races.get(e.key);
    if (!race || !e.rank) continue;   // 取消等は履歴に入れない
    const run = {date: race.date, rank: e.rank, agari: e.agari, surface: race.surface, distance: race.distance, venueCode: race.venueCode};
    if (!byHorse.has(e.horseId)) byHorse.set(e.horseId, []);
    byHorse.get(e.horseId).push(run);
    if (!byJockey.has(e.jockeyCode)) byJockey.set(e.jockeyCode, []);
    byJockey.get(e.jockeyCode).push({date: race.date, rank: e.rank});
  }
  for (const arr of byHorse.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  for (const arr of byJockey.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

  // レースごとの出走表
  const lineupByKey = new Map();
  for (const e of seAll) {
    if (!lineupByKey.has(e.key)) lineupByKey.set(e.key, []);
    lineupByKey.get(e.key).push(e);
  }

  const rows = [];
  const raceList = [...races.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const race of raceList) {
    if (race.date < MIN_DATE) continue;
    const payouts = payoutsByKey.get(race.key);
    if (!payouts) continue;   // 結果未確定 or 中止
    const lineup = (lineupByKey.get(race.key) || []).filter(e => e.odds || e.ninki);   // 取消馬を除く
    if (lineup.length < 5) continue;

    scoring.setSurface(race.surface);
    const horses = lineup.map(e => {
      // レース当日より前の走歴のみ使用（リーク防止・フロントと同じ規約）
      const runs = (byHorse.get(e.horseId) || []).filter(r => r.date < race.date);
      const past = runs.slice(-5).reverse();
      const career = {n: 0, w: 0, p3: 0, fitN: 0, fitW: 0, fitP3: 0, venueN: 0, venueP3: 0};
      for (const r of runs) {
        career.n++;
        if (r.rank === 1) career.w++;
        if (r.rank <= 3) career.p3++;
        if (r.surface === race.surface && r.distance && race.distance && Math.abs(r.distance - race.distance) <= 200) {
          career.fitN++;
          if (r.rank === 1) career.fitW++;
          if (r.rank <= 3) career.fitP3++;
        }
        if (r.venueCode === race.venueCode) {
          career.venueN++;
          if (r.rank <= 3) career.venueP3++;
        }
      }
      // 騎手: レース前の直近300騎乗
      const jr = (byJockey.get(e.jockeyCode) || []).filter(r => r.date < race.date).slice(-300);
      const jockeyStats = jr.length ? {rides: jr.length, top3: jr.filter(r => r.rank <= 3).length} : null;
      return {
        num: e.umaban, name: e.name, jockey: e.jockeyName, kinryo: e.kinryo,
        odds: e.odds, ninki: e.ninki, age3f: past[0]?.agari || null,
        p1: past[0]?.rank ?? null, p2: past[1]?.rank ?? null, p3: past[2]?.rank ?? null,
        p4: past[3]?.rank ?? null, p5: past[4]?.rank ?? null,
        career: career.n ? career : null,
        jockeyStats,
        sireStats: null,
      };
    });
    horses.forEach(h => { h.score = scoring.computeScore(h); });

    const perBet = {};
    for (const bt in scoring.BET_CONFIG) {
      const cfg = scoring.BET_CONFIG[bt];
      const picks = scoring.rankForBet(horses, cfg).slice(0, cfg.marks.length);
      const combos = scoring.buildCombos(bt, picks);
      if (!combos.length) continue;
      const ret = combos.reduce((s, c) => s + scoring.comboPayout(bt, c, payouts), 0);
      perBet[bt] = {invest: combos.length * 100, ret};
    }
    const ranked = scoring.rankForBet(horses, scoring.BET_CONFIG['馬連']);
    const axis = ranked[0], rival = ranked[1];
    rows.push({
      race_id: race.raceId, date: race.date, venue: race.venue, num: race.raceNum,
      field: horses.length, surface: race.surface, distance: race.distance,
      axis_odds: axis?.odds ?? null, axis_ninki: axis?.ninki ?? null,
      score_gap: axis && rival ? axis.score - rival.score : null,
      per_bet: perBet,
    });
  }

  fs.writeFileSync(OUT, JSON.stringify(rows));
  const byMonth = {};
  for (const r of rows) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] || 0) + 1;
  console.log(`出力: ${rows.length}行 -> ${OUT}`);
  console.log('月別:', Object.entries(byMonth).map(([m, c]) => `${m}=${c}`).join(' '));
}

main();
