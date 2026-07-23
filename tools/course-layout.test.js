'use strict';
const assert=require('assert');
const C=require('../lib/course-layout.js');
function test(name,fn){try{fn();console.log(`OK  ${name}`)}catch(e){console.error(`NG  ${name}: ${e.message}`);process.exitCode=1}}
test('JRA10場のプロフィールを持つ',()=>assert.strictEqual(Object.keys(C.COURSES).length,10));
test('東京と小倉でコース寸法が異なる',()=>{const a=C.getProfile('東京','芝',1600),b=C.getProfile('小倉','芝',1800);assert.notStrictEqual(a.lap,b.lap);assert.notStrictEqual(a.shape,b.shape)});
test('内外回りを距離から切り替える',()=>{assert.strictEqual(C.getProfile('阪神','芝',2000).variant,'内回り');assert.strictEqual(C.getProfile('阪神','芝',1600).variant,'外回り')});
test('経路上の座標と法線を返す',()=>{const p=C.buildPath(C.getProfile('中山','芝',2500),800,400),x=C.pointAt(p,.5);assert.ok(Number.isFinite(x.x)&&Number.isFinite(x.nx));assert.ok(p.total>1000)});
test('ハイペース想定はスローより時計が速い',()=>assert.ok(C.estimateFinishSeconds(2000,'芝','high','東京')<C.estimateFinishSeconds(2000,'芝','slow','東京')));
test('芝の道悪は良馬場より想定時計が掛かる',()=>assert.ok(C.estimateFinishSeconds(2000,'芝','standard','東京','重')>C.estimateFinishSeconds(2000,'芝','standard','東京','良')));
test('ダートは重馬場で良馬場より時計が速くなる想定',()=>assert.ok(C.estimateFinishSeconds(1800,'ダ','standard','中山','重')<C.estimateFinishSeconds(1800,'ダ','standard','中山','良')));
