'use strict';
const assert = require('assert');
const TF = require('../lib/training-features.js');

let ok = 0;
function test(name, fn) { fn(); ok++; console.log(`  OK ${ok}. ${name}`); }

// 58バイトのHC行: ヘッダ34 + 4F(4) + lap4(3) + 3F(4) + lap3(3) + 2F(4) + lap2(3) + lap1(3)
function hcLine({date, tresen = 1, horse = '2010106124', time4F = 654, lap2 = 164, lap1 = 150}) {
  const head = `HC120230808${tresen}${date}0658${horse}`;
  const t = String(time4F).padStart(4, '0');
  return `${head}${t}17504791650314${String(lap2).padStart(3, '0')}${String(lap1).padStart(3, '0')}`;
}

// 分布の基準になる調教320本（2015-01-01〜01-28）＋期間を3/19まで延ばす埋め草
function seedStore(store, {extendToMarch = false} = {}) {
  for (let i = 0; i < 320; i++) {
    TF.addLine(store, hcLine({date: String(20150101 + (i % 28)), horse: String(3000000000 + i), time4F: 580 + (i % 9) * 10}));
  }
  if (extendToMarch) {
    for (let d = 20150301; d <= 20150319; d++) {
      TF.addLine(store, hcLine({date: String(d), horse: String(3500000000 + d)}));
    }
  }
}

test('実データ形式のHC行をパースできる', () => {
  const store = TF.createWorkStore();
  const line = 'HC12023080802014010206582010106124065417504791650314164150';
  assert.strictEqual(line.length, 58);
  assert.strictEqual(TF.addLine(store, line), true);
  assert.strictEqual(store.date[0], 20140102);
  assert.strictEqual(store.time[0], 654);
  assert.ok(Math.abs(store.accel[0] - 1.4) < 1e-9);   // (164-150)/10
  assert.strictEqual(hcLine({date: '20140102'}).length, 58);
});

test('9999タイムや異種レコードは捨てる', () => {
  const store = TF.createWorkStore();
  assert.strictEqual(TF.addLine(store, hcLine({date: '20140102', time4F: 9999})), false);
  assert.strictEqual(TF.addLine(store, 'RA' + 'x'.repeat(56)), false);
  assert.strictEqual(TF.addLine(store, ''), false);
});

test('標準化は前日までの分布を使い、速いほどzが大きい', () => {
  const store = TF.createWorkStore();
  seedStore(store, {extendToMarch: true});
  TF.addLine(store, hcLine({date: '20150315', horse: '2010106124', time4F: 560}));  // 速い
  TF.addLine(store, hcLine({date: '20150315', horse: '2010106125', time4F: 690}));  // 遅い
  TF.finalize(store);
  const fast = TF.summarizeTraining(store, '2010106124', '2015-03-20');
  const slow = TF.summarizeTraining(store, '2010106125', '2015-03-20');
  assert.ok(fast.trainBestSpeed > 0, `fast z=${fast.trainBestSpeed}`);
  assert.ok(slow.trainBestSpeed < 0, `slow z=${slow.trainBestSpeed}`);
  assert.ok(fast.trainBestSpeed <= 3 && slow.trainBestSpeed >= -3);
});

test('28日窓・本数・最終追い切りからの日数・加速ラップ', () => {
  const store = TF.createWorkStore();
  seedStore(store, {extendToMarch: true});
  const h = '2012345678';
  TF.addLine(store, hcLine({date: '20150210', horse: h}));           // 窓外（38日前）
  TF.addLine(store, hcLine({date: '20150301', horse: h}));           // 窓内
  TF.addLine(store, hcLine({date: '20150315', horse: h, time4F: 550, lap2: 160, lap1: 148}));  // 窓内・最速
  TF.addLine(store, hcLine({date: '20150320', horse: h, time4F: 500}));  // レース当日＝使わない
  TF.finalize(store);
  const f = TF.summarizeTraining(store, h, '2015-03-20');
  assert.ok(Math.abs(f.trainCount28 - 2 / 6) < 1e-9, `count=${f.trainCount28}`);
  assert.ok(Math.abs(f.trainLastGap - 5 / 14) < 1e-9, `gap=${f.trainLastGap}`);
  assert.ok(Math.abs(f.trainAccel - 1.2) < 1e-9, `accel=${f.trainAccel}`);   // 最速調教の(160-148)/10
});

test('提供期間外のレースは全てnull（偽の調教0本を作らない）', () => {
  const store = TF.createWorkStore();
  seedStore(store);   // 2015-01-01〜01-28のみ
  TF.finalize(store);
  const before = TF.summarizeTraining(store, '9999999999', '2015-01-20');  // 窓が期間開始前にかかる
  assert.strictEqual(before.trainCount28, null);
  const after = TF.summarizeTraining(store, '9999999999', '2015-03-01');   // 期間終了後
  assert.strictEqual(after.trainCount28, null);
  const inside = TF.summarizeTraining(store, '9999999999', '2015-01-29');  // 期間内・調教なしの馬
  assert.strictEqual(inside.trainCount28, 0);
  assert.strictEqual(inside.trainBestSpeed, null);
  assert.strictEqual(inside.trainLastGap, null);
});

console.log(`\nAll ${ok} training-feature tests passed`);
