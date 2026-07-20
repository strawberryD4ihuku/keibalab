'use strict';
// 坂路調教（JV-Data HCレコード・dataspec=SLOP）から予想用の調教特徴量を作る。
//
// HCレコード（58バイト固定・全てASCII数字）:
//   offset 0:'HC' 2:データ区分 3:作成日(8) 11:トレセン区分(1) 12:調教年月日(8)
//   16?…→ 20:調教時刻(4) 24:血統登録番号(10) 34:4F計(4,0.1秒) 38:lap4(3)
//   41:3F計(4) 45:lap3(3) 48:2F計(4) 52:lap2(3) 55:lap1(3)
//
// 数百万件を扱うため、レコードはカラム型（数値配列）で保持する。
// 標準化は「その調教日より前」のトレセン別ローリング分布のみを使う（リーク防止。
// jv-import.js の attachSpeedFigures と同じ日単位スナップショット方式）。

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 妥当な範囲外（9999=計測なし等）はnull
function validTime4F(t) { return t >= 450 && t <= 900 ? t : null; }
function validLap(t) { return t >= 100 && t <= 300 ? t : null; }

function createWorkStore() {
  return {
    horseKeys: new Map(),   // 血統登録番号 → 内部インデックス
    horse: [],              // 内部インデックス（Int）
    date: [],               // yyyymmdd（Int）
    tresen: [],             // 0=美浦 1=栗東 等
    time: [],               // 4F計（0.1秒）
    accel: [],              // (lap2-lap1)/10 秒。ラップ欠測はNaN
    z: null,                // finalizeで付与（速いほど大。欠測はNaN）
    byHorse: null,          // finalizeで付与（内部idx → 作業インデックス昇順配列）
  };
}

// 1行を取り込む。HC以外・パース不能・4Fタイム無効は捨てて false を返す
function addLine(store, line) {
  if (!line || line.length < 58 || !line.startsWith('HC')) return false;
  const time4F = validTime4F(parseInt(line.slice(34, 38), 10));
  if (time4F == null) return false;
  const dateInt = parseInt(line.slice(12, 20), 10);
  if (!(dateInt >= 19900101 && dateInt <= 21001231)) return false;
  const horseId = line.slice(24, 34);
  let h = store.horseKeys.get(horseId);
  if (h == null) { h = store.horseKeys.size; store.horseKeys.set(horseId, h); }
  const lap2 = validLap(parseInt(line.slice(52, 55), 10));
  const lap1 = validLap(parseInt(line.slice(55, 58), 10));
  store.horse.push(h);
  store.date.push(dateInt);
  store.tresen.push(parseInt(line[11], 10) || 0);
  store.time.push(time4F);
  store.accel.push(lap2 != null && lap1 != null ? (lap2 - lap1) / 10 : NaN);
  return true;
}

// 日付順に処理し、トレセン別ローリング分布（直近3000本・最低300本・sd>=0.3秒）で
// 4Fタイムを標準化する。各日の調教は「前日までの分布」で評価してから分布へ追加する。
function finalize(store) {
  const n = store.date.length;
  const order = Array.from({length: n}, (_, i) => i).sort((a, b) => store.date[a] - store.date[b]);
  const z = new Float64Array(n).fill(NaN);
  const buffers = new Map();   // tresen → {arr: number[], head: int}
  let i = 0;
  while (i < n) {
    const day = store.date[order[i]];
    let j = i;
    while (j < n && store.date[order[j]] === day) j++;
    // 前日までの分布スナップショット
    const stats = new Map();
    for (const [tr, buf] of buffers) {
      const a = buf.arr;
      if (a.length < 300) continue;
      const mean = a.reduce((s, x) => s + x, 0) / a.length;
      const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length);
      if (sd >= 3) stats.set(tr, {mean, sd});
    }
    for (let k = i; k < j; k++) {
      const w = order[k];
      const st = stats.get(store.tresen[w]);
      if (st) z[w] = clamp((st.mean - store.time[w]) / st.sd, -3, 3);
    }
    for (let k = i; k < j; k++) {
      const w = order[k];
      let buf = buffers.get(store.tresen[w]);
      if (!buf) { buf = {arr: []}; buffers.set(store.tresen[w], buf); }
      buf.arr.push(store.time[w]);
      if (buf.arr.length > 3000) buf.arr.shift();
    }
    i = j;
  }
  store.z = z;
  const byHorse = new Map();
  for (const w of order) {
    let list = byHorse.get(store.horse[w]);
    if (!list) { list = []; byHorse.set(store.horse[w], list); }
    // 差分取得の重なりで同一調教が二重に入っても数えない（同日・同タイム・同トレセン）
    const tail = list.length ? list[list.length - 1] : -1;
    if (tail >= 0 && store.date[tail] === store.date[w] && store.time[tail] === store.time[w] &&
        store.tresen[tail] === store.tresen[w]) continue;
    list.push(w);   // orderで回すので日付昇順
  }
  store.byHorse = byHorse;
  store.minDate = n ? store.date[order[0]] : null;
  store.maxDate = n ? store.date[order[n - 1]] : null;
}

function dateStrToInt(dateStr) {
  return parseInt(String(dateStr).replace(/-/g, ''), 10) || null;
}

// raceDateの28日前のyyyymmdd（カレンダー計算）
function windowStartInt(dateStr) {
  const t = Date.parse(dateStr + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - 28 * 86400000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function daysBefore(dateIntA, dateStrB) {
  const s = String(dateIntA);
  const a = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  const b = Date.parse(dateStrB + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// レース前28日間の坂路調教を集約する。調教日 < レース当日のみ使用。
// 調教データの提供期間外（storeが空）は全てnull。データ期間内で0本は count=0（欠損と区別）。
function summarizeTraining(store, horseId, raceDate) {
  const empty = {trainCount28: null, trainBestSpeed: null, trainLastGap: null, trainAccel: null};
  if (!store || !store.byHorse) return empty;
  const raceInt = dateStrToInt(raceDate);
  const fromInt = windowStartInt(raceDate);
  if (raceInt == null || fromInt == null) return empty;
  // データ提供期間が28日窓を覆っていないレースには、偽の「調教0本」を与えない
  // （前日までの調教があれば窓は完結する＝maxDateの翌日のレースまで有効）
  if (store.minDate == null || fromInt < store.minDate || daysBefore(store.maxDate, raceDate) > 1) return empty;
  const h = store.horseKeys.get(horseId);
  const list = h != null ? store.byHorse.get(h) : null;
  let count = 0, bestZ = null, bestAccel = NaN, lastDate = null;
  if (list) {
    // 日付昇順なので、レース当日以降を二分探索で切ってから遡る
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (store.date[list[mid]] < raceInt) lo = mid + 1; else hi = mid; }
    for (let k = lo - 1; k >= 0; k--) {
      const w = list[k];
      if (store.date[w] < fromInt) break;
      count++;
      if (lastDate == null) lastDate = store.date[w];
      const zv = store.z[w];
      if (!Number.isNaN(zv) && (bestZ == null || zv > bestZ)) { bestZ = zv; bestAccel = store.accel[w]; }
    }
  }
  return {
    trainCount28: clamp(count / 6, 0, 2),
    trainBestSpeed: bestZ,
    trainLastGap: lastDate != null ? clamp(daysBefore(lastDate, raceDate) / 14, 0, 2) : null,
    trainAccel: bestZ != null && !Number.isNaN(bestAccel) ? clamp(bestAccel, -1.5, 1.5) : null,
  };
}

module.exports = {createWorkStore, addLine, finalize, summarizeTraining, validTime4F, validLap};
