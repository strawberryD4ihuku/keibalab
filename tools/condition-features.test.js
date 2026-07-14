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
});
console.log(`\nAll ${ok} condition-feature tests passed`);
