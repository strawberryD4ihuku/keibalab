(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TicketSelector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BET_TYPES = ['単勝', '複勝', '枠連', 'ワイド', '馬連', '馬単', '3連複', '3連単'];
  const SAFETY = {'単勝': .90, '複勝': .88, '枠連': .82, 'ワイド': .82, '馬連': .80, '馬単': .75, '3連複': .72, '3連単': .65};
  const MIN_PROB = {'単勝': .005, '複勝': .02, '枠連': .005, 'ワイド': .008, '馬連': .005, '馬単': .003, '3連複': .002, '3連単': .0005};
  const SORTED = new Set(['枠連', 'ワイド', '馬連', '3連複']);

  const normalize = horses => {
    const raw = (horses || []).map(h => Math.max(0, Number(h.predictedWinProb) || 0));
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map(v => sum ? v / sum : 0);
  };
  const keyOf = (nums, sorted) => (sorted ? [...nums].sort((a, b) => a - b) : nums).join('-');
  const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);

  function buildProbabilityMaps(horses) {
    const probs = normalize(horses);
    const nums = (horses || []).map((h, i) => Number(h.num) || i + 1);
    const frames = (horses || []).map(h => Number(h.waku) || 0);
    const maps = Object.fromEntries(BET_TYPES.map(bt => [bt, new Map()]));
    probs.forEach((p, i) => maps['単勝'].set(String(nums[i]), p));
    const top2 = Array(nums.length).fill(0), top3 = Array(nums.length).fill(0);

    for (let i = 0; i < nums.length; i++) {
      if (!(probs[i] > 0)) continue;
      top2[i] += probs[i]; top3[i] += probs[i];
      const remain1 = 1 - probs[i];
      if (!(remain1 > 1e-12)) continue;
      for (let j = 0; j < nums.length; j++) {
        if (j === i || !(probs[j] > 0)) continue;
        const pairProb = probs[i] * probs[j] / remain1;
        top2[j] += pairProb; top3[j] += pairProb;
        add(maps['馬単'], keyOf([nums[i], nums[j]], false), pairProb);
        add(maps['馬連'], keyOf([nums[i], nums[j]], true), pairProb);
        if (frames[i] > 0 && frames[j] > 0) add(maps['枠連'], keyOf([frames[i], frames[j]], true), pairProb);
        const remain2 = remain1 - probs[j];
        if (!(remain2 > 1e-12)) continue;
        for (let k = 0; k < nums.length; k++) {
          if (k === i || k === j || !(probs[k] > 0)) continue;
          const tripleProb = pairProb * probs[k] / remain2;
          top3[k] += tripleProb;
          add(maps['3連単'], keyOf([nums[i], nums[j], nums[k]], false), tripleProb);
          add(maps['3連複'], keyOf([nums[i], nums[j], nums[k]], true), tripleProb);
          add(maps['ワイド'], keyOf([nums[i], nums[j]], true), tripleProb);
          add(maps['ワイド'], keyOf([nums[i], nums[k]], true), tripleProb);
          add(maps['ワイド'], keyOf([nums[j], nums[k]], true), tripleProb);
        }
      }
    }
    const place = nums.length >= 8 ? top3 : top2;
    place.forEach((p, i) => maps['複勝'].set(String(nums[i]), Math.min(1, p)));
    return maps;
  }

  function parseNums(betType, rawKey) {
    const digits = String(rawKey == null ? '' : rawKey).replace(/\D/g, '');
    const need = betType === '単勝' || betType === '複勝' ? 1 : betType === '3連複' || betType === '3連単' ? 3 : 2;
    if (need === 1) {
      const n = parseInt(digits, 10);
      return n > 0 ? [n] : [];
    }
    if (digits.length !== need * 2) return [];
    const nums = [];
    for (let i = 0; i < need; i++) nums.push(parseInt(digits.slice(i * 2, i * 2 + 2), 10));
    const duplicateAllowed = betType === '枠連';
    return nums.every(n => n > 0) && (duplicateAllowed || new Set(nums).size === nums.length) ? nums : [];
  }

  function lowOdds(entry) {
    const value = Array.isArray(entry) ? entry[0] : entry;
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function evaluateTickets(horses, oddsByType, options) {
    const maps = buildProbabilityMaps(horses);
    const threshold = Number(options && options.threshold) || 110;
    const out = [];
    for (const betType of BET_TYPES) {
      const odds = oddsByType && oddsByType[betType];
      if (!odds || typeof odds !== 'object') continue;
      for (const [rawKey, entry] of Object.entries(odds)) {
        const nums = parseNums(betType, rawKey);
        if (!nums.length) continue;
        const key = keyOf(nums, SORTED.has(betType));
        const probability = maps[betType].get(key) || 0;
        const currentOdds = lowOdds(entry);
        if (!(probability >= MIN_PROB[betType]) || !currentOdds) continue;
        const expectedReturn = probability * currentOdds * SAFETY[betType] * 100;
        out.push({betType, nums, probability, odds: currentOdds, expectedReturn,
          decision: expectedReturn >= threshold ? 'buy' : 'skip'});
      }
    }
    return out.sort((a, b) => b.expectedReturn - a.expectedReturn || b.probability - a.probability
      || BET_TYPES.indexOf(a.betType) - BET_TYPES.indexOf(b.betType) || keyOf(a.nums, false).localeCompare(keyOf(b.nums, false)));
  }

  function selectBestTickets(horses, oddsByType, options) {
    const tickets = evaluateTickets(horses, oddsByType, options);
    const byType = BET_TYPES.map(betType => tickets.find(t => t.betType === betType)).filter(Boolean);
    const best = tickets.find(t => t.decision === 'buy') || null;
    return {best, byType, tickets, comparedTypes: byType.length, skipRace: !best};
  }

  return {BET_TYPES, SAFETY, MIN_PROB, buildProbabilityMaps, parseNums, evaluateTickets, selectBestTickets};
});
