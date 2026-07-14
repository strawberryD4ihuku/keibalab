// 単勝・期待値判定の純粋関数を index.html から抽出して Node で使う。
// （実装本体は index.html 内「単勝・期待値判定（純粋関数群）」区画。
//   proxy.js が静的JSを配信しないため、jv-import.js と同じ
//   「フロントの実装を抽出して共有する」方式を採る＝二重実装を作らない）
'use strict';
const fs = require('fs');
const path = require('path');

// `function NAME(` / `const NAME =` から括弧の対応で宣言全体を切り出す（jv-import.jsと同方式）
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

const NAMES = ['WIN_VALUE_CONFIG', 'toValidOdds', 'normalizeMarketProbabilities',
  'estimateWinProbabilities', 'calculateWinValue', 'evaluateWinRace'];

function load() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const decls = NAMES.map(n => extractDecl(src, n)).join('\n');
  const factory = new Function(`
    ${decls}
    return {${NAMES.join(', ')}};
  `);
  return factory();
}

module.exports = load();
