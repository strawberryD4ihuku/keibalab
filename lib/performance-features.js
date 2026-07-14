'use strict';

// 過去走の「着差」と「対戦クラス」を、JV-Dataと予想画面で同じ定義にする。
// runs は新しい走から順に渡す。未来情報や今回レースの結果は使用しない。
const CLASS_LEVELS = {
  '新馬': 0, '未勝利': 0,
  '1勝': 1, '2勝': 2, '3勝': 3,
  'OP': 4, 'L': 5, '重賞': 5,
  'G3': 6, 'G2': 7, 'G1': 8,
  'JG3': 6, 'JG2': 7, 'JG1': 8,
};

function raceClassLevel(value) {
  if (value == null) return null;
  const s = String(value).replace(/Ｇ/g, 'G').replace(/[１-３]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (/J[・･.]?G1/i.test(s)) return 8;
  if (/J[・･.]?G2/i.test(s)) return 7;
  if (/J[・･.]?G3/i.test(s)) return 6;
  if (/\bG1\b|G1/i.test(s)) return 8;
  if (/\bG2\b|G2/i.test(s)) return 7;
  if (/\bG3\b|G3/i.test(s)) return 6;
  if (/リステッド|[（(]L[）)]|^L$/i.test(s)) return 5;
  if (/重賞/.test(s)) return 5;
  if (/オープン|ＯＰ|\bOP\b/i.test(s)) return 4;
  if (/3勝|1600万/.test(s)) return 3;
  if (/2勝|1000万/.test(s)) return 2;
  if (/1勝|500万/.test(s)) return 1;
  if (/新馬|未勝利/.test(s)) return 0;
  return Object.prototype.hasOwnProperty.call(CLASS_LEVELS, s) ? CLASS_LEVELS[s] : null;
}

// JV-Dataのタイム差（1着は2着に対するマイナス値、2着以下は1着との差）を
// 距離1000m当たりへ換算。大敗の外れ値は抑える。高いほど好内容。
function marginPerformance(timeDiffSec, distance) {
  if (timeDiffSec == null || distance == null) return null;
  const td = Number(timeDiffSec);
  const d = Number(distance);
  if (!Number.isFinite(td) || !(d > 0) || Math.abs(td) >= 99) return null;
  const perKm = -td * 1000 / d;
  return Math.max(-3, Math.min(1, perKm));
}

function weightedRecentMean(runs, valueFn, limit) {
  const xs = (runs || []).slice(0, limit || 5);
  let sum = 0, weights = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = valueFn(xs[i]);
    if (v == null || !Number.isFinite(Number(v))) continue;
    const w = xs.length - i;
    sum += Number(v) * w;
    weights += w;
  }
  return weights ? sum / weights : null;
}

function summarizePerformance(runs) {
  const recent = (runs || []).slice(0, 5);
  return {
    marginForm: weightedRecentMean(recent, r => marginPerformance(r.timeDiffSec, r.distance), 5),
    classLevel: weightedRecentMean(recent, r => raceClassLevel(r.raceClass), 5),
    speedForm: weightedRecentMean(recent, r => r.speedFigure, 5),
  };
}

module.exports = {CLASS_LEVELS, raceClassLevel, marginPerformance, weightedRecentMean, summarizePerformance};
