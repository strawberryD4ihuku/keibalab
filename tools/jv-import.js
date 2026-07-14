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
const readline = require('readline');
const iconv = require('iconv-lite');
const PF = require('../lib/performance-features.js');

// ---- 引数 ----
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const DIR = argOf('--dir', 'jvdata');
const MIN_DATE = argOf('--min-date', '0000-00-00');
const OUT = argOf('--out', path.join(DIR, 'verify_rows.json'));
// 単勝・期待値判定用の全馬行（レース単位でグループ化）。'none'指定で出力を省略
const WIN_OUT = argOf('--win-out', path.join(DIR, 'win_value_rows.json'));

// 期待値計算はフロント（index.html）から抽出した同一実装を使う
const WV = require('../lib/win-value.js');

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
    'sireFitComp', 'computeScoreComponents', 'computeScore', 'BET_CONFIG', 'rankForBet', 'buildCombos', 'ORDERED_BETS', 'comboPayout'];
  const decls = names.map(n => extractDecl(src, n)).join('\n');
  const factory = new Function(`
    let currentAxis = '馬柱';
    let currentRaceSurface = null;
    ${decls}
    return {
      setSurface: s => { currentRaceSurface = s; },
      computeScoreComponents, computeScore, rankForBet, buildCombos, comboPayout, BET_CONFIG,
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
const signedTenths = (b, off, len) => {
  const s = g(b, off, len).trim();
  if (!/^[+-]\d+$/.test(s) || s === '+999' || s === '-999') return null;
  return parseInt(s, 10) / 10;
};
const raceTimeSeconds = (b, off) => {
  const s = g(b, off, 4);
  if (!/^\d{4}$/.test(s) || s === '0000' || s === '9999') return null;
  return parseInt(s[0], 10) * 60 + parseInt(s.slice(1), 10) / 10;
};
// 巨大ファイル（数GB）でも読めるよう1行ずつストリーミングで返す
async function* readLines(file) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) return;
  const rl = readline.createInterface({input: fs.createReadStream(p, {encoding: 'utf8'}), crlfDelay: Infinity});
  for await (const line of rl) {
    if (line) yield iconv.encode(line, 'cp932');
  }
}

// グレードコード→表示名（D=グレードなし重賞 / E=リステッド以外の特別・平場は空白）
const GRADE = {A: 'G1', B: 'G2', C: 'G3', D: '重賞', F: 'JG1', G: 'JG2', H: 'JG3', L: 'L'};
// 競走条件コード（5枠目=最若年条件）→ クラス名
const JYOKEN = {'701': '新馬', '702': '新馬', '703': '未勝利', '005': '1勝', '010': '2勝', '016': '3勝', '999': 'OP'};
const BABA = {1: '良', 2: '稍重', 3: '重', 4: '不良'};

// ---- RA: レース情報（キー→最後のレコードを採用） ----
async function parseRA() {
  const races = new Map();
  for await (const b of readLines('RA.txt')) {
    if (b.length < 890) continue;   // 途中で切れた行はスキップ
    const key = g(b, 11, 27 - 11);
    const venueCode = key.slice(8, 10);
    if (!VENUE[venueCode]) continue;   // 地方・海外はスキップ
    const track = num(b, 705, 2);
    const surface = track >= 51 ? '障' : track >= 23 ? 'ダ' : track >= 10 ? '芝' : null;
    // 馬場状態：ダートはダ馬場、芝・障は芝馬場（0=未設定はもう一方で補完）
    const babaCD = surface === 'ダ' ? (num(b, 889, 1) || num(b, 888, 1)) : (num(b, 888, 1) || num(b, 889, 1));
    races.set(key, {
      key,
      date: `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
      venueCode,
      venue: VENUE[venueCode],
      raceNum: parseInt(key.slice(14, 16), 10),
      raceId: key.slice(0, 4) + key.slice(8, 16),   // netkeiba互換12桁
      distance: num(b, 697, 4) || null,
      surface,
      field: num(b, 883, 2) || null,
      baba: BABA[babaCD] || null,
      raceClass: GRADE[g(b, 614, 1)] || JYOKEN[g(b, 634, 3)] || null,
    });
  }
  return races;
}

// ---- SE: 出走馬（キー＋馬番→最後のレコードを採用） ----
async function parseSE() {
  const entries = new Map();
  for await (const b of readLines('SE.txt')) {
    if (b.length < 400) continue;
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
      timeSec: raceTimeSeconds(b, 338),         // 走破タイム（秒）
      timeDiffSec: b.length >= 535 ? signedTenths(b, 531, 4) : null, // 1着馬との差（1着は2着へ負値）
      corner1: num(b, 351, 2) || null,
      corner2: num(b, 353, 2) || null,
      corner3: num(b, 355, 2) || null,
      corner4: num(b, 357, 2) || null,
      odds: num(b, 359, 4) / 10 || null,       // 単勝オッズ（確定）
      ninki: num(b, 363, 2) || null,
      agari: num(b, 390, 3) / 10 || null,      // 後3F
    });
  }
  return [...entries.values()];
}

