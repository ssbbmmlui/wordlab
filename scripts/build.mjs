#!/usr/bin/env node
/**
 * WordLab build script
 * ------------------------------------------------------------------
 * 1. 驗證單詞資料（欄位、重複、難度分布）
 * 2. 把靜態網站輸出到 _site/（只包含部署需要的檔案）
 *
 * 用法：
 *   node scripts/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_site');

/* ---------- 讀取資料 ---------- */
const sandbox = { window: {} };
vm.createContext(sandbox);

function loadScript(rel) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) throw new Error(`缺少檔案：${rel}`);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: rel });
  return sandbox.window;
}

loadScript('data/words.js');
const base = sandbox.window.WORDS || [];
loadScript('data/words-extra.js');
loadScript('data/words-extra2.js');

const all = [...base, ...(sandbox.window.WORDS_EXTRA || []), ...(sandbox.window.WORDS_EXTRA2 || [])];
const words = [];
const seenId = new Set();
const seenWord = new Set();
for (const w of all) {
  if (!w || !w.id || !w.word) continue;
  const key = String(w.word).toLowerCase();
  if (seenId.has(w.id) || seenWord.has(key)) continue;
  seenId.add(w.id);
  seenWord.add(key);
  words.push(w);
}

/* ---------- 驗證 ---------- */
const errors = [];
const required = ['id', 'word', 'phonetic', 'pos', 'zh', 'def', 'example', 'exampleZh'];
for (const w of words) {
  for (const field of required) {
    if (!w[field] || typeof w[field] !== 'string') errors.push(`${w.id || '?'}：缺少 ${field}`);
  }
  if (!/^\/.+\/$/.test(w.phonetic || '')) errors.push(`${w.id}：音標格式錯誤 ${w.phonetic}`);
  if (![1, 2, 3, 4].includes(w.level)) errors.push(`${w.id}：難度必須是 1-4（目前 ${w.level}）`);
  if (!Array.isArray(w.tags) || w.tags.length === 0) errors.push(`${w.id}：缺少 tags`);
  if (!/[\u4e00-\u9fff]/.test(w.zh || '')) errors.push(`${w.id}：中文釋義缺少中文字`);
}
if (words.length < 300) errors.push(`單詞太少：${words.length}`);

if (errors.length) {
  console.error(`\n✖ 資料驗證失敗（${errors.length} 項）：`);
  errors.slice(0, 30).forEach(e => console.error('  - ' + e));
  if (errors.length > 30) console.error(`  … 另有 ${errors.length - 30} 項`);
  process.exit(1);
}

const byLevel = words.reduce((acc, w) => (acc[w.level] = (acc[w.level] || 0) + 1, acc), {});
const byPos = words.reduce((acc, w) => {
  const key = String(w.pos).replace(/\./g, '');
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

/* ---------- 輸出靜態網站 ---------- */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const assets = [
  'index.html',
  'css',
  'js',
  'data',
  'favicon.svg',
  'site.webmanifest',
];
const copied = [];
for (const asset of assets) {
  const src = join(ROOT, asset);
  if (!existsSync(src)) continue;
  cpSync(src, join(OUT, asset), { recursive: true });
  copied.push(asset);
}

/* ---------- 最小可用性檢查（HTML 是否引用所有資料與資源） ---------- */
const html = readFileSync(join(OUT, 'index.html'), 'utf8');
const mustReference = ['css/style.css', 'js/app.js', 'data/words.js', 'data/words-extra.js', 'data/words-extra2.js', 'favicon.svg', 'site.webmanifest'];
for (const ref of mustReference) {
  if (!html.includes(ref)) errors.push(`index.html 沒有引用 ${ref}`);
}
if (!html.includes('lang="zh-Hant"')) errors.push('index.html 缺少 lang="zh-Hant"');

if (errors.length) {
  console.error('\n✖ 網站檢查失敗：');
  errors.forEach(e => console.error('  - ' + e));
  process.exit(1);
}

const stats = {
  words: words.length,
  base: base.length,
  byLevel,
  byPos,
  builtAt: new Date().toISOString(),
  files: copied,
};
writeFileSync(join(OUT, 'build-stats.json'), JSON.stringify(stats, null, 2));

console.log('✔ 單詞資料驗證通過');
console.log(`  單詞總數：${words.length}`);
console.log(`  難度分布：基礎 ${byLevel[1] || 0} / 中階 ${byLevel[2] || 0} / 進階 ${byLevel[3] || 0} / 高階 ${byLevel[4] || 0}`);
console.log(`  詞性分布：${JSON.stringify(byPos)}`);
console.log(`✔ 已輸出靜態網站到 _site（${copied.join('、')}）`);
