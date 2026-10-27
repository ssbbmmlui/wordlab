#!/usr/bin/env node
/**
 * WordLab smoke test — 用無頭瀏覽器跑一次主要流程
 * ------------------------------------------------------------------
 * 前置：
 *   npm install          # 安裝 playwright-core
 *   node scripts/build.mjs
 * 執行：
 *   node scripts/smoke-test.mjs
 *
 * 會自動尋找 Edge 或 Chrome；找不到時可用 CHROME_PATH 指定。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.SITE_DIR ? resolve(process.env.SITE_DIR) : join(ROOT, '_site');
const SHOTS = join(ROOT, 'docs', 'screenshots');
const wait = ms => new Promise(r => setTimeout(r, ms));

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const executablePath = CANDIDATES.find(p => existsSync(p));
if (!executablePath) {
  console.error('找不到 Chrome / Edge。請設定 CHROME_PATH 環境變數後再試。');
  process.exit(2);
}
if (!existsSync(join(SITE, 'index.html'))) {
  console.error(`找不到 ${SITE}/index.html，請先執行 node scripts/build.mjs`);
  process.exit(2);
}

const results = [];
const ok = (name, pass, note = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
};

const browser = await chromium.launch({ executablePath, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const url = pathToFileURL(join(SITE, 'index.html')).href;
await page.goto(url);
await wait(400);

/* 1. 首頁 / 引導 */
ok('載入首頁', (await page.locator('.onboard').count()) === 1);
const wordCount = await page.evaluate(() => window.__WORDLAB__.words.length);
ok('單詞資料載入', wordCount >= 496, `${wordCount} 個`);
ok('四個難度都存在', await page.evaluate(() => {
  const lv = new Set(window.__WORDLAB__.words.map(w => w.level));
  return [1, 2, 3, 4].every(x => lv.has(x));
}));

/* 2. 開始學習 */
await page.fill('#obName', '測試員');
await page.click('#obStart');
await wait(350);
ok('進入學習卡片', (await page.locator('.flashcard').count()) === 1);
await page.click('#revealBtn');
await wait(250);
ok('翻面顯示中文釋義', (await page.locator('.fc-zh').count()) === 1);
ok('翻面顯示例句', (await page.locator('.example-en').count()) === 1);

/* 3. 完成一輪（每日目標預設 20 張，佇列上限 10 張） */
let cardsDone = 0;
for (let i = 0; i < 20; i++) {
  // 已翻面就直接評分，否則先翻面
  if (!(await page.locator('.rate-btn').count())) {
    if (!(await page.locator('#revealBtn').count())) break;
    await page.click('#revealBtn');
    await wait(120);
  }
  if (!(await page.locator('.rate-btn').count())) break;
  await page.keyboard.press(i % 4 === 0 ? '1' : '2');
  await wait(140);
  cardsDone++;
  if (await page.locator('.done-wrap').count()) break;
}
ok('完成一輪顯示結算', (await page.locator('.done-wrap').count()) === 1, `${cardsDone} 張卡片`);

/* 4. 測驗 */
await page.click('[data-tab="quiz"]');
await wait(300);
await page.click('[data-mode="mean"]');
await page.click('#startQuizBtn');
await wait(300);
ok('測驗有四個選項', (await page.locator('.option').count()) === 4);
for (let i = 0; i < 10; i++) {
  if (!(await page.locator('.option').count())) break;
  await page.locator('.option').first().click();
  await wait(150);
  if (await page.locator('#nextQBtn').count()) {
    await page.click('#nextQBtn');
    await wait(150);
  }
}
ok('測驗完成顯示成績', (await page.locator('.quiz-summary').count()) === 1);

/* 5. 進度頁 */
await page.click('[data-tab="stats"]');
await wait(400);
ok('進度頁有統計卡', (await page.locator('.stat').count()) === 4);
ok('進度頁有難度分布', (await page.locator('.level-card').count()) === 4);
const heat = await page.evaluate(() => {
  const map = document.querySelector('.heatmap');
  const panel = map && map.closest('.panel');
  if (!map || !panel) return null;
  const m = map.getBoundingClientRect(), p = panel.getBoundingClientRect();
  return { inside: m.right <= p.right + 1 && m.bottom <= p.bottom + 1, cells: map.querySelectorAll('.hm-cell').length };
});
ok('學習足跡不出界', heat && heat.inside && heat.cells === 84, JSON.stringify(heat));

/* 6. 單詞庫 */
await page.click('[data-tab="library"]');
await wait(350);
ok('單詞庫可搜尋', (await page.locator('#libSearch').count()) === 1);
await page.fill('#libSearch', 'abandon');
await wait(250);
ok('搜尋有結果', (await page.locator('.lib-row').count()) >= 1);

/* 7. 手機尺寸 */
await page.setViewportSize({ width: 390, height: 844 });
await wait(300);
const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok('手機版無水平溢出', overflowX <= 1, `${overflowX}px`);

/* 8. 截圖（可選，需要 docs/screenshots） */
try {
  if (existsSync(SHOTS)) {
    await page.screenshot({ path: join(SHOTS, 'smoke-mobile.png') });
    mkdirSync(SHOTS, { recursive: true });
  }
} catch { /* 截圖失敗不影響測試 */ }

ok('沒有 JavaScript 錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter(r => !r.pass);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
if (failed.length) {
  console.error('FAILED: ' + failed.map(f => f.name).join(' | '));
  process.exit(1);
}