// ---- HR: 払戻（フロントの comboPayout 互換形式に変換） ----
async function parseHR() {
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
  for await (const b of readLines('HR.txt')) {
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

// 同じ日より前の走破タイムだけから、コース条件別の速度指数を付与する。
// 同日レースは一括して「予測後」に基準へ追加するため、後半レースへの当日結果リークもない。
function attachSpeedFigures(seAll, races) {
  const byKey = new Map();
  for (const e of seAll) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }
  const groups = new Map();
  const keysFor = r => [
    `v|${r.venueCode}|${r.surface}|${r.distance}|${r.baba || ''}`,
    `v|${r.venueCode}|${r.surface}|${r.distance}`,
    `s|${r.surface}|${r.distance}`,
  ];
  const stat = key => {
    const a = groups.get(key);
    if (!a || a.length < 60) return null;
    const mean = a.reduce((s, x) => s + x, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length);
    return sd >= 0.5 ? {mean, sd} : null;
  };
  const raceList = [...races.values()].sort((a, b) => a.key.localeCompare(b.key));
  let i = 0;
  while (i < raceList.length) {
    const date = raceList[i].date;
    let j = i;
    while (j < raceList.length && raceList[j].date === date) j++;
    // 当日全レースの指数を、前日までの基準で計算
    for (let k = i; k < j; k++) {
      const race = raceList[k];
      const base = keysFor(race).map(stat).find(Boolean);
      if (!base) continue;
      for (const e of (byKey.get(race.key) || [])) {
        if (e.timeSec == null || !e.rank) continue;
        e.speedFigure = Math.max(-4, Math.min(4, (base.mean - e.timeSec) / base.sd));
      }
    }
    // 計算後に当日結果を基準へ追加（各条件は直近800頭走）
    for (let k = i; k < j; k++) {
      const race = raceList[k];
      for (const e of (byKey.get(race.key) || [])) {
        if (e.timeSec == null || !e.rank) continue;
        for (const key of keysFor(race)) {
          let a = groups.get(key);
          if (!a) { a = []; groups.set(key, a); }
          a.push(e.timeSec);
          if (a.length > 800) a.shift();
        }
      }
    }
    i = j;
  }
}

// ---- メイン ----
async function main() {
  const scoring = loadScoring();
  const races = await parseRA();
  const seAll = await parseSE();
  const payoutsByKey = await parseHR();
  console.log(`RA=${races.size}レース SE=${seAll.length}頭走 HR=${payoutsByKey.size}レース分の払戻`);
  attachSpeedFigures(seAll, races);

  // 馬・騎手の走歴インデックス（日付昇順）
  const byHorse = new Map();
  const byJockey = new Map();
  for (const e of seAll) {
    const race = races.get(e.key);
    if (!race || !e.rank) continue;   // 取消等は履歴に入れない
    const run = {
      date: race.date, rank: e.rank, agari: e.agari,
      surface: race.surface, distance: race.distance, venueCode: race.venueCode,
      raceClass: race.raceClass, timeSec: e.timeSec, timeDiffSec: e.timeDiffSec,
      speedFigure: e.speedFigure ?? null,
      corner1: e.corner1, corner2: e.corner2, corner3: e.corner3, corner4: e.corner4,
    };
    if (!byHorse.has(e.horseId)) byHorse.set(e.horseId, []);
    byHorse.get(e.horseId).push(run);
    if (!byJockey.has(e.jockeyCode)) byJockey.set(e.jockeyCode, []);
    byJockey.get(e.jockeyCode).push({date: race.date, rank: e.rank});
  }
  for (const arr of byHorse.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  // 騎手は騎乗数が多い（27年で2万超）ので、日付昇順＋複勝の累積和にして
  // 「レース前の直近300騎乗」を二分探索で O(log n) で引けるようにする
  const jockeyIdx = new Map();
  for (const [code, arr] of byJockey) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    const dates = arr.map(r => r.date);
    const prefix = new Int32Array(arr.length + 1);
    for (let i = 0; i < arr.length; i++) prefix[i + 1] = prefix[i] + (arr[i].rank <= 3 ? 1 : 0);
    jockeyIdx.set(code, {dates, prefix});
  }
  // date より前の騎乗について {rides, top3}（直近300騎乗まで）を返す
  function jockeyStatsBefore(code, date) {
    const ix = jockeyIdx.get(code);
    if (!ix) return null;
    let lo = 0, hi = ix.dates.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ix.dates[mid] < date) lo = mid + 1; else hi = mid; }
    if (!lo) return null;
    const from = Math.max(0, lo - 300);
    return {rides: lo - from, top3: ix.prefix[lo] - ix.prefix[from]};
  }

  // レースごとの出走表
  const lineupByKey = new Map();
  for (const e of seAll) {
    if (!lineupByKey.has(e.key)) lineupByKey.set(e.key, []);
    lineupByKey.get(e.key).push(e);
  }

  const rows = [];
  const winRows = [];
  const raceList = [...races.values()].sort((a, b) => a.date.localeCompare(b.date));
  let processed = 0;
  for (const race of raceList) {
    if (++processed % 10000 === 0) console.log(`  スコア再現中 ${processed}/${raceList.length} (${race.date})`);
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
      const performance = PF.summarizePerformance(past);
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
      const jockeyStats = jockeyStatsBefore(e.jockeyCode, race.date);
      return {
        num: e.umaban, name: e.name, jockey: e.jockeyName, kinryo: e.kinryo,
        odds: e.odds, ninki: e.ninki, age3f: past[0]?.agari || null,
        p1: past[0]?.rank ?? null, p2: past[1]?.rank ?? null, p3: past[2]?.rank ?? null,
        p4: past[3]?.rank ?? null, p5: past[4]?.rank ?? null,
        career: career.n ? career : null,
        jockeyStats,
        sireStats: null,
        marginForm: performance.marginForm,
        classLevel: performance.classLevel,
        speedForm: performance.speedForm,
      };
    });
    horses.forEach(h => { h.score = scoring.computeScore(h); });

    // 単勝・期待値判定用の全馬行（スコアは同点回避ハッシュを除外した値。確定オッズ使用）
    if (WIN_OUT !== 'none') {
      const probInput = horses.map(h => ({num: h.num, odds: h.odds, score: scoring.computeScore(h, {noJitter: true})}));
      const wv = WV.evaluateWinRace(probInput);
      const r4 = (v, d) => v == null ? null : Number(v.toFixed(d));
      winRows.push({
        race_id: race.raceId, date: race.date,
        // レース属性（総合モデルの分析・将来の条件別検証用）
        venue: race.venue, surface: race.surface, distance: race.distance,
        baba: race.baba, race_class: race.raceClass, field: horses.length,
        horses: wv.horses.map((h, i) => {
          // スコア構成要素（0-100・null=欠損）。レース当日より前の情報のみから算出済み。
          // sireFitはJV-Dataに血統がないため常にnull（保存はするが学習特徴量には使わない）
          const comps = scoring.computeScoreComponents(horses[i]);
          return {
            num: h.num,
            odds: h.odds ?? null,           // 確定オッズ（発売中オッズではない）
            marketProb: r4(h.marketProb, 5),
            score: h.score,
            predictedWinProb: r4(h.predictedWinProb, 5),
            fairOdds: r4(h.fairOdds, 2),
            expectedRoiPercent: r4(h.expectedRoiPercent, 1),
            rank: lineup[i].rank || null,   // 1=勝ち。null=取消等
            won: lineup[i].rank === 1,
            buy: h.decision === 'buy',
            // 特徴量（nullがそのまま欠損フラグの情報源になる）
            form: comps.form, career: comps.career, fit: comps.fit,
            venueFit: comps.venueFit, agari: comps.agari,
            jockey: comps.jockey, kinryo: comps.kinryo, sireFit: comps.sireFit,
            // 直近5走の着差（距離1000m換算）と対戦クラス。今回レースより前だけで計算。
            marginForm: r4(horses[i].marginForm, 5),
            classLevel: r4(horses[i].classLevel, 5),
            speedForm: r4(horses[i].speedForm, 5),
          };
        }),
        pick: wv.pick ? wv.pick.num : null,
      });
    }

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
      baba: race.baba, race_class: race.raceClass,
      axis_odds: axis?.odds ?? null, axis_ninki: axis?.ninki ?? null,
      score_gap: axis && rival ? axis.score - rival.score : null,
      per_bet: perBet,
    });
  }

  fs.writeFileSync(OUT, JSON.stringify(rows));
  if (WIN_OUT !== 'none') {
    fs.writeFileSync(WIN_OUT, JSON.stringify(winRows));
    console.log(`単勝・期待値行: ${winRows.length}レース -> ${WIN_OUT}`);
  }
  const byMonth = {};
  for (const r of rows) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] || 0) + 1;
  console.log(`出力: ${rows.length}行 -> ${OUT}`);
  console.log('月別:', Object.entries(byMonth).map(([m, c]) => `${m}=${c}`).join(' '));
}

main().catch(e => { console.error(e); process.exit(1); });
