/* =====================================================================
   WordLab 單詞工坊
   單檔案應用邏輯：狀態管理 / 間隔重複演算法 / 學習卡片 / 測驗 / 進度
   ===================================================================== */
(function () {
  'use strict';

  /* ==================================================================
     0. 常數與工具
     ================================================================== */
  const APP_VERSION = '1.1.0';
  const STORAGE_KEY = 'wordlab.v1';
  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;

  const WORDS = (() => {
    const merged = [].concat(window.WORDS || [], window.WORDS_EXTRA || [], window.WORDS_EXTRA2 || []);
    const seenId = new Set(), seenWord = new Set(), out = [];
    for (const w of merged) {
      const key = String(w.word || '').toLowerCase();
      if (!w || !w.id || seenId.has(w.id) || seenWord.has(key)) continue;
      seenId.add(w.id); seenWord.add(key); out.push(w);
    }
    return out;
  })();
  const WORD_BY_ID = new Map();
  WORDS.forEach(w => { if (!WORD_BY_ID.has(w.id)) WORD_BY_ID.set(w.id, w); });

  const LEVELS = {
    1: { label: '基礎', cls: 'pill-ok', hint: '日常高頻字' },
    2: { label: '中階', cls: 'pill-gold', hint: 'IELTS 5.5–6.5' },
    3: { label: '進階', cls: 'pill-warm', hint: 'IELTS 6.5–7.5' },
    4: { label: '高階', cls: 'pill-danger', hint: '學術／TOEFL 100+' },
  };
  function levelInfo(level) {
    return LEVELS[level] || { label: `L${level}`, cls: 'pill-grey', hint: '' };
  }

  const LEARN_STEPS = [0, 1, 3, 7];            // 新詞的學習階梯（天）
  const MASTER_INTERVAL = 21;                   // 間隔 ≥ 21 天視為「已掌握」
  const RELEARN_MINUTES = 10;                   // 答錯後隔幾分鐘再出現在佇列
  const REVIEW_MODES = ['mean', 'def', 'spell', 'listen'];

  const els = {
    view: document.getElementById('view'),
    tabs: Array.from(document.querySelectorAll('.tab')),
    streak: document.getElementById('streakCount'),
    toast: document.getElementById('toast'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    settingsClose: document.getElementById('settingsClose'),
    brand: document.getElementById('brandHome'),
  };

  /* ---------- 小工具 ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function sample(arr, n) { return shuffle(arr).slice(0, n); }

  /** 本地日期 YYYY-MM-DD（用本地時區，避免 UTC 跨日問題） */
  function dateKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function todayStart() { return dayStart(Date.now()); }
  function addDays(ts, n) { return ts + n * DAY; }
  /** 兩個日期字串相差天數（b - a） */
  function daysBetween(aKey, bKey) {
    return Math.round((new Date(bKey + 'T00:00:00').getTime() - new Date(aKey + 'T00:00:00').getTime()) / DAY);
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  function relDueLabel(due) {
    if (due == null) return '未學習';
    const diff = Math.round((dayStart(due) - todayStart()) / DAY);
    if (diff <= 0) return diff === 0 ? '今天' : `逾期 ${-diff} 天`;
    if (diff === 1) return '明天';
    return `${diff} 天後`;
  }
  function nextDueLabel(ts) {
    const diff = Math.round((dayStart(ts) - todayStart()) / DAY);
    if (diff <= 0) return '今天';
    if (diff === 1) return '明天';
    return `${diff} 天後`;
  }

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-show'), ms);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (_) { /* ignore */ } }
  }

  /* ==================================================================
     1. 語音（Web Speech API，可選功能）
     ================================================================== */
  const speech = {
    get supported() {
      return typeof window !== 'undefined' &&
        !!window.speechSynthesis &&
        typeof window.speechSynthesis.speak === 'function';
    },
    voiceFor(accent) {
      if (!this.supported) return null;
      const voices = window.speechSynthesis.getVoices() || [];
      const lang = accent === 'en-GB' ? 'en-GB' : 'en-US';
      return voices.find(v => v.lang && v.lang.replace('_', '-') === lang)
        || voices.find(v => v.lang && v.lang.toLowerCase().startsWith('en'))
        || null;
    },
    speak(text, accent) {
      if (!this.supported || !text) return false;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(String(text));
        const v = this.voiceFor(accent);
        if (v) u.voice = v;
        u.lang = accent === 'en-GB' ? 'en-GB' : 'en-US';
        u.rate = 0.92;
        u.pitch = 1;
        window.speechSynthesis.speak(u);
        return true;
      } catch (_) {
        return false;
      }
    },
  };
  if (speech.supported) {
    // 部分瀏覽器需要先觸發一次語音清單載入
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => { /* 觸發載入即可 */ };
  }

  /* ==================================================================
     2. 狀態管理
     ================================================================== */
  function defaultState() {
    return {
      version: 1,
      createdAt: Date.now(),
      settings: {
        name: '',
        dailyGoal: 20,
        quizMode: 'mixed',
        accent: 'en-US',
        autoSpeak: false,
        newWordLevel: 0,      // 0=全部；1-4=只學該難度
      },
      progress: {},           // id -> { reps, interval, ease, due, lapses, lastReview, firstLearn, history[] }
      days: {},               // 'YYYY-MM-DD' -> { reviews, correct, new, quizzes, quizCorrect }
      stats: {
        totalReviews: 0,
        totalCorrect: 0,
        totalQuizzes: 0,
        quizCorrect: 0,
        quizTotal: 0,
        sessions: [],         // 最近的測驗紀錄 { at, mode, total, correct }
      },
      onboarded: false,        // 是否已完成引導（即使名字留空）
      lastStudyDay: null,
    };
  }

  let state = loadState();

  function loadState() {
    const base = defaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return base;

      const merged = Object.assign(base, parsed);
      merged.settings = Object.assign(defaultState().settings, parsed.settings || {});
      merged.stats = Object.assign(defaultState().stats, parsed.stats || {});
      if (!merged.progress || typeof merged.progress !== 'object') merged.progress = {};
      if (!merged.days || typeof merged.days !== 'object') merged.days = {};
      if (!Array.isArray(merged.stats.sessions)) merged.stats.sessions = [];
      // 清理已不存在的單詞
      Object.keys(merged.progress).forEach(id => { if (!WORD_BY_ID.has(id)) delete merged.progress[id]; });
      return merged;
    } catch (err) {
      console.warn('[WordLab] 讀取進度失敗，使用新狀態', err);
      return base;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.warn('[WordLab] 儲存失敗', err);
      toast('⚠️ 無法儲存進度（瀏覽器空間可能已滿）', 3200);
      return false;
    }
  }

  function getProgress(id) { return state.progress[id] || null; }
  function ensureProgress(id) {
    if (!state.progress[id]) {
      state.progress[id] = {
        reps: 0,
        interval: 0,
        ease: 2.5,
        due: null,
        lapses: 0,
        lastReview: null,
        firstLearn: null,
        history: [],
      };
    }
    return state.progress[id];
  }
  function isLearned(id) { return !!state.progress[id]; }
  function isDue(p, now = Date.now()) {
    return !!p && p.due != null && dayStart(p.due) <= dayStart(now);
  }
  function isMastered(p) { return !!p && p.interval >= MASTER_INTERVAL; }
  function isNew(id) { return !state.progress[id]; }

  /* ---------- 每日活動 ---------- */
  function dayRecord(key = dateKey()) {
    if (!state.days[key]) state.days[key] = { reviews: 0, correct: 0, new: 0, quizzes: 0, quizCorrect: 0 };
    const d = state.days[key];
    if (typeof d.reviews !== 'number') d.reviews = 0;
    if (typeof d.correct !== 'number') d.correct = 0;
    if (typeof d.new !== 'number') d.new = 0;
    if (typeof d.quizzes !== 'number') d.quizzes = 0;
    if (typeof d.quizCorrect !== 'number') d.quizCorrect = 0;
    return d;
  }
  function todayStats() { return dayRecord(); }

  function touchStudyDay() {
    const key = dateKey();
    if (state.lastStudyDay === key) return;
    state.lastStudyDay = key;
  }

  /** 某天是否有任何學習活動 */
  function dayHasActivity(d) {
    return !!d && ((d.reviews || 0) > 0 || (d.quizzes || 0) > 0 || (d.new || 0) > 0);
  }

  /** 連續學習天數（由 days 記錄推算，今天沒學則從昨天起算） */
  function streakDays() {
    let streak = 0;
    const cursor = new Date();
    const todayKey = dateKey(cursor);
    if (!dayHasActivity(state.days[todayKey])) cursor.setDate(cursor.getDate() - 1);
    for (let i = 0; i < 3650; i++) {
      const key = dateKey(cursor);
      if (dayHasActivity(state.days[key])) { streak++; cursor.setDate(cursor.getDate() - 1); }
      else break;
    }
    return streak;
  }

  /** 總學習天數 */
  function totalStudyDays() {
    return Object.values(state.days).filter(dayHasActivity).length;
  }

  /* ==================================================================
     3. 間隔重複演算法（SM-2 變體）
     ================================================================== */
  /**
   * 計算某個評分下的下次複習排程
   * @param {object} p 進度物件
   * @param {number} q 品質 0-5（本程式使用 2=忘記、4=普通、5=熟記）
   * @param {object} [opts] { relearn:boolean } 答錯時是否 10 分鐘後再練
   */
  function scheduleProgress(p, q, opts) {
    const relearn = !!(opts && opts.relearn);
    const prevInterval = p.interval || 0;
    let ease = p.ease || 2.5;
    let reps = p.reps || 0;
    let interval;

    if (q < 3) {
      // 忘記：回到學習階梯起點
      reps = 0;
      interval = 1;
      p.lapses = (p.lapses || 0) + 1;
      ease = clamp(ease - 0.2, 1.3, 3.0);
    } else {
      if (prevInterval < 1) {
        // 第一次學：普通 → 明天；熟記 → 三天後
        interval = q === 5 ? 3 : 1;
      } else if (prevInterval === 1) {
        interval = q === 5 ? 5 : 3;
      } else {
        interval = Math.round(prevInterval * ease);
        if (q === 5) interval = Math.round(interval * 1.15);
      }
      reps += 1;
      ease = clamp(ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)), 1.3, 3.0);
    }

    interval = clamp(interval, 1, 365);
    p.interval = interval;
    p.ease = Math.round(ease * 100) / 100;
    p.reps = reps;
    // 答錯的卡片十分鐘後可再次練習；其他依天數排程
    p.due = (q < 3 && relearn) ? Date.now() + RELEARN_MINUTES * MINUTE : addDays(todayStart(), interval);
    p.lastReview = Date.now();
    if (!p.firstLearn) p.firstLearn = Date.now();
    return p;
  }

  /** 預覽三個評分按鈕會得到的間隔 */
  function previewIntervals(id) {
    const current = state.progress[id];
    const base = current ? {
      reps: current.reps, interval: current.interval, ease: current.ease,
      due: current.due, lapses: current.lapses, lastReview: current.lastReview,
      firstLearn: current.firstLearn, history: current.history,
    } : { reps: 0, interval: 0, ease: 2.5, due: null, lapses: 0, lastReview: null, firstLearn: null, history: [] };

    const out = {};
    [2, 4, 5].forEach(q => {
      const copy = Object.assign({}, base);
      scheduleProgress(copy, q, { relearn: true });
      out[q] = q === 2 ? `${RELEARN_MINUTES} 分鐘後` : `${copy.interval} 天後`;
    });
    return out;
  }

  function applyReview(id, q, source) {
    const word = WORD_BY_ID.get(id);
    if (!word) return;
    const existed = !!state.progress[id];
    const p = ensureProgress(id);
    const before = { interval: p.interval, reps: p.reps };
    scheduleProgress(p, q, { relearn: true });
    p.history = (p.history || []).slice(-49);
    p.history.push({ at: Date.now(), q, interval: p.interval });

    const today = dayRecord();
    today.reviews += 1;
    if (q >= 3) today.correct += 1;
    if (!existed) today.new += 1;

    state.stats.totalReviews += 1;
    if (q >= 3) state.stats.totalCorrect += 1;
    touchStudyDay();
    saveState();

    return { word, progress: p, before, source };
  }

  /* ==================================================================
     4. 佇列與池子
     ================================================================== */
  /** 逾期越久越優先；學習中答錯的卡片（10 分鐘後）也會排進來 */
  function dueNow() {
    const list = [];
    for (const w of WORDS) {
      const p = state.progress[w.id];
      if (p && isDue(p)) list.push(w);
    }
    return list.sort((a, b) => {
      const pa = state.progress[a.id], pb = state.progress[b.id];
      return (pa.due - pb.due) || (pa.lastReview - pb.lastReview);
    });
  }
  const dueWords = dueNow;

  /** 今日稍後（已排程但未到時間）的卡片數量 */
  function laterTodayCount() {
    const end = todayStart() + DAY;
    let count = 0;
    for (const p of Object.values(state.progress)) {
      if (p.due != null && p.due > Date.now() && p.due < end) count += 1;
    }
    return count;
  }

  function newWordsPool() {
    // 依序：基礎 → 中階 → 進階 → 高階
    const pref = Number(state.settings.newWordLevel) || 0;
    const list = WORDS.filter(w => !state.progress[w.id] && (!pref || w.level === pref));
    list.sort((a, b) => (a.level - b.level) || a.word.localeCompare(b.word));
    return list;
  }

  /** 建立本次學習佇列：先複習到期單詞，再用新詞補足每日目標 */
  function buildQueue() {
    const goal = clamp(Number(state.settings.dailyGoal) || 20, 5, 100);
    const today = todayStats();
    const remainingToday = Math.max(0, goal - today.reviews);
    const due = dueWords();
    const queue = [];
    const seen = new Set();

    // 1) 到期複習優先
    for (const w of due) {
      if (queue.length >= goal) break;
      queue.push(w.id);
      seen.add(w.id);
    }

    // 2) 新詞：本次最多 10 個，且不超過每日剩餘額度
    const newQuota = Math.min(10, Math.max(0, remainingToday - queue.length), goal - queue.length);
    if (newQuota > 0) {
      let introduced = 0;
      for (const w of newWordsPool()) {
        if (introduced >= newQuota || queue.length >= goal) break;
        if (seen.has(w.id)) continue;
        queue.push(w.id);
        seen.add(w.id);
        introduced += 1;
      }
    }
    return queue;
  }

  /** 取得可出題的單詞池 */
  function quizPool(mode) {
    const learned = WORDS.filter(w => state.progress[w.id]);
    const due = dueWords();
    let pool = [];
    if (due.length >= 4) pool = due.slice();
    if (pool.length < 12) {
      const extra = shuffle(learned.filter(w => !pool.some(p => p.id === w.id)));
      pool = pool.concat(extra);
    }
    if (pool.length < 4) {
      const fresh = shuffle(WORDS.filter(w => !pool.some(p => p.id === w.id)));
      pool = pool.concat(fresh.slice(0, Math.max(0, 20 - pool.length)));
    }
    if (mode === 'listen' && !speech.supported) {
      // 不支援語音時退回看詞選義
    }
    return pool;
  }

  /* ==================================================================
     5. 路由
     ================================================================== */
  const routes = ['learn', 'quiz', 'stats', 'library'];
  let currentRoute = 'learn';
  let sheetMode = 'settings';   // 'settings' | 'word'
  const ui = {
    reveal: false,          // 學習卡片是否已翻面
    queue: [],              // 學習佇列（word id）
    queueIndex: 0,          // 已完成的數量
    queueTotal: 0,
    sessionRatings: { again: 0, good: 0, easy: 0 },
    sessionStart: 0,
    done: false,            // 學習 session 是否結束
    libQuery: '',
    libFilter: 'all',
    libLimit: 60,
    quiz: null,             // 測驗狀態
  };

  function parseHash() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    const name = h.split('?')[0];
    return routes.includes(name) ? name : 'learn';
  }

  function go(route) {
    if (!routes.includes(route)) route = 'learn';
    if (location.hash !== '#/' + route) {
      location.hash = '#/' + route;
    } else {
      render();
    }
  }

  window.addEventListener('hashchange', () => {
    currentRoute = parseHash();
    if (currentRoute === 'learn') startStudySession(false);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ==================================================================
     6. 頂部狀態
     ================================================================== */
  function renderChrome() {
    if (els.streak) els.streak.textContent = String(streakDays());
    els.tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === currentRoute));
    const name = state.settings.name;
    document.title = name
      ? `${name} · WordLab 單詞工坊`
      : 'WordLab 單詞工坊 · 英文單詞學習';
  }

  /* ==================================================================
     7. 學習頁
     ================================================================== */
  function startStudySession(force) {
    if (!force && ui.queue.length && ui.queueIndex < ui.queue.length && !ui.done) return;
    ui.queue = buildQueue();
    ui.queueIndex = 0;
    ui.queueTotal = ui.queue.length;
    ui.reveal = false;
    ui.done = ui.queue.length === 0;
    ui.sessionRatings = { again: 0, good: 0, easy: 0 };
    ui.sessionStart = Date.now();
  }

  function currentStudyWord() {
    const id = ui.queue[ui.queueIndex];
    return id ? WORD_BY_ID.get(id) : null;
  }

  function viewLearn() {
    // 第一次使用 → 引導設定（名字可以留空，所以用 onboarded 標記）
    if (!state.onboarded && !state.settings.name && state.stats.totalReviews === 0 && Object.keys(state.progress).length === 0) {
      return viewOnboarding();
    }

    if (!ui.queue.length && !ui.done) startStudySession(false);

    if (ui.done) return viewStudyDone();

    const word = currentStudyWord();
    if (!word) { startStudySession(true); }

    const w = currentStudyWord();
    if (!w) return viewStudyDone();

    const p = state.progress[w.id];
    const previews = previewIntervals(w.id);
    const done = ui.queueIndex;
    const total = ui.queueTotal || 1;
    const pct = Math.round((done / total) * 100);
    const today = todayStats();
    const goal = clamp(Number(state.settings.dailyGoal) || 20, 5, 100);
    const goalPct = clamp(Math.round((today.reviews / goal) * 100), 0, 100);
    const overGoal = today.reviews - goal;

    return `
    <div class="study-bar">
      <span class="badge badge-level">${levelBadge(w.level)}</span>
      <div class="progress-track" aria-hidden="true"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="study-count">${done} / ${total}</span>
    </div>
    ${(() => {
      const queueDue = ui.queue.slice(ui.queueIndex).filter(id => isDue(state.progress[id])).length;
      if (!queueDue) return '';
      return `<div class="due-banner">
        <span class="due-dot" aria-hidden="true"></span>
        <span>這輪有 <b>${queueDue}</b> 個到期複習</span>
        <button class="link-btn" type="button" id="onlyDueBtn">只複習到期的</button>
      </div>`;
    })()}

    <div class="flashcard" id="flashcard">
      ${ui.reveal ? renderCardBack(w, p) : renderCardFront(w, p)}
    </div>

    ${ui.reveal ? renderRatingBar(w, p, previews) : `
      <div class="study-actions">
        <button class="btn btn-primary btn-lg" type="button" id="revealBtn">顯示答案</button>
      </div>
      <p class="kbd-hint"><span class="kbd">Space</span> 顯示答案 · 先自己想一想再看</p>
    `}

    <div class="goal-strip">
      <div class="goal-strip-head">
        <span>今日進度</span>
        <span>${overGoal > 0
          ? `<b>已達成</b> · ${today.reviews} / ${goal} 個（+${overGoal}）`
          : `<b>${today.reviews}</b> / ${goal} 個`}</span>
      </div>
      <div class="progress-track thin"><div class="progress-fill" style="width:${goalPct}%"></div></div>
    </div>
    `;
  }

  function levelBadge(level) {
    const info = levelInfo(level);
    return `<span class="pill ${info.cls}">${info.label}</span>`;
  }

  function renderCardFront(w, p) {
    const status = !p ? '新單詞' : (isDue(p) ? '待複習' : '複習中');
    return `
      <div class="fc-front flashcard-inner">
        <div class="fc-top">
          <span class="fc-status">${status}</span>
          ${levelBadge(w.level)}
        </div>
        <div class="fc-word">${esc(w.word)}</div>
        <div class="fc-phonetic">${esc(w.phonetic)}</div>
        <button class="btn btn-ghost btn-sm" type="button" id="speakBtn" data-word="${esc(w.word)}">
          🔊 聽發音
        </button>
        <div class="fc-prompt">
          <span class="fc-prompt-line"></span>
          <span>想想它的意思，再翻面</span>
          <span class="fc-prompt-line"></span>
        </div>
      </div>
    `;
  }

  function renderCardBack(w, p) {
    return `
      <div class="fc-back flashcard-inner">
        <div class="fc-top">
          <span class="fc-status">${!p ? '新單詞' : '第 ' + ((p.reps || 0) + 1) + ' 次複習'}</span>
          <button class="btn btn-ghost btn-xs" type="button" id="speakBtn" data-word="${esc(w.word)}">🔊 發音</button>
        </div>
        <div class="fc-word small">${esc(w.word)}</div>
        <div class="fc-phonetic">${esc(w.phonetic)}</div>
        <div class="fc-zh"><span class="pos">${esc(w.pos)}</span> ${esc(w.zh)}</div>
        <div class="fc-def">${esc(w.def)}</div>
        <div class="example">
          <div class="example-en">${esc(w.example)}</div>
          <div class="example-zh">${esc(w.exampleZh)}</div>
        </div>
        ${w.tags && w.tags.length ? `<div class="fc-tags">${w.tags.map(t => `<span class="pill pill-grey">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    `;
  }

  function renderRatingBar(w, p, previews) {
    const btn = (q, label, cls) => `
      <button class="rate-btn ${cls}" type="button" data-rating="${q}">
        <span class="rate-label">${label}</span>
        <span class="rate-sub">${previews[q]}</span>
      </button>`;
    return `
      <div class="rate-bar">
        <div class="rate-title">這次記得怎麼樣？</div>
        <div class="rate-buttons">
          ${btn(2, '忘記', 'rate-again')}
          ${btn(4, '普通', 'rate-good')}
          ${btn(5, '熟記', 'rate-easy')}
        </div>
        <p class="kbd-hint"><span class="kbd">1</span><span class="kbd">2</span><span class="kbd">3</span> 快速評分 · 系統會自動安排下次複習時間</p>
      </div>
    `;
  }

  function viewStudyDone() {
    const today = todayStats();
    const goal = clamp(Number(state.settings.dailyGoal) || 20, 5, 100);
    const due = dueWords().length;
    const laterToday = laterTodayCount();
    const newLeft = newWordsPool().length;
    const reachedGoal = today.reviews >= goal;
    const sessionCount = ui.sessionRatings.again + ui.sessionRatings.good + ui.sessionRatings.easy;
    const allDone = due === 0 && newLeft === 0 && laterToday === 0;
    const levelPref = Number(state.settings.newWordLevel) || 0;

    const emoji = allDone ? '🏅' : reachedGoal ? '🎉' : '✅';
    const title = allDone ? '全部單詞都學完了！' : reachedGoal ? '今日目標達成！' : '這輪學習完成了';

    return `
    <div class="done-wrap card">
      <div class="done-emoji">${emoji}</div>
      <h1>${title}</h1>
      <p class="done-sub">
        ${allDone
          ? '你已認識所有單詞，接下來靠測驗與複習把它們牢牢記住。'
          : reachedGoal
            ? `你今天已經複習了 <b>${today.reviews}</b> 個單詞，休息一下或繼續挑戰。`
            : `今天複習了 <b>${today.reviews}</b> 個單詞，距離目標還有 <b>${goal - today.reviews}</b> 個。`}
      </p>

      ${sessionCount > 0 ? `
      <div class="done-breakdown">
        <div><b>${sessionCount}</b><span>本輪單詞</span></div>
        <div><b>${ui.sessionRatings.good + ui.sessionRatings.easy}</b><span>記得</span></div>
        <div><b>${ui.sessionRatings.again}</b><span>忘記</span></div>
      </div>` : ''}

      <div class="done-actions">
        ${allDone
          ? '<button class="btn btn-warm" type="button" id="doneQuizBtn">去做測驗</button>'
          : `<button class="btn btn-primary" type="button" id="nextRoundBtn">
              ${due > 0 ? `繼續複習（${due} 個到期）` : '再學一輪'}
            </button>
            <button class="btn btn-warm" type="button" id="doneQuizBtn">去做測驗</button>`}
        <button class="btn btn-ghost" type="button" id="doneStatsBtn">看學習進度</button>
      </div>

      <p class="done-hint">
        ${due > 0 ? `目前有 <b>${due}</b> 個單詞到期複習。` : '目前沒有到期單詞。'}
        ${laterToday > 0 ? `另有 <b>${laterToday}</b> 個會在稍後（10 分鐘內）再次出現。` : ''}
        ${newLeft > 0 ? `還有 <b>${newLeft}</b> 個新單詞等你探索${levelPref ? `（目前只挑「${levelInfo(levelPref).label}」難度）` : ''}。` : ''}
      </p>

      ${due > 0 ? `
      <div class="done-due">
        ${dueWords().slice(0, 5).map(w => `
          <button class="done-due-item" type="button" data-word="${esc(w.word)}" title="聽發音">
            <span class="dw-word">${esc(w.word)}</span>
            <span class="dw-zh">${esc(w.zh)}</span>
          </button>`).join('')}
        ${due > 5 ? `<span class="done-due-more">還有 ${due - 5} 個…</span>` : ''}
      </div>` : ''}
    </div>`;
  }

  /* ==================================================================
     8. 測驗
     ================================================================== */
  function newQuizState(mode, count) {
    if (mode === 'listen' && !speech.supported) mode = 'mean';
    const pool = quizPool(mode);
    const chosen = sample(pool.length ? pool : WORDS, clamp(count, 1, 50));
    return {
      mode,
      questions: chosen.map(w => makeQuestion(w, mode, pool)),
      index: 0,
      correct: 0,
      answered: false,
      picked: null,
      input: '',
      revealed: false,      // 是否已公布答案
      played: false,
      startedAt: Date.now(),
      failures: [],
      done: false,
    };
  }

  function makeQuestion(word, mode, pool) {
    let type = mode;
    if (mode === 'mixed') {
      const options = ['mean', 'def', 'spell'];
      if (speech.supported) options.push('listen');
      type = options[Math.floor(Math.random() * options.length)];
    }
    if (type === 'listen' && !speech.supported) type = 'mean';

    // 中文釋義相似度：避免出現兩個幾乎相同的中文選項（例如「同意；贊成」與「接受；同意」）
    const meaningKeys = (zh) => String(zh || '')
      .split(/[；;、,，/（）()]/)
      .map(s => s.replace(/的|地|得|了|著|之/g, '').trim())
      .filter(Boolean);
    const tooSimilar = (a, b) => {
      if (!a || !b) return false;
      const ka = meaningKeys(a.zh), kb = meaningKeys(b.zh);
      if (!ka.length || !kb.length) return false;
      for (const x of ka) for (const y of kb) {
        if (x === y) return true;
        // 短詞（單字）出現在長詞中才算重疊，避免「能力」與「有能力」這類合理區分被誤判
        if (x.length === 1 && y.length >= 2 && y.includes(x)) return true;
        if (y.length === 1 && x.length >= 2 && x.includes(y)) return true;
      }
      return false;
    };

    const distractors = (key) => {
      const usedIds = new Set([word.id]);
      const usedTexts = new Set([String(word[key])]);
      const picked = [];
      const segmentsOf = (w) => (key === 'zh' ? meaningKeys(w.zh) : []);
      const pickedSegments = new Set();

      const isUsable = (w) => {
        if (usedIds.has(w.id)) return false;
        if (key === 'zh') {
          if (tooSimilar(w, word)) return false;
          for (const seg of segmentsOf(w)) if (pickedSegments.has(seg)) return false;
        }
        if (usedTexts.has(String(w[key]))) return false;
        return true;
      };

      for (const source of [pool, WORDS]) {
        for (const w of shuffle(source)) {
          if (picked.length >= 3) break;
          if (!isUsable(w)) continue;
          usedIds.add(w.id);
          usedTexts.add(String(w[key]));
          if (key === 'zh') segmentsOf(w).forEach(seg => pickedSegments.add(seg));
          picked.push(w);
        }
        if (picked.length >= 3) break;
      }
      return picked;
    };

    if (type === 'mean') {
      const opts = shuffle([word, ...distractors('zh')]).map(w => ({ id: w.id, text: `${w.zh}` }));
      return { type, word, prompt: '選出正確的中文意思', options: opts, answerId: word.id };
    }
    if (type === 'def') {
      const opts = shuffle([word, ...distractors('zh')]).map(w => ({ id: w.id, text: w.word }));
      return { type, word, prompt: '哪個英文單詞符合這個意思？', options: opts, answerId: word.id };
    }
    if (type === 'listen') {
      const opts = shuffle([word, ...distractors('zh')]).map(w => ({ id: w.id, text: `${w.zh}` }));
      return { type, word, prompt: '聽發音，選出正確意思', options: opts, answerId: word.id };
    }
    // spell
    return { type: 'spell', word, prompt: '根據中文意思拼出英文單詞', answerText: word.word };
  }

  /* ---------- 圖示（inline SVG） ---------- */
  const ICONS = {
    quiz: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8l4 4v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M16 4v4h4"/><path d="M9 13h6M9 16.5h4"/></svg>',
    mixed: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l7 10h6"/><path d="M17 14l3 3-3 3"/><path d="M4 17h3l2.5-3.6"/><path d="M13.2 9.4L14 8h6"/><path d="M17 2l3 3-3 3"/></svg>',
    mean: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 10h10M4 14h7M4 18h5"/><path d="M16 13.5l2 1.5-2 1.5"/><circle cx="18.5" cy="8.5" r="3.2"/></svg>',
    def: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M8 4v16M12 9h4M12 13h4"/></svg>',
    spell: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6 9h1M10 9h1M14 9h1M18 9h1M7 12h1M11 12h1M15 12h1M7 15h10"/></svg>',
    listen: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2zM20 14a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2z"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="#b8892f" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 2.6 4M17 6h2.5a2.5 2.5 0 0 1-2.6 4"/><path d="M12 14v4M8.5 21h7M9.5 21v-2.2h5V21"/></svg>',
  };

  function viewQuiz() {
    const q = ui.quiz;
    if (q && !q.done) return renderQuizQuestion(q);
    if (q && q.done) return renderQuizSummary(q);
    return renderQuizSetup();
  }

  function renderQuizSetup() {
    const due = dueWords().length;
    const learnedCount = WORDS.filter(w => state.progress[w.id]).length;
    const mode = state.settings.quizMode;

    const modeCard = (val, icon, title, sub) => `
      <button class="mode-card ${mode === val ? 'is-on' : ''}" type="button" data-mode="${val}">
        <span class="mode-icon">${icon}</span>
        <span class="mode-body"><strong>${title}</strong><span>${sub}</span></span>
      </button>`;

    return `
    <div class="quiz-wrap">
      <div class="quiz-hero card">
        <div class="quiz-hero-icon">${ICONS.quiz}</div>
        <div>
          <h1>測驗一下</h1>
          <p class="quiz-hero-sub">從學過的單詞出題，答錯的會自動排回複習佇列。</p>
        </div>
      </div>

      <div class="field">
        <span class="field-label">選擇模式</span>
        <div class="mode-grid">
          ${modeCard('mixed', ICONS.mixed, '混合模式', '四種題型隨機出現')}
          ${modeCard('mean', ICONS.mean, '看詞選義', '看英文，選中文意思')}
          ${modeCard('def', ICONS.def, '看義選詞', '看中文，選英文單詞')}
          ${modeCard('spell', ICONS.spell, '拼寫練習', '看中文，打出英文')}
          ${modeCard('listen', ICONS.listen, '聽力測驗', speech.supported ? '聽發音，選出意思' : '此瀏覽器不支援語音')}
        </div>
      </div>

      <div class="field">
        <span class="field-label">題目數量</span>
        <div class="segmented" id="quizCount" role="group" aria-label="題目數量">
          <button type="button" data-count="10" class="is-on">10 題</button>
          <button type="button" data-count="20">20 題</button>
          <button type="button" data-count="30">30 題</button>
        </div>
      </div>

      <div class="quiz-info">
        <div><b>${learnedCount}</b><span>已學單詞</span></div>
        <div><b>${due}</b><span>今天到期</span></div>
        <div><b>${totalStudyDays()}</b><span>學習天數</span></div>
      </div>

      <button class="btn btn-primary btn-lg btn-block" type="button" id="startQuizBtn">開始測驗</button>
      ${learnedCount < 4 ? '<p class="hint center">先到「學習」頁認識幾個單詞，測驗會更有意義。</p>' : ''}
    </div>`;
  }

  function renderQuizQuestion(q) {
    const question = q.questions[q.index];
    const total = q.questions.length;
    const pct = Math.round((q.index / total) * 100);
    const w = question.word;
    const isSpell = question.type === 'spell';

    const promptHtml = (() => {
      if (question.type === 'mean') return `<div class="q-word">${esc(w.word)}</div><div class="q-sub">${esc(w.phonetic)}</div>`;
      if (question.type === 'def') return `<div class="q-meaning">${esc(w.zh)}</div><div class="q-sub">${esc(w.pos)}</div>`;
      if (question.type === 'listen') return `<div class="q-listen"><button class="listen-btn" type="button" id="listenBtn">🔊</button><div class="q-sub">點擊重聽發音</div></div>`;
      return `<div class="q-meaning">${esc(w.zh)}</div><div class="q-sub">${esc(w.pos)} · ${w.word.length} 個字母 · 首字母 ${esc(w.word[0].toUpperCase())}</div>`;
    })();

    const optionsHtml = question.options ? `
      <div class="options" role="group" aria-label="選項">
        ${question.options.map((o, i) => {
          let cls = 'option';
          if (q.answered) {
            if (o.id === question.answerId) cls += ' is-correct';
            else if (o.id === q.picked) cls += ' is-wrong';
          }
          return `<button class="${cls}" type="button" data-opt="${i}" ${q.answered ? 'disabled' : ''}>
            <span class="opt-key">${String.fromCharCode(65 + i)}</span>
            <span class="opt-text">${esc(o.text)}</span>
          </button>`;
        }).join('')}
      </div>` : `
      <div class="spell-form">
        <input id="spellInput" class="spell-input ${q.answered ? (q.correctNow ? 'is-correct' : 'is-wrong') : ''}"
               type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false"
               placeholder="輸入英文單詞" value="${esc(q.input || '')}" ${q.answered ? 'disabled' : ''}>
        ${!q.answered ? '<button class="btn btn-primary" type="button" id="spellSubmit">送出</button>' : ''}
      </div>`;

    const feedback = q.answered ? renderFeedback(q, question) : '';
    const nextLabel = q.index + 1 >= total ? '看成績' : '下一題';

    return `
    <div class="quiz-top">
      <span class="quiz-tag">${quizModeLabel(question.type)}</span>
      <span class="quiz-progress-text">第 <b>${q.index + 1}</b> / ${total} 題</span>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>

    <div class="question card">
      <div class="q-prompt">${esc(question.prompt)}</div>
      ${promptHtml}
      ${isSpell && !q.answered && !q.revealed ? `<button class="btn btn-ghost btn-xs hint-btn" type="button" id="hintBtn">💡 提示</button>` : ''}
      ${isSpell && q.revealed && !q.answered ? `<div class="hint-box">答案是 <b>${esc(question.answerText)}</b>，打出來試試看。</div>` : ''}
      ${optionsHtml}
      ${feedback}
      <div class="quiz-foot">
        <span class="quiz-score">${q.correct} 題正確</span>
        ${q.answered ? `<button class="btn btn-primary" type="button" id="nextQBtn">${nextLabel} →</button>` : ''}
      </div>
    </div>
    ${!q.answered && !isSpell ? '<p class="kbd-hint"><span class="kbd">A</span>–<span class="kbd">D</span> 選答案</p>' : ''}
    ${!q.answered && isSpell ? '<p class="kbd-hint"><span class="kbd">Enter</span> 送出答案</p>' : ''}
    `;
  }

  function renderFeedback(q, question) {
    const w = question.word;
    const ok = q.correctNow;
    const title = ok ? '答對了' : '再記一次';
    const icon = ok ? '✓' : '✕';
    let body = '';
    if (question.type === 'mean' || question.type === 'listen') {
      body = `<div class="fb-answer">${esc(w.word)} <span class="fb-phon">${esc(w.phonetic)}</span> — ${esc(w.zh)}</div>
              <div class="fb-example">${esc(w.example)}</div>`;
    } else if (question.type === 'def') {
      body = `<div class="fb-answer">${esc(w.zh)} → <b>${esc(w.word)}</b></div>
              <div class="fb-example">${esc(w.example)}</div>`;
    } else {
      const expected = question.answerText;
      body = q.correctNow
        ? `<div class="fb-answer"><b>${esc(w.word)}</b> — ${esc(w.zh)}</div>`
        : `<div class="fb-answer">正確拼寫：<b class="spell-compare">${compareSpell(q.input || '', expected)}</b></div>`;
    }
    return `
      <div class="feedback ${ok ? 'ok' : 'no'}">
        <div class="fb-head"><span class="fb-icon">${icon}</span><strong>${title}</strong></div>
        ${body}
      </div>`;
  }

  function compareSpell(input, expected) {
    const a = String(input || '').trim().toLowerCase();
    const b = String(expected || '').toLowerCase();
    let html = '';
    for (let i = 0; i < b.length; i++) {
      if (i < a.length && a[i] === b[i]) html += esc(b[i]);
      else html += `<span class="miss">${esc(b[i])}</span>`;
    }
    return html;
  }

  function quizModeLabel(type) {
    return {
      mean: '看詞選義', def: '看義選詞', spell: '拼寫練習', listen: '聽力測驗', mixed: '混合',
    }[type] || '測驗';
  }

  function renderQuizSummary(q) {
    const total = q.questions.length;
    const pct = total ? Math.round((q.correct / total) * 100) : 0;
    const emoji = pct >= 90 ? ICONS.trophy : pct >= 70 ? '🌟' : pct >= 50 ? '💪' : '📚';
    const verdict = pct >= 90 ? '幾乎全對，太厲害了！' : pct >= 70 ? '表現不錯，繼續保持。' : pct >= 50 ? '有進步空間，錯的單詞已排回複習。' : '別灰心，多複習幾次就會記住。';
    const wrong = q.questions.filter(item => !item.wasCorrect);

    return `
    <div class="quiz-summary card">
      <div class="summary-emoji">${emoji}</div>
      <div class="summary-score">${q.correct}<span> / ${total}</span></div>
      <div class="summary-pct">正確率 ${pct}%</div>
      <p class="summary-verdict">${verdict}</p>

      <div class="summary-actions">
        <button class="btn btn-primary" type="button" id="retryQuizBtn">再測一次</button>
        <button class="btn btn-ghost" type="button" id="newQuizBtn">換個模式</button>
        <button class="btn btn-ghost" type="button" id="summaryLearnBtn">回去學習</button>
      </div>

      ${wrong.length ? `
        <div class="wrong-block">
          <div class="wrong-head">需要加強的單詞（${wrong.length}）</div>
          <div class="wrong-list">
            ${wrong.map(item => `
              <div class="wrong-row">
                <span class="wr-word">${esc(item.word.word)}</span>
                <span class="wr-zh">${esc(item.word.zh)}</span>
                <button class="wr-speak" type="button" data-word="${esc(item.word.word)}" aria-label="發音">🔊</button>
              </div>`).join('')}
          </div>
        </div>` : `
        <div class="perfect-note">全部答對，這些單詞的複習間隔已經延長了。</div>`}
    </div>`;
  }

  function answerQuestion(optionIndex) {
    const q = ui.quiz;
    if (!q || q.answered || q.done) return;
    const question = q.questions[q.index];
    if (question.type === 'spell') return;

    const picked = question.options[optionIndex];
    if (!picked) return;
    q.picked = picked.id;
    handleAnswered(q, question, picked.id === question.answerId);
  }

  function submitSpell() {
    const q = ui.quiz;
    if (!q || q.answered || q.done) return;
    const question = q.questions[q.index];
    if (question.type !== 'spell') return;

    const input = (($('#spellInput') || {}).value || '').trim();
    q.input = input;
    if (!input) { toast('請先輸入答案'); return; }
    const isCorrect = input.toLowerCase() === String(question.answerText).toLowerCase();
    if (isCorrect) {
      handleAnswered(q, question, true);
    } else {
      // 答案錯誤：公布答案，再讓使用者打一次才算完成
      if (!q.revealed) {
        q.revealed = true;
        q.tried = true;
        renderIntoView();
        const el = $('#spellInput');
        if (el) {
          el.focus();
          el.select();
        }
        return;
      }
      handleAnswered(q, question, false);
    }
  }

  function handleAnswered(q, question, isCorrect) {
    q.answered = true;
    q.correctNow = isCorrect;
    q.wasCorrect = isCorrect;
    question.wasCorrect = isCorrect;
    if (isCorrect) q.correct += 1;
    else q.failures.push(question);

    // 更新間隔重複排程
    applyReview(question.word.id, isCorrect ? 4 : 2, 'quiz');

    // 每日測驗統計
    const today = dayRecord();
    today.quizzes += 1;
    if (isCorrect) today.quizCorrect += 1;
    saveState();

    if (isCorrect) vibrate(12);
    renderIntoView();
    const btn = $('#nextQBtn');
    if (btn) btn.focus({ preventScroll: true });
  }

  function nextQuestion() {
    const q = ui.quiz;
    if (!q) return;
    if (q.index + 1 >= q.questions.length) {
      finishQuiz();
      return;
    }
    q.index += 1;
    q.answered = false;
    q.picked = null;
    q.input = '';
    q.revealed = false;
    q.correctNow = null;
    q.tried = false;
    q.played = false;
    renderIntoView();
    focusQuizInput();
    setTimeout(() => maybeSpeakQuestion(), 250);
  }

  function finishQuiz() {
    const q = ui.quiz;
    if (!q) return;
    q.done = true;
    const total = q.questions.length;
    state.stats.totalQuizzes += 1;
    state.stats.quizTotal += total;
    state.stats.quizCorrect += q.correct;
    state.stats.sessions = (state.stats.sessions || []).slice(-19);
    state.stats.sessions.push({
      at: Date.now(), mode: q.mode, total, correct: q.correct,
    });
    saveState();
    renderIntoView();
  }

  function focusQuizInput() {
    const input = $('#spellInput');
    if (input) input.focus();
  }

  /* ==================================================================
     9. 進度頁
     ================================================================== */
  function viewStats() {
    const learned = WORDS.filter(w => state.progress[w.id]).length;
    const mastered = WORDS.filter(w => state.progress[w.id] && isMastered(state.progress[w.id])).length;
    const due = dueWords().length;
    const laterToday = laterTodayCount();
    const today = todayStats();
    const acc = state.stats.totalReviews
      ? Math.round((state.stats.totalCorrect / state.stats.totalReviews) * 100) : 0;
    const quizAcc = state.stats.quizTotal
      ? Math.round((state.stats.quizCorrect / state.stats.quizTotal) * 100) : 0;

    const learning = learned - mastered;
    const newCount = WORDS.length - learned;

    // 最近 14 天
    const last14 = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      const rec = state.days[key];
      last14.push({ key, count: rec ? rec.reviews : 0, label: `${d.getMonth() + 1}/${d.getDate()}` });
    }
    const maxCount = Math.max(1, ...last14.map(d => d.count));

    // 最近 12 週熱力圖（以「週」為欄，週一為欄首，最後一欄是本週）
    const HEAT_WEEKS = 12;
    const heat = [];
    {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dow = (today.getDay() + 6) % 7;            // 週一 = 0
      const monday = new Date(today);
      monday.setDate(monday.getDate() - dow - (HEAT_WEEKS - 1) * 7);
      for (let i = 0; i < HEAT_WEEKS * 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        const key = dateKey(d);
        const rec = state.days[key];
        const c = rec ? rec.reviews : 0;
        const future = d > today;
        heat.push({
          key,
          count: c,
          future,
          level: future ? -1 : c === 0 ? 0 : c < 5 ? 1 : c < 12 ? 2 : c < 22 ? 3 : 4,
          label: `${d.getMonth() + 1}/${d.getDate()}`,
          weekday: d.getDay(),
        });
      }
    }
    const heatTotal = heat.reduce((s, h) => s + h.count, 0);
    const heatActiveDays = heat.filter(h => h.count > 0).length;

    const sessions = (state.stats.sessions || []).slice(-6).reverse();
    const masteredPct = WORDS.length ? Math.round((mastered / WORDS.length) * 100) : 0;
    const learningPct = WORDS.length ? Math.round((learning / WORDS.length) * 100) : 0;

    return `
    <div class="stats-head">
      <div>
        <div class="eyebrow">學習儀表板</div>
        <h1>你的進度</h1>
      </div>
      <div class="stats-streak">
        <span class="flame-big">🔥</span>
        <div><b>${streakDays()}</b><span>連續天數</span></div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat"><span class="stat-label">已學單詞</span><b>${learned}</b><span class="stat-sub">共 ${WORDS.length} 個</span></div>
      <div class="stat"><span class="stat-label">已掌握</span><b>${mastered}</b><span class="stat-sub">間隔 ≥ ${MASTER_INTERVAL} 天</span></div>
      <div class="stat"><span class="stat-label">今日複習</span><b>${today.reviews}</b><span class="stat-sub">${due ? `${due} 個到期` : '目前清空'}${laterToday ? ` · 稍後 ${laterToday}` : ''}</span></div>
      <div class="stat"><span class="stat-label">總正確率</span><b>${acc}<small>%</small></b><span class="stat-sub">${state.stats.totalReviews} 次複習</span></div>
    </div>

    <div class="panel card">
      <div class="panel-head"><h2>單詞掌握度</h2><span>${masteredPct}% 已掌握</span></div>
      <div class="mastery-bar" role="img" aria-label="掌握度分布">
        <span style="width:${masteredPct}%;background:linear-gradient(90deg,#4f8570,#2f5d50)"></span>
        <span style="width:${learningPct}%;background:linear-gradient(90deg,#e0b05f,#d08148)"></span>
        <span style="width:${100 - masteredPct - learningPct}%;background:#e9e3d6"></span>
      </div>
      <div class="mastery-legend">
        <div><span class="swatch" style="background:#2f5d50"></span>已掌握 <b>${mastered}</b></div>
        <div><span class="swatch" style="background:#d08148"></span>學習中 <b>${learning}</b></div>
        <div><span class="swatch" style="background:#e9e3d6"></span>未學習 <b>${newCount}</b></div>
        <div><span class="swatch" style="background:#b8892f"></span>測驗正確率 <b>${quizAcc}%</b></div>
      </div>
    </div>

    <div class="panel card">
      <div class="panel-head"><h2>難度分布</h2><span>共 ${WORDS.length} 個單詞</span></div>
      <div class="level-grid">
        ${[1, 2, 3, 4].map(lv => {
          const total = WORDS.filter(w => w.level === lv).length;
          const learnedLv = WORDS.filter(w => w.level === lv && state.progress[w.id]).length;
          const pct = total ? Math.round((learnedLv / total) * 100) : 0;
          const info = levelInfo(lv);
          return `<div class="level-card">
            <div class="level-card-head">
              <span class="pill ${info.cls}">${info.label}</span>
              <span class="level-count">${learnedLv} / ${total}</span>
            </div>
            <div class="level-track"><span style="width:${pct}%"></span></div>
            <div class="level-hint">${info.hint || '　'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="panel card">
      <div class="panel-head"><h2>近 14 天複習量</h2><span>每日 ${state.settings.dailyGoal} 個為目標</span></div>
      <div class="chart" role="img" aria-label="最近十四天每日複習數量">
        ${last14.map((d, i) => {
          const h = d.count ? Math.max(8, Math.round((d.count / maxCount) * 100)) : 3;
          const isToday = i === last14.length - 1;
          return `<div class="bar-col" title="${d.label}：${d.count} 個">
            <span class="bar-value">${d.count || ''}</span>
            <div class="bar ${isToday ? 'is-today' : ''}" style="height:${h}%"></div>
            <span class="bar-label">${d.label}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="legend-row">
        <span><span class="swatch" style="background:#2f5d50"></span>複習量</span>
        <span><span class="swatch" style="background:#c2703c"></span>今天</span>
        <span style="margin-left:auto">共 ${last14.reduce((s, d) => s + d.count, 0)} 次複習</span>
      </div>
    </div>

    <div class="panel card">
      <div class="panel-head"><h2>學習足跡</h2><span>最近 12 週</span></div>
      <div class="heatmap-wrap">
        <div class="hm-days" aria-hidden="true"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span></div>
        <div class="heatmap" role="img" aria-label="最近十二週學習熱力圖，顏色越深代表當天複習越多">
          ${heat.map(h => `<span class="hm-cell${h.key === dateKey() ? ' is-today' : ''}${h.future ? ' is-future' : ''}" data-level="${h.level}" title="${h.label}：${h.count} 個"></span>`).join('')}
        </div>
      </div>
      <div class="hm-foot">
        <span>${heatActiveDays} 天有學習紀錄 · 共 ${heatTotal} 次複習</span>
        <div class="hm-legend">少 <span class="hm-cell" data-level="0"></span><span class="hm-cell" data-level="1"></span><span class="hm-cell" data-level="2"></span><span class="hm-cell" data-level="3"></span><span class="hm-cell" data-level="4"></span> 多</div>
      </div>
    </div>

    <div class="panel card">
      <div class="panel-head"><h2>最近測驗</h2><span>${state.stats.totalQuizzes} 次測驗</span></div>
      ${sessions.length ? `
        <div class="session-list">
          ${sessions.map(s => {
            const p = Math.round((s.correct / s.total) * 100);
            return `<div class="session-row">
              <span class="session-date">${fmtDate(s.at)}</span>
              <span class="session-mode">${quizModeLabel(s.mode)}</span>
              <span class="session-score">${s.correct}/${s.total}</span>
              <span class="session-pct ${p >= 70 ? 'good' : p >= 40 ? 'mid' : 'low'}">${p}%</span>
            </div>`;
          }).join('')}
        </div>` : '<p class="empty-note">還沒有測驗紀錄，去「測驗」頁試試看吧。</p>'}
    </div>
    `;
  }

  /* ==================================================================
     10. 單詞庫
     ================================================================== */
  function libraryList() {
    const query = ui.libQuery.trim().toLowerCase();
    let list = WORDS.slice();
    if (query) {
      list = list.filter(w =>
        w.word.toLowerCase().includes(query) ||
        w.zh.includes(query) ||
        (w.def || '').toLowerCase().includes(query));
    }
    switch (ui.libFilter) {
      case 'new': list = list.filter(w => isNew(w.id)); break;
      case 'learning': list = list.filter(w => state.progress[w.id] && !isMastered(state.progress[w.id])); break;
      case 'mastered': list = list.filter(w => isMastered(state.progress[w.id])); break;
      case 'due': list = list.filter(w => isDue(state.progress[w.id])); break;
      case 'l1': list = list.filter(w => w.level === 1); break;
      case 'l2': list = list.filter(w => w.level === 2); break;
      case 'l3': list = list.filter(w => w.level === 3); break;
      case 'l4': list = list.filter(w => w.level === 4); break;
      default: break;
    }
    return list;
  }

  function viewLibrary() {
    const all = libraryList();
    const shown = all.slice(0, ui.libLimit);
    const filters = [
      ['all', '全部'], ['due', '今天到期'], ['new', '未學習'],
      ['learning', '學習中'], ['mastered', '已掌握'],
      ['l1', '基礎'], ['l2', '中階'], ['l3', '進階'], ['l4', '高階'],
    ];

    return `
    <div class="lib-head">
      <div><div class="eyebrow">單詞庫</div><h1>${WORDS.length} 個單詞</h1></div>
      <span class="pill pill-ok">${WORDS.filter(w => state.progress[w.id]).length} 已學</span>
    </div>

    <div class="lib-tools">
      <div class="search-wrap">
        <span class="search-icon">🔍</span>
        <input class="search-input" id="libSearch" type="search" placeholder="搜尋英文或中文…" value="${esc(ui.libQuery)}" autocomplete="off">
      </div>
      <div class="filter-chips" id="libFilters">
        ${filters.map(([val, label]) => `
          <button class="chip ${ui.libFilter === val ? 'is-on' : ''}" type="button" data-filter="${val}">${label}</button>`).join('')}
      </div>
    </div>

    <div class="lib-count">顯示 ${shown.length} / ${all.length} 個</div>

    <div class="lib-list">
      ${shown.length ? shown.map(w => renderLibraryRow(w)).join('') : '<p class="empty-note">沒有符合條件的單詞。</p>'}
      ${all.length > shown.length ? `<div class="load-more"><button class="btn btn-ghost" type="button" id="libMore">載入更多（還有 ${all.length - shown.length} 個）</button></div>` : ''}
    </div>
    `;
  }

  function renderLibraryRow(w) {
    const p = state.progress[w.id];
    let status = '<span class="pill pill-grey">未學</span>';
    if (p) {
      if (isMastered(p)) status = '<span class="pill pill-ok">已掌握</span>';
      else if (isDue(p)) status = '<span class="pill pill-warm">待複習</span>';
      else status = '<span class="pill pill-gold">學習中</span>';
    }
    return `
    <div class="lib-row">
      <button class="lib-word-btn" type="button" data-lib-open="${esc(w.id)}">
        <span class="lib-word">${esc(w.word)}</span>
        <span class="lib-meta">${esc(w.phonetic)} · ${esc(w.pos)}</span>
      </button>
      <span class="lib-zh">${esc(w.zh)}</span>
      <span class="lib-status">${status}</span>
      <button class="lib-speak icon-btn" type="button" data-word="${esc(w.word)}" aria-label="發音">🔊</button>
    </div>`;
  }

  function openWordSheet(id) {
    const w = WORD_BY_ID.get(id);
    if (!w) return;
    const p = state.progress[id];
    const status = !p ? '未學習' : isMastered(p) ? '已掌握' : isDue(p) ? '今天到期' : '學習中';
    const dueText = p ? nextDueLabel(p.due) : '—';

    els.settingsOverlay.hidden = false;
    sheetMode = 'word';
    $('#settingsTitle').textContent = '單詞詳情';
    $('#settingsBody').innerHTML = `
      <div class="word-sheet">
        <div class="ws-word">${esc(w.word)}</div>
        <div class="ws-phon">${esc(w.phonetic)}</div>
        <button class="btn btn-ghost btn-sm" type="button" data-word="${esc(w.word)}">🔊 聽發音</button>
        <div class="ws-zh"><span class="pos">${esc(w.pos)}</span> ${esc(w.zh)}</div>
        <div class="ws-def">${esc(w.def)}</div>
        <div class="example"><div class="example-en">${esc(w.example)}</div><div class="example-zh">${esc(w.exampleZh)}</div></div>
        <div class="ws-meta">
          <div><span>難度</span><b>${levelInfo(w.level).label}${levelInfo(w.level).hint ? ` · ${levelInfo(w.level).hint}` : ''}</b></div>
          <div><span>狀態</span><b>${status}</b></div>
          <div><span>下次複習</span><b>${dueText}</b></div>
          <div><span>複習次數</span><b>${p ? p.reps : 0}</b></div>
          <div><span>目前間隔</span><b>${p ? p.interval + ' 天' : '—'}</b></div>
          <div><span>記憶強度</span><b>${p ? p.ease.toFixed(2) : '—'}</b></div>
        </div>
        ${w.tags && w.tags.length ? `<div class="ws-tags">${w.tags.map(t => `<span class="pill pill-grey">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>`;
  }

  /* ==================================================================
     11. 引導頁
     ================================================================== */
  function viewOnboarding() {
    return `
    <div class="onboard card">
      <div class="onboard-mark">Words,<br><em>remembered.</em></div>
      <h1>用更聰明的方式<br>記住英文單詞</h1>
      <p class="onboard-lead">WordLab 會依你的記憶曲線安排複習，自動記錄進度，並用測驗幫你檢查成果。先設定一個每日目標吧。</p>

      <div class="onboard-form">
        <div class="field">
          <label for="obName">怎麼稱呼你？（可留空）</label>
          <input id="obName" type="text" maxlength="16" placeholder="例如：小明" autocomplete="nickname">
        </div>
        <div class="field">
          <label>每日學習目標</label>
          <div class="segmented" id="obGoal" role="group" aria-label="每日學習目標">
            <button type="button" data-value="10">10 個</button>
            <button type="button" data-value="20" class="is-on">20 個</button>
            <button type="button" data-value="30">30 個</button>
            <button type="button" data-value="50">50 個</button>
          </div>
        </div>
        <div class="field">
          <label>想從哪個難度開始？</label>
          <div class="segmented" id="obLevel" role="group" aria-label="起始難度">
            <button type="button" data-value="0" class="is-on">全部</button>
            <button type="button" data-value="1">基礎</button>
            <button type="button" data-value="2">中階</button>
            <button type="button" data-value="3">進階</button>
            <button type="button" data-value="4">高階</button>
          </div>
          <p class="hint">選「全部」會由基礎開始，打好底子再往上。</p>
        </div>
        <button class="btn btn-primary btn-lg btn-block" type="button" id="obStart">開始學習 →</button>
      </div>

      <div class="onboard-points">
        <div><span>🧠</span><div><b>間隔重複</b><p>在快要忘記時複習，記得久又省時間。</p></div></div>
        <div><span>📊</span><div><b>進度記錄</b><p>連續天數、掌握度、複習熱力圖一目了然。</p></div></div>
        <div><span>📝</span><div><b>自動出題</b><p>選擇、拼寫、聽力測驗，錯了自動排回複習。</p></div></div>
      </div>
    </div>`;
  }

  /* ==================================================================
     12. 設定面板
     ================================================================== */
  function openSettings() {
    sheetMode = 'settings';
    renderSettingsBody();
    els.settingsOverlay.hidden = false;
    const first = $('#setName');
    if (first) setTimeout(() => first.focus(), 60);
  }
  function closeSettings() {
    els.settingsOverlay.hidden = true;
    if (sheetMode !== 'settings') {
      // 從單詞詳情返回時，恢復設定面板內容
      sheetMode = 'settings';
      renderSettingsBody();
    }
  }

  function renderSettingsBody() {
    const s = state.settings;
    const body = $('#settingsBody');
    if (!body) return;
    $('#settingsTitle').textContent = '設定';
    body.innerHTML = `
      <div class="field">
        <label for="setName">你的名字</label>
        <input id="setName" type="text" maxlength="16" placeholder="學習者" value="${esc(s.name)}" autocomplete="nickname">
      </div>

      <div class="field">
        <label>每日目標（複習 + 新詞）</label>
        <div class="segmented" id="setGoal" role="group" aria-label="每日目標">
          ${[10, 20, 30, 50].map(v => `<button type="button" data-value="${v}" class="${s.dailyGoal === v ? 'is-on' : ''}">${v} 個</button>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>預設測驗模式</label>
        <div class="segmented" id="setQuizMode" role="group" aria-label="預設測驗模式">
          ${[['mixed', '混合'], ['mean', '看詞選義'], ['def', '看義選詞'], ['spell', '拼寫']].map(([v, t]) =>
            `<button type="button" data-value="${v}" class="${s.quizMode === v ? 'is-on' : ''}">${t}</button>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>新單詞難度</label>
        <div class="segmented" id="setLevel" role="group" aria-label="新單詞難度">
          ${[[0, '全部'], [1, '基礎'], [2, '中階'], [3, '進階'], [4, '高階']].map(([v, t]) =>
            `<button type="button" data-value="${v}" class="${Number(s.newWordLevel) === v ? 'is-on' : ''}">${t}</button>`).join('')}
        </div>
        <p class="hint">只影響新學的單詞；已學過的複習不受影響。</p>
      </div>

      <div class="field">
        <label>發音</label>
        <div class="segmented" id="setAccent" role="group" aria-label="發音口音">
          ${[['en-US', '美式'], ['en-GB', '英式']].map(([v, t]) =>
            `<button type="button" data-value="${v}" class="${s.accent === v ? 'is-on' : ''}">${t}</button>`).join('')}
        </div>
        <label class="switch-row">
          <span>顯示單詞時自動發音</span>
          <input type="checkbox" id="setAutoSpeak" class="switch" ${s.autoSpeak ? 'checked' : ''}>
        </label>
        ${speech.supported ? '' : '<p class="hint">此瀏覽器不支援語音合成，發音與聽力測驗將無法使用。</p>'}
      </div>

      <div class="field">
        <label>資料</label>
        <div class="btn-row">
          <button type="button" class="btn btn-ghost" id="exportBtn">匯出進度 (JSON)</button>
          <button type="button" class="btn btn-ghost" id="importBtn">匯入進度</button>
          <input type="file" id="importFile" accept="application/json,.json" hidden>
        </div>
        <button type="button" class="btn btn-danger-ghost" id="resetBtn">重設所有學習進度</button>
        <p class="hint">匯出後可備份到雲端；換裝置或瀏覽器時匯入即可繼續。</p>
      </div>

      <dl class="meta-info">
        <div><dt>單詞總數</dt><dd>${WORDS.length}</dd></div>
        <div><dt>程式版本</dt><dd>v${APP_VERSION}</dd></div>
      </dl>`;
  }

  /* ==================================================================
     13. 渲染與事件
     ================================================================== */
  function render() {
    currentRoute = parseHash();
    renderChrome();
    if (!els.view) return;

    if (currentRoute === 'learn') els.view.innerHTML = viewLearn();
    else if (currentRoute === 'quiz') els.view.innerHTML = viewQuiz();
    else if (currentRoute === 'stats') els.view.innerHTML = viewStats();
    else if (currentRoute === 'library') els.view.innerHTML = viewLibrary();

    els.view.classList.remove('is-in');
    void els.view.offsetWidth;
    els.view.classList.add('is-in');
    bindViewEvents();
    if (currentRoute === 'quiz' && ui.quiz) {
      if (!ui.quiz.done && !ui.quiz.answered) {
        focusQuizInput();
        if (!ui.quiz.played) {
          ui.quiz.played = true;
          setTimeout(() => maybeSpeakQuestion(), 250);
        }
      }
    }
  }

  /** 只重繪指示區塊（作答後避免整頁重繪失去焦點） */
  function renderIntoView() {
    if (!els.view) return;
    if (currentRoute === 'learn') els.view.innerHTML = viewLearn();
    else if (currentRoute === 'quiz') els.view.innerHTML = viewQuiz();
    bindViewEvents();
  }

  function bindViewEvents() {
    const root = els.view;
    if (!root) return;

    // 發音按鈕由全域委派處理（見下方 document click）

    // --- 引導頁 ---
    const obStart = $('#obStart', root);
    if (obStart) {
      obStart.addEventListener('click', () => {
        const name = ($('#obName', root) || {}).value || '';
        state.settings.name = name.trim().slice(0, 16);
        state.onboarded = true;
        saveState();
        startStudySession(true);
        render();
      });
      const obName = $('#obName', root);
      if (obName) obName.addEventListener('keydown', e => { if (e.key === 'Enter') obStart.click(); });
      $$('#obGoal button', root).forEach(btn => {
        btn.addEventListener('click', () => {
          $$('#obGoal button', root).forEach(b => b.classList.toggle('is-on', b === btn));
          state.settings.dailyGoal = clamp(Number(btn.dataset.value) || 20, 5, 100);
          saveState();
        });
      });
      $$('#obLevel button', root).forEach(btn => {
        btn.addEventListener('click', () => {
          $$('#obLevel button', root).forEach(b => b.classList.toggle('is-on', b === btn));
          state.settings.newWordLevel = Number(btn.dataset.value) || 0;
          saveState();
        });
      });
    }

    // --- 學習頁 ---
    const revealBtn = $('#revealBtn', root);
    if (revealBtn) {
      revealBtn.addEventListener('click', () => {
        ui.reveal = true;
        render();
        const w = currentStudyWord();
        if (w && state.settings.autoSpeak) speech.speak(w.word, state.settings.accent);
      });
    }
    $$('.rate-btn', root).forEach(btn => {
      btn.addEventListener('click', () => rateCurrent(Number(btn.dataset.rating)));
    });
    const nextRoundBtn = $('#nextRoundBtn', root);
    if (nextRoundBtn) {
      nextRoundBtn.addEventListener('click', () => {
        startStudySession(true);
        render();
      });
    }
    const onlyDueBtn = $('#onlyDueBtn', root);
    if (onlyDueBtn) {
      onlyDueBtn.addEventListener('click', () => {
        const dueIds = dueWords().map(x => x.id);
        if (!dueIds.length) { toast('目前沒有到期的單詞'); return; }
        ui.queue = dueIds;
        ui.queueTotal = dueIds.length;
        ui.queueIndex = 0;
        ui.reveal = false;
        ui.done = false;
        ui.sessionRatings = { again: 0, good: 0, easy: 0 };
        render();
        toast(`本輪只複習 ${dueIds.length} 個到期單詞`);
      });
    }
    const doneQuizBtn = $('#doneQuizBtn', root);
    if (doneQuizBtn) doneQuizBtn.addEventListener('click', () => go('quiz'));
    const doneStatsBtn = $('#doneStatsBtn', root);
    if (doneStatsBtn) doneStatsBtn.addEventListener('click', () => go('stats'));

    // --- 測驗設定 ---
    $$('[data-mode]', root).forEach(btn => {
      btn.addEventListener('click', () => {
        $$('[data-mode]', root).forEach(b => b.classList.toggle('is-on', b === btn));
        state.settings.quizMode = btn.dataset.mode;
        saveState();
      });
    });
    $$('#quizCount button', root).forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#quizCount button', root).forEach(b => b.classList.toggle('is-on', b === btn));
      });
    });
    const startQuizBtn = $('#startQuizBtn', root);
    if (startQuizBtn) {
      startQuizBtn.addEventListener('click', () => {
        const mode = state.settings.quizMode;
        const countBtn = $('#quizCount button.is-on', root);
        const count = Number(countBtn ? countBtn.dataset.count : 10);
        if (mode === 'listen' && !speech.supported) {
          toast('此瀏覽器不支援語音，已改用看詞選義');
        }
        ui.quiz = newQuizState(mode, count);
        if (mode === 'spell') setTimeout(focusQuizInput, 50);
        render();
      });
    }

    // --- 測驗作答 ---
    $$('.option', root).forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        answerQuestion(idx);
      });
    });
    const spellSubmit = $('#spellSubmit', root);
    if (spellSubmit) spellSubmit.addEventListener('click', submitSpell);
    const spellInput = $('#spellInput', root);
    if (spellInput) {
      spellInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); submitSpell(); }
      });
    }
    const hintBtn = $('#hintBtn', root);
    if (hintBtn) {
      hintBtn.addEventListener('click', () => {
        const q = ui.quiz;
        if (!q || !q.questions) return;
        const question = q.questions[q.index];
        question.hintUsed = true;
        if (!q.revealed) {
          q.revealed = true;
          renderIntoView();
          const el = $('#spellInput');
          if (el) el.focus();
        }
      });
    }
    const nextQBtn = $('#nextQBtn', root);
    if (nextQBtn) nextQBtn.addEventListener('click', nextQuestion);
    const listenBtn = $('#listenBtn', root);
    if (listenBtn) listenBtn.addEventListener('click', () => maybeSpeakQuestion(true));

    // --- 測驗結果 ---
    const retryQuizBtn = $('#retryQuizBtn', root);
    if (retryQuizBtn) {
      retryQuizBtn.addEventListener('click', () => {
        const mode = state.settings.quizMode;
        const last = ui.quiz;
        const count = last ? last.questions.length : 10;
        ui.quiz = newQuizState(mode, count);
        render();
      });
    }
    const newQuizBtn = $('#newQuizBtn', root);
    if (newQuizBtn) {
      newQuizBtn.addEventListener('click', () => {
        ui.quiz = null;
        render();
      });
    }
    const summaryLearnBtn = $('#summaryLearnBtn', root);
    if (summaryLearnBtn) summaryLearnBtn.addEventListener('click', () => go('learn'));

    // --- 單詞庫 ---
    const libSearch = $('#libSearch', root);
    if (libSearch) {
      libSearch.addEventListener('input', () => {
        ui.libQuery = libSearch.value;
        ui.libLimit = 60;
        const list = libraryList();
        renderLibraryList(list);
      });
    }
    $$('#libFilters .chip', root).forEach(chip => {
      chip.addEventListener('click', () => {
        ui.libFilter = chip.dataset.filter;
        ui.libLimit = 60;
        render();
      });
    });
    $$('[data-lib-open]', root).forEach(btn => {
      btn.addEventListener('click', () => openWordSheet(btn.dataset.libOpen));
    });
    const libMore = $('#libMore', root);
    if (libMore) {
      libMore.addEventListener('click', () => {
        ui.libLimit += 80;
        render();
      });
    }
  }

  function renderLibraryList(list) {
    // 搜尋時只更新列表與計數，避免輸入框失焦
    const shown = list.slice(0, ui.libLimit);
    const container = $('.lib-list');
    if (!container) return;
    const countEl = $('.lib-count');
    if (countEl) countEl.textContent = `顯示 ${shown.length} / ${list.length} 個`;
    container.innerHTML = (shown.length
      ? shown.map(w => renderLibraryRow(w)).join('')
      : '<p class="empty-note">沒有符合條件的單詞。</p>')
      + (list.length > shown.length
        ? `<div class="load-more"><button class="btn btn-ghost" type="button" id="libMore">載入更多（還有 ${list.length - shown.length} 個）</button></div>`
        : '');

    $$('[data-lib-open]', container).forEach(btn => {
      btn.addEventListener('click', () => openWordSheet(btn.dataset.libOpen));
    });
    const more = $('#libMore', container);
    if (more) {
      more.addEventListener('click', () => {
        ui.libLimit += 80;
        render();
      });
    }
  }

  function maybeSpeakQuestion(force) {
    const q = ui.quiz;
    if (!q || q.done) return;
    const question = q.questions[q.index];
    if (!question) return;
    if (question.type === 'listen' || force) speech.speak(question.word.word, state.settings.accent);
  }

  /** 為目前卡片評分並前進 */
  function rateCurrent(rating) {
    const w = currentStudyWord();
    if (!w) return;
    applyReview(w.id, rating, 'study');
    if (rating === 2) ui.sessionRatings.again += 1;
    else if (rating === 4) ui.sessionRatings.good += 1;
    else ui.sessionRatings.easy += 1;

    ui.queueIndex += 1;
    ui.reveal = false;
    if (ui.queueIndex >= ui.queue.length || ui.queueIndex >= ui.queueTotal) {
      ui.done = true;
    }
    render();
    // 自動發音
    const next = currentStudyWord();
    if (next && state.settings.autoSpeak && !ui.done) {
      speech.speak(next.word, state.settings.accent);
    }
  }

  /* ==================================================================
     14. 全域事件
     ================================================================== */
  // 數字鍵評分、Space 翻卡、A-D 選項、Enter 下一題
  document.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
      return; // 輸入框中不攔截
    }
    if (currentRoute === 'learn' && !ui.done && els.view && $('#flashcard')) {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!ui.reveal) {
          ui.reveal = true;
          render();
          const w = currentStudyWord();
          if (w && state.settings.autoSpeak) speech.speak(w.word, state.settings.accent);
        }
        return;
      }
      if (ui.reveal) {
        if (e.key === '1') { e.preventDefault(); rateCurrent(2); return; }
        if (e.key === '2') { e.preventDefault(); rateCurrent(4); return; }
        if (e.key === '3') { e.preventDefault(); rateCurrent(5); return; }
      }
    }

    if (currentRoute === 'quiz' && ui.quiz && !ui.quiz.done) {
      if (ui.quiz.answered && (e.key === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        nextQuestion();
        return;
      }
      if (!ui.quiz.answered) {
        const q = ui.quiz.questions[ui.quiz.index];
        if (q && q.options) {
          const idx = 'abcd'.indexOf(e.key.toLowerCase());
          if (idx >= 0 && idx < q.options.length) {
            e.preventDefault();
            answerQuestion(idx);
          }
        }
      }
    }
  });

  // 發音按鈕（全域委派：學習卡、單詞庫、測驗結果、單詞詳情都適用）
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-word]');
    if (!t) return;
    e.preventDefault();
    const ok = speech.speak(t.dataset.word, state.settings.accent);
    if (!ok) toast('此瀏覽器不支援語音合成，可改用 Chrome / Edge');
  });

  // 設定面板
  if (els.settingsBtn) els.settingsBtn.addEventListener('click', openSettings);
  if (els.settingsClose) els.settingsClose.addEventListener('click', closeSettings);
  if (els.settingsOverlay) {
    els.settingsOverlay.addEventListener('click', (e) => {
      if (e.target === els.settingsOverlay) closeSettings();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.settingsOverlay && !els.settingsOverlay.hidden) closeSettings();
  });
  if (els.brand) {
    els.brand.addEventListener('click', (e) => {
      e.preventDefault();
      go('learn');
      startStudySession(false);
      render();
    });
  }

  // 設定面板內的互動（事件委派）
  document.addEventListener('click', (e) => {
    const target = e.target;

    // 名字輸入
    if (target && target.id === 'setName') return;
    if (target && target.id === 'setGoal') return;

    // 分段控制
    const segBtn = target.closest('.segmented button');
    if (segBtn && els.settingsOverlay && !els.settingsOverlay.hidden) {
      const group = segBtn.parentElement;
      if (group.id === 'setGoal') {
        state.settings.dailyGoal = clamp(Number(segBtn.dataset.value) || 20, 5, 100);
      } else if (group.id === 'setQuizMode') {
        state.settings.quizMode = segBtn.dataset.value;
      } else if (group.id === 'setLevel') {
        state.settings.newWordLevel = Number(segBtn.dataset.value) || 0;
      } else if (group.id === 'setAccent') {
        state.settings.accent = segBtn.dataset.value;
        speech.speak('Hello, this is your pronunciation.', state.settings.accent);
      }
      saveState();
      $$('button', group).forEach(b => b.classList.toggle('is-on', b === segBtn));
      return;
    }

    if (target.closest('#exportBtn')) { exportData(); return; }
    if (target.closest('#importBtn')) {
      const file = $('#importFile');
      if (file) file.click();
      return;
    }
    if (target.closest('#resetBtn')) { resetAll(); return; }
  });

  // 名字輸入即時保存
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'setName') {
      state.settings.name = e.target.value.slice(0, 16);
      saveState();
      renderChrome();
    }
    if (e.target && e.target.id === 'setAutoSpeak') {
      state.settings.autoSpeak = e.target.checked;
      saveState();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'setAutoSpeak') {
      state.settings.autoSpeak = e.target.checked;
      saveState();
    }
    if (e.target && e.target.id === 'importFile') {
      handleImport(e.target.files && e.target.files[0]);
      e.target.value = '';
    }
  });

  /* ---------- 資料匯出 / 匯入 / 重設 ---------- */
  function exportData() {
    const payload = {
      app: 'WordLab',
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      data: state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wordlab-progress-${dateKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('✅ 已匯出學習進度');
  }

  function handleImport(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const data = parsed && parsed.data ? parsed.data : parsed;
        if (!data || typeof data !== 'object' || !data.progress) {
          toast('❌ 檔案格式不正確');
          return;
        }
        if (!window.confirm('匯入會覆蓋目前的學習進度，確定嗎？')) return;
        state = loadStateFromObject(data);
        saveState();
        ui.queue = [];
        ui.quiz = null;
        startStudySession(true);
        closeSettings();
        render();
        toast('✅ 進度已匯入');
      } catch (err) {
        console.error(err);
        toast('❌ 無法讀取這個檔案');
      }
    };
    reader.onerror = () => toast('❌ 讀取檔案失敗');
    reader.readAsText(file);
  }

  function loadStateFromObject(parsed) {
    const base = defaultState();
    const merged = Object.assign(base, parsed);
    merged.settings = Object.assign(defaultState().settings, parsed.settings || {});
    merged.stats = Object.assign(defaultState().stats, parsed.stats || {});
    if (!merged.progress || typeof merged.progress !== 'object') merged.progress = {};
    if (!merged.days || typeof merged.days !== 'object') merged.days = {};
    if (!Array.isArray(merged.stats.sessions)) merged.stats.sessions = [];
    Object.keys(merged.progress).forEach(id => { if (!WORD_BY_ID.has(id)) delete merged.progress[id]; });
    return merged;
  }

  function resetAll() {
    if (!window.confirm('確定要重設所有學習進度嗎？此動作無法復原（建議先匯出備份）。')) return;
    state = defaultState();
    saveState();
    ui.queue = [];
    ui.quiz = null;
    ui.done = true;
    closeSettings();
    startStudySession(true);
    render();
    toast('已重設，重新開始吧！');
  }

  /* ==================================================================
     15. 啟動
     ================================================================== */
  // 開發用測試接點（僅供離線測試腳本呼叫，不影響一般使用）
  window.__WORDLAB__ = {
    getState: () => state,
    setState: (next) => { state = loadStateFromObject(next); },
    words: WORDS,
    buildQueue,
    dueWords,
    newWordsPool,
    previewIntervals,
    applyReview,
    scheduleProgress,
    makeQuestion,
    quizPool,
    dateKey,
    streakDays,
    storageKey: STORAGE_KEY,
  };

  function boot() {
    if (!WORDS.length) {
      els.view.innerHTML = '<div class="empty"><strong>找不到單詞資料</strong>請確認 data/words.js 是否正確載入。</div>';
      return;
    }
    currentRoute = parseHash();
    if (!location.hash) location.hash = '#/learn';
    if (currentRoute === 'learn') startStudySession(true);
    render();
    // 首次載入提示
    if (!localStorage.getItem(STORAGE_KEY + '.welcomed')) {
      localStorage.setItem(STORAGE_KEY + '.welcomed', '1');
    }
  }

  boot();
})();
