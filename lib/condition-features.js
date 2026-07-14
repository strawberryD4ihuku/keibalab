'use strict';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function daysBetween(a, b) {
  const x = Date.parse(a), y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.max(0, Math.round((y - x) / 86400000));
}

function finishScore(run) {
  const rank = Number(run && run.rank), field = Number(run && run.field);
  if (!(rank > 0)) return null;
  if (field > 1) return clamp(1 - (rank - 1) / (field - 1), 0, 1);
  return rank === 1 ? 1 : null;
}

function smoothedMean(runs, predicate, priorMean = 0.5, priorWeight = 4) {
  let sum = priorMean * priorWeight, weight = priorWeight;
  for (const run of runs || []) {
    if (!predicate(run)) continue;
    const v = finishScore(run);
    if (v == null) continue;
    sum += v;
    weight++;
  }
  return weight > priorWeight ? sum / weight : null;
}

// 1 = front runner, 0 = closer. Uses only positions recorded before the target race.
function inferRunningStyle(runs) {
  let sum = 0, weight = 0;
  (runs || []).slice(0, 5).forEach((run, i) => {
    const pos = Number(run.corner1 || run.corner2 || run.corner3 || run.corner4);
    const field = Number(run.field);
    if (!(pos > 0) || !(field > 1)) return;
    const w = 5 - i;
    sum += clamp(1 - (pos - 1) / (field - 1), 0, 1) * w;
    weight += w;
  });
  return weight ? sum / weight : null;
}

function sameDistanceBand(a, b) {
  return Number(a) > 0 && Number(b) > 0 && Math.abs(Number(a) - Number(b)) <= 200;
}

function summarizeConditions(runs, current) {
  const recent = (runs || []).slice(0, 20);
  const last = recent[0] || null;
  const previous = recent[1] || null;
  const distance = Number(current && current.distance) || null;
  const surface = current && current.surface || null;
  const venueCode = current && current.venueCode || null;
  const currentClass = current && current.classLevel;
  const field = Number(current && current.field) || null;
  const waku = Number(current && current.waku) || null;
  const maxWaku = Number(current && current.maxWaku) || (field ? Math.min(8, field) : null);
  const gatePosition = waku && field
    ? clamp((waku - 1) / ((maxWaku || 1) - 1 || 1), 0, 1)
    : null;
  const runningStyle = inferRunningStyle(recent);
  const layoffDaysRaw = last && current && current.date ? daysBetween(last.date, current.date) : null;
  const previousGap = last && previous ? daysBetween(previous.date, last.date) : null;

  const courseRuns = recent.filter(r =>
    r.venueCode === venueCode && r.surface === surface && sameDistanceBand(r.distance, distance));
  const styleBand = runningStyle == null ? null : runningStyle >= 2 / 3 ? 2 : runningStyle >= 1 / 3 ? 1 : 0;
  const courseStyleFit = styleBand == null ? null : smoothedMean(courseRuns, r => {
    const s = inferRunningStyle([r]);
    const b = s == null ? null : s >= 2 / 3 ? 2 : s >= 1 / 3 ? 1 : 0;
    return b === styleBand;
  });

  return {
    distanceDelta: last && last.distance && distance
      ? clamp((distance - Number(last.distance)) / 400, -3, 3) : null,
    distanceChangeFit: distance
      ? smoothedMean(recent, r => r.surface === surface && sameDistanceBand(r.distance, distance)) : null,
    surfaceSwitch: last && last.surface && surface ? (last.surface === surface ? 0 : 1) : null,
    targetSurfaceFit: surface ? smoothedMean(recent, r => r.surface === surface) : null,
    classChange: last && last.classLevel != null && currentClass != null
      ? clamp(Number(currentClass) - Number(last.classLevel), -4, 4) : null,
    layoffLog: layoffDaysRaw == null ? null : clamp(Math.log1p(layoffDaysRaw) / Math.log(366), 0, 1.5),
    secondUp: previousGap == null || layoffDaysRaw == null ? null
      : (previousGap >= 60 && layoffDaysRaw >= 7 && layoffDaysRaw <= 45 ? 1 : 0),
    gatePosition,
    runningStyle,
    gateStyleInteraction: gatePosition == null || runningStyle == null
      ? null : (gatePosition - 0.5) * (runningStyle - 0.5) * 4,
    courseStyleFit,
  };
}

module.exports = {
  daysBetween, finishScore, smoothedMean, inferRunningStyle, sameDistanceBand, summarizeConditions,
};
