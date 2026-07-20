'use strict';
const assert = require('assert');
const CF = require('../lib/condition-features.js');

let ok = 0;
function test(name, fn) { fn(); ok++; console.log(`  OK ${ok}. ${name}`); }

const runs = [
  {date: '2026-06-01', rank: 2, field: 16, surface: '芝', distance: 1600, venueCode: '05', classLevel: 2, corner1: 2},
  {date: '2026-04-01', rank: 8, field: 16, surface: 'ダ', distance: 1400, venueCode: '05', classLevel: 1, corner1: 10},
  {date: '2026-03-01', rank: 1, field: 12, surface: '芝', distance: 1800, venueCode: '05', classLevel: 1, corner1: 1},
];

test('distance and class changes use only the preceding run', () => {
  const f = CF.summarizeConditions(runs, {date: '2026-06-22', surface: '芝', distance: 2000, venueCode: '05', classLevel: 3, field: 16, waku: 8});
  assert.strictEqual(f.distanceDelta, 1);
  assert.strictEqual(f.classChange, 1);
});
test('surface switch and target-surface form are separate', () => {
  const f = CF.summarizeConditions(runs, {date: '2026-06-22', surface: 'ダ', distance: 1400, venueCode: '05', classLevel: 2, field: 16, waku: 1});
  assert.strictEqual(f.surfaceSwitch, 1);
  assert.ok(f.targetSurfaceFit != null);
});
test('second-up is detected after a 60-day-plus prior break', () => {
  const f = CF.summarizeConditions(runs, {date: '2026-06-22', surface: '芝', distance: 1600, venueCode: '05', classLevel: 2, field: 16, waku: 1});
  assert.strictEqual(f.secondUp, 1);
});
test('running style and gate interaction stay finite', () => {
  const f = CF.summarizeConditions(runs, {date: '2026-06-22', surface: '芝', distance: 1600, venueCode: '05', classLevel: 2, field: 16, waku: 8});
  assert.ok(f.runningStyle > 0 && f.runningStyle <= 1);
  assert.ok(Number.isFinite(f.gateStyleInteraction));
});
test('empty history returns safe missing values', () => {
  const f = CF.summarizeConditions([], {date: '2026-06-22', surface: '芝', distance: 1600, field: 16, waku: 1});
  assert.strictEqual(f.distanceDelta, null);
  assert.strictEqual(f.runningStyle, null);
  assert.strictEqual(f.weightDelta, null);
});
test('weight delta compares announced weight with the last valid run', () => {
  const wRuns = [
    {date: '2026-06-01', rank: 2, weight: null},
    {date: '2026-04-01', rank: 8, weight: 470},
    {date: '2026-03-01', rank: 1, weight: 460},
    {date: '2026-02-01', rank: 3, weight: 480},
  ];
  const f = CF.summarizeWeight(wRuns, 484);
  assert.strictEqual(f.weightDelta, 1.4);        // (484-470)/10
  assert.strictEqual(f.weightAbsDelta, 1.4);
  assert.strictEqual(f.weightVsTypical, 0.7);    // median=470 → (484-470)/20
});
test('weight features are clamped and reject sentinel weights', () => {
  const f = CF.summarizeWeight([{date: '2026-06-01', rank: 1, weight: 440}], 500);
  assert.strictEqual(f.weightDelta, 2);           // clamp at +2
  assert.strictEqual(f.weightAbsDelta, 2);
  assert.strictEqual(f.weightVsTypical, null);    // fewer than 3 weighted runs
  assert.strictEqual(CF.validWeight(999), null);  // 今計不
  assert.strictEqual(CF.validWeight(0), null);    // 取消
  const missing = CF.summarizeWeight([{date: '2026-06-01', rank: 1, weight: 440}], null);
  assert.strictEqual(missing.weightDelta, null);  // 当日未発表は欠損
});
console.log(`\nAll ${ok} condition-feature tests passed`);
