// 総合勝率モデル（市場オフセット付きsoftmax）の純粋関数を index.html から抽出して Node で使う。
// （実装本体は index.html「総合勝率モデル（市場オフセット付きsoftmax・純粋関数群）」区画。
//   lib/win-value.js と同じ「フロントの実装を抽出して共有する」方式＝二重実装を作らない）
'use strict';
const fs = require('fs');
const path = require('path');

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

const NAMES = ['toValidOdds', 'normalizeMarketProbabilities',
  'WIN_MODEL_FEATURES', 'WIN_MODEL_FEATURE_LABELS',
  'standardizeFeaturesInRace', 'predictWinModel', 'winModelContributions'];

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

const api = load();

// モデルJSONの既定パス（学習: tools/train-win-model.js が生成）
api.MODEL_PATH = path.join(__dirname, '..', 'models', 'win-model.json');
api.loadModel = function loadModel(p) {
  const file = p || api.MODEL_PATH;
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

module.exports = api;
