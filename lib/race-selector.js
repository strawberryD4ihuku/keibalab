'use strict';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = v => Number.isFinite(Number(v)) ? Number(v) : null;

const DEFAULT_PROFILES = Object.freeze({
  stable: Object.freeze({
    label: '安定型（高的中・損失抑制）',
    ruleVersion: 'stable-small-field-favorite-v1',
    betTypes: Object.freeze(['複勝']),
    maxField: 9,
    minAxisOdds: 1,
    maxAxisOdds: 1.99,
  }),
  upset: Object.freeze({
    label: '荒れ狙い型',
    betTypes: Object.freeze(['単勝', 'ワイド', '馬連']),
    minField: 10,
    maxMarketTopProb: 0.34,
    minEntropy: 0.78,
    minTopProb: 0.14,
    minProbGap: 0.015,
    minBestEdge: 0.018,
    minModelTopMarketRank: 2,
    maxModelTopMarketRank: 8,
    minScoreGap: 2,
    minAxisOdds: 3.5,
    maxAxisOdds: 30,
    minCoverage: 0.45,
  }),
});

function normalize(values) {
  const xs = values.map(v => Math.max(0, finite(v) || 0));
  const sum = xs.reduce((a, b) => a + b, 0);
  return sum > 0 ? xs.map(v => v / sum) : xs.map(() => 0);
}

function normalizedEntropy(probs) {
  const ps = normalize(probs).filter(p => p > 0);
  if (ps.length <= 1) return 0;
  const h = -ps.reduce((s, p) => s + p * Math.log(p), 0);
  return clamp(h / Math.log(ps.length), 0, 1);
}

function modelCoverage(horses, featureNames) {
  if (!horses.length || !featureNames.length) return 0;
  let present = 0;
  for (const h of horses) {
    for (const name of featureNames) if (finite(h[name]) != null) present++;
  }
  return present / (horses.length * featureNames.length);
}

function summarizeRace(winRow, verifyRow, predicted, featureNames = []) {
  const horses = Array.isArray(winRow && winRow.horses) ? winRow.horses : [];
  const market = normalize(horses.map(h => h.marketProb));
  const model = normalize((predicted || []).map(p => p && p.predictedWinProb != null ? p.predictedWinProb : p));
  const effectiveModel = model.some(p => p > 0) ? model : market;
  const byModel = effectiveModel.map((p, i) => ({i, p, market: market[i] || 0, num: horses[i] && horses[i].num}))
    .sort((a, b) => b.p - a.p || a.num - b.num);
  const byMarket = market.map((p, i) => ({i, p})).sort((a, b) => b.p - a.p);
  const marketRank = new Map(byMarket.map((x, i) => [x.i, i + 1]));
  const top = byModel[0] || {i: -1, p: 0, market: 0};
  const second = byModel[1] || {p: 0};
  const edges = effectiveModel.map((p, i) => p - (market[i] || 0));
  const positiveEdges = edges.filter(e => e >= 0.01).length;
  const valuePick = byModel
    .map(x => {
      const odds = finite(horses[x.i] && horses[x.i].odds);
      return {...x, odds, expectedReturn: odds ? x.p * odds : 0};
    })
    .filter(x => x.odds >= 3.5 && x.odds <= 30 && x.p >= 0.03)
    .sort((a, b) => b.expectedReturn - a.expectedReturn || b.p - a.p)[0] || null;

  return {
    raceId: winRow && winRow.race_id,
    date: winRow && winRow.date,
    field: finite((verifyRow && verifyRow.field) ?? (winRow && winRow.field)) || horses.length,
    axisOdds: finite(verifyRow && verifyRow.axis_odds),
    axisPopularity: finite(verifyRow && verifyRow.axis_ninki),
    scoreGap: finite(verifyRow && verifyRow.score_gap),
    topProb: top.p,
    secondProb: second.p,
    probGap: top.p - second.p,
    top3Prob: byModel.slice(0, 3).reduce((s, x) => s + x.p, 0),
    marketTopProb: byMarket[0] ? byMarket[0].p : 0,
    marketTop3Prob: byMarket.slice(0, 3).reduce((s, x) => s + x.p, 0),
    entropy: normalizedEntropy(effectiveModel),
    marketEntropy: normalizedEntropy(market),
    modelTopMarketRank: marketRank.get(top.i) || horses.length || 99,
    modelTopNum: top.num || null,
    modelTopOdds: finite(horses[top.i] && horses[top.i].odds),
    modelMarketAgree: Boolean(byMarket[0] && byMarket[0].i === top.i),
    bestEdge: edges.length ? Math.max(...edges) : 0,
    positiveEdgeCount: positiveEdges,
    valuePickNum: valuePick && valuePick.num,
    valuePickOdds: valuePick && valuePick.odds,
    valuePickProb: valuePick && valuePick.p,
    valuePickExpectedReturn: valuePick && valuePick.expectedReturn,
    coverage: modelCoverage(horses, featureNames),
  };
}

function fail(code, actual, expected) {
  return {code, actual, expected};
}

function evaluateStable(s, profile = DEFAULT_PROFILES.stable) {
  const reasons = [];
  if (profile.maxField != null && !(s.field <= profile.maxField)) reasons.push(fail('field', s.field, `<=${profile.maxField}`));
  if (profile.minTopProb != null && !(s.topProb >= profile.minTopProb)) reasons.push(fail('topProb', s.topProb, `>=${profile.minTopProb}`));
  if (profile.minProbGap != null && !(s.probGap >= profile.minProbGap)) reasons.push(fail('probGap', s.probGap, `>=${profile.minProbGap}`));
  if (profile.maxEntropy != null && !(s.entropy <= profile.maxEntropy)) reasons.push(fail('entropy', s.entropy, `<=${profile.maxEntropy}`));
  if (profile.maxModelTopMarketRank != null && !(s.modelTopMarketRank <= profile.maxModelTopMarketRank)) reasons.push(fail('marketRank', s.modelTopMarketRank, `<=${profile.maxModelTopMarketRank}`));
  if (profile.minScoreGap != null && !(s.scoreGap >= profile.minScoreGap)) reasons.push(fail('scoreGap', s.scoreGap, `>=${profile.minScoreGap}`));
  if (profile.minAxisOdds != null && profile.maxAxisOdds != null && !(s.axisOdds >= profile.minAxisOdds && s.axisOdds <= profile.maxAxisOdds)) reasons.push(fail('axisOdds', s.axisOdds, `${profile.minAxisOdds}-${profile.maxAxisOdds}`));
  if (profile.maxAxisPopularity != null && !(s.axisPopularity <= profile.maxAxisPopularity)) reasons.push(fail('axisPopularity', s.axisPopularity, `<=${profile.maxAxisPopularity}`));
  if (profile.minCoverage != null && !(s.coverage >= profile.minCoverage)) reasons.push(fail('coverage', s.coverage, `>=${profile.minCoverage}`));
  return {profile: 'stable', label: profile.label, decision: reasons.length ? 'skip' : 'buy', betTypes: profile.betTypes, reasons, signals: s};
}

function evaluateUpset(s, profile = DEFAULT_PROFILES.upset) {
  const reasons = [];
  if (!(s.field >= profile.minField)) reasons.push(fail('field', s.field, `>=${profile.minField}`));
  if (!(s.marketTopProb <= profile.maxMarketTopProb)) reasons.push(fail('marketTopProb', s.marketTopProb, `<=${profile.maxMarketTopProb}`));
  if (!(s.entropy >= profile.minEntropy)) reasons.push(fail('entropy', s.entropy, `>=${profile.minEntropy}`));
  if (!(s.topProb >= profile.minTopProb)) reasons.push(fail('topProb', s.topProb, `>=${profile.minTopProb}`));
  if (!(s.probGap >= profile.minProbGap)) reasons.push(fail('probGap', s.probGap, `>=${profile.minProbGap}`));
  if (!(s.bestEdge >= profile.minBestEdge)) reasons.push(fail('bestEdge', s.bestEdge, `>=${profile.minBestEdge}`));
  if (!s.valuePickNum) reasons.push(fail('valuePick', s.valuePickNum, 'required'));
  if (!(s.modelTopMarketRank >= profile.minModelTopMarketRank && s.modelTopMarketRank <= profile.maxModelTopMarketRank)) reasons.push(fail('marketRank', s.modelTopMarketRank, `${profile.minModelTopMarketRank}-${profile.maxModelTopMarketRank}`));
  if (!(s.scoreGap >= profile.minScoreGap)) reasons.push(fail('scoreGap', s.scoreGap, `>=${profile.minScoreGap}`));
  if (!(s.axisOdds >= profile.minAxisOdds && s.axisOdds <= profile.maxAxisOdds)) reasons.push(fail('axisOdds', s.axisOdds, `${profile.minAxisOdds}-${profile.maxAxisOdds}`));
  if (!(s.coverage >= profile.minCoverage)) reasons.push(fail('coverage', s.coverage, `>=${profile.minCoverage}`));
  return {profile: 'upset', label: profile.label, decision: reasons.length ? 'skip' : 'buy', betTypes: profile.betTypes, reasons, signals: s};
}

function evaluateRace(signals, profiles = DEFAULT_PROFILES) {
  return {
    stable: evaluateStable(signals, profiles.stable),
    upset: evaluateUpset(signals, profiles.upset),
  };
}

module.exports = {
  DEFAULT_PROFILES,
  normalize,
  normalizedEntropy,
  modelCoverage,
  summarizeRace,
  evaluateStable,
  evaluateUpset,
  evaluateRace,
};
