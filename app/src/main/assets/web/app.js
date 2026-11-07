"use strict";
/* 书边译：界面和交互来自 prototype/index.html，数据和系统能力由原生 window.Native 提供。 */
const N = window.Native;
const params = new URLSearchParams(location.search);
const CARD = params.get("mode") === "card";
const kv = {
  get(k, d) { try { const v = N.kvGet(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { N.kvSet(k, JSON.stringify(v)); }
};
const handlers = {};
window.onNative = (type, data) => { const h = handlers[type]; if (h) h(data); };

const DEFAULT_LEVEL = "Chinese native speaker reading English novels; passed CET-6 (about 6000 English words); comfortable with everyday and news vocabulary, weak on literary, archaic and nautical words.";
const settings = Object.assign({ level: DEFAULT_LEVEL, volume: false, uitheme: "system", excerptRatio: "34" }, kv.get("settings", {}));
const RS = kv.get("reader", {});

/* ===================== 状态 ===================== */
const st = {
  screen: "outer", k: 1, tab: "physical", filter: "all", book: null, busy: false, kb: false,
  theme: RS.theme || "original", font: RS.font || "literata", size: RS.size || 18, turn: RS.turn || "curl", spread: RS.spread !== false,
  lh: RS.lh || "m", margin: RS.margin || "m", justify: RS.justify !== false, pub: RS.pub !== false,
  words: "all", query: "", pick: null, pickSrc: null, more: false, scan: null
};
const saved = new Map(kv.get("saved", []));      // lemma → { src, type, t, book, pos, sentence, sense, word }
const savedPhrases = new Map(kv.get("savedPhrases", []));
const savedQuotes = new Map(kv.get("savedQuotes", []));
const recents = kv.get("recents", []);
const known = new Set(kv.get("known", []));
const bookmarks = kv.get("bookmarks", {});        // bookId → [{ ch, off }]
const prog = kv.get("prog", {});                  // bookId → { ch, off, progress, status, opened }
let activeTarget = null;
let BOOKS = CARD ? [] : JSON.parse(N.books());
const saveSaved = () => kv.set("saved", [...saved]);
const saveProg = () => kv.set("prog", prog);
const saveReaderPrefs = () => kv.set("reader", { theme: st.theme, font: st.font, size: st.size, turn: st.turn, spread: st.spread, lh: st.lh, margin: st.margin, justify: st.justify, pub: st.pub });
const LH = { s: 1.45, m: 1.62, l: 1.8 };
function applyTypo(r) {
  r.style.setProperty("--r-size", st.size + "px");
  r.style.setProperty("--r-lh", LH[st.lh]);
  r.style.setProperty("--r-align", st.justify ? "justify" : "start");
  r.style.setProperty("--r-hyph", st.justify ? "auto" : "manual");
  r.dataset.pub = st.pub ? "1" : "0";
}
const progOf = id => prog[id] || (prog[id] = { ch: 0, off: 0, progress: 0, status: "new" });

/* ===================== 工具 ===================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const darkUI = () => settings.uitheme === "dark" || (settings.uitheme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
const applyUITheme = () => { document.documentElement.dataset.theme = settings.uitheme === "system" ? "" : settings.uitheme; };
applyUITheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { applyUITheme(); if (!R) N.bars(true, !darkUI()); });
const dims = () => [innerWidth, innerHeight];
const qid = w => w.replace(/[^a-z0-9]/g, "_");
const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const I = {
  lib: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3.5" y="4" width="4.5" height="16" rx="1"/><rect x="9.5" y="4" width="4.5" height="16" rx="1"/><path d="M16 5.2l3.9-1 2.6 15.7-3.9 1z"/></svg>',
  kb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5.5h5.6c.9 0 1.7.4 2.4 1.1.7-.7 1.5-1.1 2.4-1.1H20v12.4h-5.6c-.9 0-1.7.4-2.4 1.1-.7-.7-1.5-1.1-2.4-1.1H4z"/><path d="M12 6.6v12.4"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 3.9v4.6h-4.6"/></svg>',
  words: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 3.5h12a1 1 0 0 1 1 1v16l-7-4-7 4v-16a1 1 0 0 1 1-1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h9"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".6" fill="currentColor"/><circle cx="4.5" cy="12" r=".6" fill="currentColor"/><circle cx="4.5" cy="18" r=".6" fill="currentColor"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>',
  aa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18l5-12 5 12M4.8 14h6.4M15 18l3-7.5 3 7.5M15.9 16h4.2"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3.5H3.5V9M15 3.5h5.5V9M9 20.5H3.5V15M15 20.5h5.5V15"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5a7.8 7.8 0 1 1 2.2 6.1"/><path d="M4.2 4.8v5.9h5.9"/></svg>',
  shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9H9V3.5M20.5 9H15V3.5M3.5 15H9v5.5M20.5 15H15v5.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.7-5 2.7.9-5.6-4-3.9 5.6-.8z"/></svg>',
  starOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.7-5 2.7.9-5.6-4-3.9 5.6-.8z"/></svg>',
  bm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 3.5h10v17l-5-3.5-5 3.5z"/></svg>',
  bmOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 3.5h10v17l-5-3.5-5 3.5z"/></svg>',
  speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8h3l1.6-2.5h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 16l5-5 4 4 2.5-2.5 5 5"/><circle cx="15.5" cy="9" r="1.4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></svg>'
};

/* ===================== 词典 ===================== */
const infoCache = new Map();
function parseTrans(t) {
  const seen = new Set(), out = [];
  for (let line of t.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("[网络]")) continue;
    let pos = "", m;
    if ((m = line.match(/^([a-z]+\.)\s*(.*)$/))) { pos = m[1]; line = m[2]; }
    else if ((m = line.match(/^(\[[^\]]+\])\s*(.*)$/))) { pos = m[1]; line = m[2]; }
    line = line.replace(/,\s*/g, "，").replace(/;\s*/g, "；");
    if (!line || seen.has(pos + line)) continue;
    seen.add(pos + line); out.push([pos, line]);
  }
  return out;
}
function lookupWord(raw) {
  const key = String(raw).toLowerCase();
  if (infoCache.has(key)) return infoCache.get(key);
  const o = JSON.parse(N.lookup(raw));
  const info = { word: o.word, lemma: o.lemma, form: o.form || null, phonetic: o.phonetic || "", found: !!o.found,
    lines: o.found ? parseTrans((o.own ? o.own + "\n" : "") + o.trans) : [] };
  infoCache.set(key, info);
  return info;
}
// Jev choice 题的选项：把每行释义按逗号、分号拆开，去重，最多 12 个
function senseItems(info) {
  const out = [], seen = new Set();
  info.lines.forEach(([, l], i) => l.split(/[，；]/).forEach(s => {
    s = s.replace(/〈[^〉]*〉/g, "").trim();
    if (s && !seen.has(s) && out.length < 12) { seen.add(s); out.push([s, i]); }
  }));
  return out;
}
function senseOf(lemma) { const i = lookupWord(lemma); return i.lines[0] ? i.lines[0][1] : ""; }
function speak(t) { N.speak(t); }

/* ---------- Jev ---------- */
let jevSeq = 0;
const jevWait = {};
handlers.jev = d => {
  const w = jevWait[d.id]; if (!w) return; delete jevWait[d.id];
  const status = +d.status;
  if (status !== 200) { w.rej(new Error(status ? "Jev 返回 " + status : "网络不可用")); return; }
  try { w.res(JSON.parse(d.body).answers || {}); } catch (e) { w.rej(e); }
};
function jevAsk(passage, questions) {
  return new Promise((res, rej) => {
    const id = ++jevSeq; jevWait[id] = { res, rej };
    N.jev(id, JSON.stringify({ model: "jev-latest", state: { reader: settings.level, passage }, questions }));
  });
}
const NOUL = {
  question: "Would this reader need to look up this word to understand it as used in the passage?",
  criteria: { true: "The reader probably does not know this word, or does not know the sense it has in this passage.", false: "The reader already knows this word in the sense used here." }
};
function senseQuestion(word, items) {
  return { type: "choice", instructions: `Which sense does '${word}' have in this passage?`, criteria: Object.fromEntries(items.map(([s]) => [s, null])) };
}

/* ---------- 整句翻译、问 AI ---------- */
let trSeq = 0;
const trWait = {};
handlers.tr = d => { const f = trWait[d.id]; if (f) f(d); if (d.done || d.error) delete trWait[d.id]; };
const trCache = new Map();
function streamTr(text, ask, target) {
  if (!ask && trCache.has(text)) { target.textContent = trCache.get(text); return; }
  const id = ++trSeq; let out = "";
  target.textContent = "…";
  trWait[id] = d => {
    if (d.delta) { out += d.delta; target.textContent = out; }
    if (d.done && !ask) trCache.set(text, out);
    if (d.error) target.textContent = out || d.error;
  };
  N.translate(id, text, ask);
}
// 书名和所在段落给模型理解指代和语境，只翻 <text> 里的部分
function translateText(text, target, ctx) {
  const title = st.book ? `书名：《${st.book.title}》\n` : "";
  const c = ctx && ctx.length > text.length + 20 && ctx.length < 1500 ? `<context>${ctx}</context>\n` : "";
  streamTr(`${title}${c}<text>${text}</text>`, false, target);
}

/* ===================== 外壳 ===================== */
const scr = $("#scr");
scr.innerHTML = CARD ? `
  <div class="scrim" id="scrim"></div>
  <div class="sheet" id="sheet" role="dialog"></div>
  <div class="toast" id="toast"></div>` : `
  <div class="app">
    <nav class="nav" aria-label="主导航">
      <div class="brand">书边译</div>
      <button data-tab="physical" aria-current="true">${I.search}<span>查单词</span></button>
      <button data-tab="library" aria-current="false">${I.lib}<span>书库</span></button>
      <button data-tab="kb" aria-current="false">${I.kb}<span>课程</span></button>
      <button data-tab="words" aria-current="false">${I.words}<span>生词本</span></button>
      <button class="gear" data-act="settings">${I.gear}<span>设置</span></button>
    </nav>
    <div class="views">
      <section class="view v-physical home" id="v-physical"></section>
      <section class="view v-library" id="v-library" hidden></section>
      <section class="view v-kb" id="v-kb" hidden></section>
      <section class="view v-words" id="v-words" hidden></section>
    </div>
  </div>
  <div class="scrim" id="scrim"></div>
  <div class="sheet" id="sheet" role="dialog"></div>
  <div class="cam" id="cam"></div>
  <div class="toast" id="toast"></div>`;
const scrim = $("#scrim"), sheet = $("#sheet"), toastEl = $("#toast"), cam = $("#cam");

window.setInsets = (t, b, l, r, kb) => {
  const s = document.documentElement.style;
  s.setProperty("--sat", t + "px"); s.setProperty("--sab", b + "px"); s.setProperty("--sal", l + "px"); s.setProperty("--sar", r + "px");
  st.kb = kb; scr.classList.toggle("kb", kb);
};
const sat = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sat")) || 28;

function fit() {
  st.screen = innerWidth >= 600 ? "inner" : "outer";
  scr.classList.toggle("outer", st.screen === "outer"); scr.classList.toggle("inner", st.screen === "inner");
}
function spreadAvailable() { return st.screen === "inner" && innerWidth > innerHeight; }

let toastT;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("on"), 1600); }
handlers.toast = toast;

/* ---------- 底部卡片 ---------- */
let sheetClose = null;
function openSheet(html, cls = "", onClose = null) {
  sheet.className = "sheet " + cls; sheet.innerHTML = `<div class="grab"></div>${html}`;
  scrim.classList.add("on");
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add("on")));
  sheetClose = onClose;
}
function closeSheet() {
  if (!sheet.classList.contains("on")) return;
  sheet.classList.remove("on"); scrim.classList.remove("on");
  if (document.activeElement?.closest?.("#sheet")) { document.activeElement.blur(); if (st.kb) N.keyboard(false); }
  if (sheetClose) { const f = sheetClose; sheetClose = null; f(); }
}
scrim.addEventListener("click", closeSheet);
// 下拉关闭
(() => {
  let y0 = null, dy = 0;
  sheet.addEventListener("pointerdown", e => {
    const body = e.target.closest(".sh-body");
    if (e.target.closest("input, textarea, button") || (body && body.scrollTop > 0)) return;
    y0 = e.clientY; dy = 0;
  });
  sheet.addEventListener("pointermove", e => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    if (dy > 6) { sheet.style.transition = "none"; sheet.style.transform = `translateY(${dy}px)`; }
  });
  const end = () => {
    if (y0 == null) return; y0 = null;
    sheet.style.transition = ""; sheet.style.transform = "";
    if (dy > 90) closeSheet();
  };
  sheet.addEventListener("pointerup", end); sheet.addEventListener("pointercancel", end);
})();

/* ---------- 标签切换 ---------- */
function setTab(tab, focus = true) {
  if (st.tab === "kb" && tab !== "kb") kbLeaveRead();
  st.tab = tab; st.pick = null;
  $$(".nav button[data-tab]").forEach(b => b.setAttribute("aria-current", b.dataset.tab === tab));
  $$(".view").forEach(v => { const on = v.id === "v-" + tab; v.hidden = !on; if (on) { v.classList.remove("enter"); void v.offsetWidth; v.classList.add("enter"); } });
  render(tab);
  // 不自动聚焦搜索框：进入查单词页只展示界面，键盘由用户点输入框再弹
  if (st.kb) N.keyboard(false);
}
function render(tab) { ({ library: renderLibrary, physical: renderPhysical, kb: renderKb, words: renderWords })[tab](); }
if (!CARD) {
  $(".nav").addEventListener("click", e => {
    const b = e.target.closest("button[data-tab]"); if (b) { setTab(b.dataset.tab); return; }
    if (e.target.closest('[data-act="settings"]')) openSettings();
  });
}
handlers.tab = t => { if (!st.book && !cam.classList.contains("on")) setTab(t, t === "physical"); };

/* ===================== 书库 ===================== */
const PALETTES = [
  ["#113264", "#0090ff", "#fbfdff", "waves"], ["#fef7f9", "#e93d82", "#621639", "frame"], ["#203c25", "#46a758", "#f6fbf6", "lines"],
  ["#f2f0e7", "#978365", "#3b352b", "sun"], ["#64172b", "#e54666", "#fff7f8", "diamond"], ["#53195d", "#ab4aba", "#fdf7fd", "lines"],
  ["#ffc53d", "#f76b15", "#4f3422", "rays"], ["#0d3d38", "#12a594", "#f3fbf9", "waves"]
];
function coverHTML(b) {
  if (b.cover) return `<div class="cover"><img src="${esc(b.cover)}" alt="" decoding="async"></div>`;
  const [c1, c2, cf, motif] = PALETTES[parseInt(hash(b.title + b.author), 36) % PALETTES.length];
  return `<div class="cover" style="--c1:${c1};--c2:${c2};--cf:${cf}"><div class="m m-${motif}"></div><div class="cv-t">${esc(b.title)}</div><div class="cv-a">${esc(b.author)}</div></div>`;
}
function renderLibrary() {
  const v = $("#v-library");
  const stat = b => progOf(b.id).status;
  const cur = BOOKS.filter(b => stat(b) === "reading").sort((a, b) => (progOf(b.id).opened || 0) - (progOf(a.id).opened || 0))[0];
  const list = BOOKS.filter(b => st.filter === "all" || (st.filter === "reading" ? stat(b) !== "done" : stat(b) === "done"));
  const meta = b => b.importing ? '<span class="ring"></span>' : stat(b) === "new" ? '<span class="badge">新</span>' : stat(b) === "done" ? "读完" : Math.round(progOf(b.id).progress * 100) + "%";
  v.innerHTML = `
    <div class="lg-head"><h2>书库</h2><button class="circle" data-act="import" aria-label="导入 ePub">${I.plus}</button></div>
    ${cur ? `<button class="cont" data-open="${cur.id}">
      <div class="cv-w">${coverHTML(cur)}</div>
      <div class="info"><span class="k">继续阅读</span><span class="t">${esc(cur.title)}</span><span class="a">${esc(cur.author)}</span>
        <div class="bar"><i style="width:${Math.max(3, progOf(cur.id).progress * 100)}%"></i></div></div>
    </button>` : ""}
    ${BOOKS.length ? `<div class="sec-t">全部图书</div>
    <div class="chips">${[["all", "全部"], ["reading", "在读"], ["done", "读完"]].map(([k, t]) => `<button data-filter="${k}" aria-pressed="${st.filter === k}">${t}</button>`).join("")}</div>
    <div class="grid">${list.map(b => `<button class="book${b.importing ? " importing" : ""}" data-open="${b.id}"><div class="cv-w">${coverHTML(b)}</div><div class="meta">${meta(b)}</div></button>`).join("")}</div>`
    : '<div class="lib-empty">点右上角的 + 导入 ePub</div>'}`;
}
if (!CARD) {
  const lib = $("#v-library");
  let pressT = null, longed = false;
  lib.addEventListener("pointerdown", e => {
    const b = e.target.closest(".book"); longed = false; if (!b) return;
    pressT = setTimeout(() => { longed = true; bookMenu(b.dataset.open); }, 500);
  });
  const cancel = () => clearTimeout(pressT);
  lib.addEventListener("pointerup", cancel); lib.addEventListener("pointercancel", cancel);
  lib.addEventListener("pointermove", cancel);
  lib.addEventListener("contextmenu", e => e.preventDefault());
  lib.addEventListener("click", e => {
    if (longed) { longed = false; return; }
    const f = e.target.closest("[data-filter]"); if (f) { st.filter = f.dataset.filter; renderLibrary(); return; }
    if (e.target.closest('[data-act="import"]')) { N.importBooks(); return; }
    const o = e.target.closest("[data-open]"); if (o && !o.classList.contains("importing")) openBook(o.dataset.open, o.querySelector(".cover"));
  });
}
function bookMenu(id) {
  const b = BOOKS.find(x => x.id === id); if (!b) return;
  const done = progOf(id).status === "done";
  openSheet(`<div class="sh-head"><h3>${esc(b.title)}</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
    <div class="sh-body flush"><ul class="actlist"><li><button data-bk="toggle">${done ? "标为未读" : "标为读完"}</button></li><li><button class="danger" data-bk="delete">删除</button></li></ul></div>`);
  sheet.dataset.book = id;
}
handlers.import = d => {
  if (d.state === "error") { toast(d.msg); return; }
  const b = Object.assign(d.book, { importing: true });
  BOOKS = [b, ...BOOKS.filter(x => x.id !== b.id)];
  st.filter = "all";
  if (st.tab !== "library") setTab("library", false); else renderLibrary();
  $("#v-library").scrollTo({ top: 0, behavior: "smooth" });
  setTimeout(() => { b.importing = false; if (st.tab === "library" && !st.book) renderLibrary(); toast(`已导入《${b.title}》`); }, reduced ? 0 : 1100);
};

/* ===================== 课程 / 知识库 =====================
   数据来自原生桥（N.kbIndex / N.kbSync / N.kbStats）和本地 /kb/ 路由，契约见
   docs/notion-kb-contract.md。状态放在独立的 KB 对象里（st.kb 是键盘标志，别混）。 */
const KB = {
  view: "courses", course: null, article: null, index: null,
  status: "idle", lastSync: 0, errMsg: "", syncDone: 0, syncTotal: 0,
  prog: kv.get("kbprog", {}) || {}, seen: kv.get("kbseen", {}) || {},
  autoTried: false, mounted: "", fetched: {}, scroll: {}, userScrolled: false,
  full: false, chrome: true, lastY: 0, acc: 0, idleT: 0, suppress: false, barsOn: null,
  ratio: 0, ratioT: 0, lastViewport: ""
};
const KB_STALE = 6 * 3600e3;
const kbSave = () => { kv.set("kbprog", KB.prog); kv.set("kbseen", KB.seen); kv.set("kblast", KB.lastSync); };
function kbParseIndex(raw) {
  if (!raw) return null;
  try { const o = typeof raw === "string" ? JSON.parse(raw) : raw; return o && o.courses ? o : null; } catch (e) { return null; }
}
function kbLoadIndex() {
  try { if (typeof N.kbIndex === "function") KB.index = kbParseIndex(N.kbIndex()) || KB.index; } catch (e) { /* 旧版原生没有桥 */ }
  if (!KB.lastSync) KB.lastSync = kv.get("kblast", 0) || 0;
}
function kbCourses() { return (KB.index && KB.index.courses) || []; }
function kbCourseById(id) { return kbCourses().find(c => c.id === id) || null; }
function kbArticles(c) { return (c && c.articles) || []; }
function kbAll() { const out = []; kbCourses().forEach(c => kbArticles(c).forEach(a => out.push({ c, a }))); return out; }
function kbFind(articleId) { return kbAll().find(x => x.a.id === articleId) || null; }
function kbIsSeen(a) { return !!a && KB.seen[a.id] != null; }
function kbIsNew(a) { return !!a && KB.seen[a.id] !== (a.updated || ""); }
function kbPct(a) { const p = KB.prog[a.id]; return p && p.pct > 0 ? Math.min(100, Math.round(p.pct * 100)) : 0; }
function kbReadMin(a) { return a && a.read_min ? a.read_min : Math.max(1, Math.ceil(((a && a.words) || 0) / 450)); }
function kbCourseProgress(c) {
  const list = kbArticles(c);
  return [list.filter(a => kbIsSeen(a)).length, list.length];
}
function kbLastRead() {
  let best = null;
  Object.keys(KB.prog).forEach(id => {
    const x = kbFind(id); if (!x || !KB.prog[id] || !KB.prog[id].at) return;
    if (!best || KB.prog[id].at > best.at) best = { ...x, at: KB.prog[id].at };
  });
  return best || (kbAll()[0] || null);
}
function kbNeedsSync() { return !KB.index || !KB.lastSync || Date.now() - KB.lastSync > KB_STALE; }

/* ---------- 同步 ---------- */
function kbSync(manual) {
  if (KB.status === "syncing") return;
  if (typeof N.kbSync !== "function") { KB.status = "error"; KB.errMsg = "当前版本还不支持课程同步"; renderKb(); return; }
  KB.status = "syncing"; KB.syncDone = 0; KB.syncTotal = 0; KB.errMsg = "";
  renderKb();
  try { N.kbSync((KB.index && KB.index.release) || ""); }
  catch (e) { KB.status = "error"; KB.errMsg = "同步失败"; renderKb(); }
}
function kbSyncFail(msg) { KB.status = "error"; KB.errMsg = msg || "同步失败"; renderKb(); }
function kbSyncFinish() {
  KB.status = "idle"; KB.lastSync = Date.now(); KB.syncDone = KB.syncTotal = 0;
  kbLoadIndex(); kbSave(); KB.mounted = ""; KB.fetched = {};
  renderKb();
}
function kbStatHTML() {
  if (KB.status === "syncing") {
    const n = KB.syncTotal ? ` ${KB.syncDone}/${KB.syncTotal}` : "…";
    return `<span class="kb-sync"><span class="ring"></span>同步中${n}</span>`;
  }
  if (KB.status === "error") {
    return `<span class="kb-off" title="${esc(KB.errMsg || "")}">离线 · 显示缓存</span><button class="txt-btn" data-kb="sync">重试</button>`;
  }
  const min = KB.lastSync ? Math.floor((Date.now() - KB.lastSync) / 60000) : -1;
  const when = min < 0 ? "尚未同步" : min < 1 ? "已更新 · 刚刚" : min < 60 ? `已更新 · ${min} 分钟前` : `已更新 · ${Math.floor(min / 60)} 小时前`;
  return `<span class="kb-when">${when}</span><button class="txt-btn" data-kb="sync">刷新</button>`;
}
function kbStatusBar() { return `<div class="kb-stat">${kbStatHTML()}</div>`; }
function kbRefreshStatus() { $$(".kb-stat").forEach(n => { n.innerHTML = kbStatHTML(); }); }
handlers.kb = d => {
  d = d || {};
  const state = d.state || (d.error ? "error" : "progress");
  if (d.total != null) KB.syncTotal = d.total;
  if (d.done != null) KB.syncDone = d.done;
  if (state === "error") { KB.status = "error"; KB.errMsg = d.msg || "同步失败"; renderKb(); return; }
  if (state === "done" || state === "ok") { kbSyncFinish(); return; }
  if (KB.status !== "syncing") { KB.status = "syncing"; renderKb(); return; }
  kbRefreshStatus();
};
handlers.kbIndex = idx => {
  const parsed = kbParseIndex(idx);
  if (!parsed) return;
  KB.index = parsed; KB.autoTried = true;
  KB.status = "idle"; KB.lastSync = Date.now(); KB.syncDone = KB.syncTotal = 0;
  KB.mounted = ""; KB.fetched = {}; kbSave(); renderKb();
};

/* ---------- 列表 ---------- */
function kbListScrollEl() {
  if (KB.view === "read") return null;
  const v = $("#v-kb");
  if (!v) return null;
  return st.screen === "inner" && KB.view !== "courses" ? $(".kb-col", v) : v;
}
function kbScrollKey() { return KB.view + ":" + ((KB.course && KB.course.id) || ""); }
function kbCaptureScroll() {
  const el = kbListScrollEl(); if (el) KB.scroll[kbScrollKey()] = el.scrollTop;
}
function kbRestoreScroll() {
  const el = kbListScrollEl(); if (el) el.scrollTop = KB.scroll[kbScrollKey()] || 0;
}
function kbEmptyHTML() {
  const err = KB.status === "error";
  const syncing = KB.status === "syncing";
  return `<div class="lg-head"><h2>课程</h2><button class="circle" data-kb="sync" aria-label="同步">${I.sync}</button></div>
    <div class="kb-empty">
      <div class="kb-empty-icon">${I.kb}</div>
      <div class="kb-empty-t">${syncing ? "正在同步课程" : err ? "离线，还没有缓存" : "还没有课程"}</div>
      <button class="pill primary kb-empty-btn" data-kb="sync" ${syncing ? "disabled" : ""}>${syncing ? "同步中…" : "同步"}</button>
    </div>`;
}
function kbCourseCard(c) {
  const [done, total] = kbCourseProgress(c);
  const pct = total ? Math.round(done / total * 100) : 0;
  return `<button class="kb-course" data-kb-course="${esc(c.id)}">
    <span class="kb-ic">${c.icon ? esc(c.icon) : I.kb}</span>
    <span class="kb-cinfo"><span class="kb-ct">${esc(c.title)}</span>
      <span class="kb-cmeta">${total} 篇 · 已读 ${done}/${total}</span>
      <span class="bar bar-s"><i style="width:${Math.max(2, pct)}%"></i></span></span>
    <span class="kb-chev">${I.chev}</span></button>`;
}
function kbContinueHTML(x) {
  const pct = kbPct(x.a);
  return `<button class="kb-cont" data-kb-open="${esc(x.c.id)}/${esc(x.a.id)}">
    <span class="kb-cont-k">继续阅读</span>
    <span class="kb-cont-t">${esc(x.a.title)}</span>
    <span class="kb-cont-c">${esc(x.c.title)}${pct ? ` · ${pct}%` : ""}</span>
    <span class="bar bar-s"><i style="width:${Math.max(3, pct)}%"></i></span></button>`;
}
function kbCoursesHTML() {
  if (!kbCourses().length) return kbEmptyHTML();
  const last = kbLastRead();
  const cards = kbCourses().slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(kbCourseCard).join("");
  return `<div class="lg-head"><h2>课程</h2><button class="circle" data-kb="sync" aria-label="同步">${I.sync}</button></div>
    ${kbStatusBar()}
    ${last ? kbContinueHTML(last) : ""}
    <div class="sec-t">全部课程</div>
    <div class="kb-courses">${cards}</div>`;
}
function kbArticleRow(a, active) {
  const pct = kbPct(a), seen = kbIsSeen(a), fresh = kbIsNew(a);
  return `<li class="${active ? "on" : ""}"><button data-kb-art="${esc(a.id)}">
    <span class="kb-art-t">${esc(a.title)}${fresh ? '<span class="kb-new">新</span>' : ""}</span>
    <span class="kb-art-m">${kbReadMin(a)} 分钟${seen ? " · 已读" : ""}</span>
    ${pct ? `<span class="bar bar-s"><i style="width:${pct}%"></i></span>` : ""}
  </button></li>`;
}
function kbListHTML() {
  const c = KB.course;
  if (!c) return kbEmptyHTML();
  const active = KB.article && KB.article.a ? KB.article.a.id : "";
  const rows = kbArticles(c).map(a => kbArticleRow(a, active === a.id)).join("");
  const head = `<div class="kb-head"><button class="back" data-kb="courses">${I.chev}课程</button></div>
    <div class="lg-head"><h2>${esc(c.title)}</h2><span class="kb-count">${kbArticles(c).length} 篇</span></div>
    ${kbStatusBar()}`;
  if (st.screen === "inner") {
    return `<div class="kb-split"><div class="kb-col">${head}<ul class="list kb-rows">${rows}</ul></div><div class="kb-pane"><div class="kb-pane-empty">选一篇文章开始读</div></div></div>`;
  }
  return `${head}<ul class="list kb-rows">${rows}</ul>`;
}

/* ---------- 阅读 ---------- */
function kbLayer() {
  let layer = $("#kb-read");
  if (!layer) {
    layer = el("div", "kb-read"); layer.id = "kb-read";
    layer.innerHTML = `<div class="kb-top">
      <button class="circle" data-kb="back" aria-label="返回">${I.chev}</button>
      <span class="kb-top-t"></span>
      <button class="circle" data-kb="toc" aria-label="目录">${I.list}</button>
      <button class="circle" data-kb="themes" aria-label="主题与字号">${I.aa}</button>
      <button class="circle" data-kb="full" aria-label="全屏阅读" aria-pressed="false">${I.expand}</button>
    </div><div class="kb-prog"><i></i></div><div class="kb-scroll"></div>`;
    scr.appendChild(layer);
    kbBindLayerGestures(layer);
  }
  layer.hidden = false;
  layer.dataset.theme = st.theme;
  layer.classList.toggle("full", !!KB.full);
  layer.classList.toggle("nochrome", !KB.chrome);
  const t = $(".kb-top-t", layer);
  if (t) t.textContent = (KB.article && KB.article.a && KB.article.a.title) || "";
  const fb = $('[data-kb="full"]', layer);
  if (fb) { fb.innerHTML = KB.full ? I.shrink : I.expand; fb.setAttribute("aria-pressed", KB.full ? "true" : "false"); }
  return layer;
}

/* ---------- 沉浸/顶栏 ---------- */
function kbBars(visible) {
  if (KB.barsOn === visible) return;
  KB.barsOn = visible;
  try { N.bars(visible, !darkUI()); } catch (e) { }
}
function kbSetChrome(on) {
  KB.chrome = !!on;
  const layer = $("#kb-read");
  if (layer) layer.classList.toggle("nochrome", !KB.chrome);
  clearTimeout(KB.idleT);
  if (KB.full && KB.chrome) KB.idleT = setTimeout(() => { if (KB.full) kbSetChrome(false); }, 2200);
}
function kbSetFull(on, remember = true) {
  KB.full = !!on;
  const layer = $("#kb-read");
  if (layer) {
    layer.classList.toggle("full", KB.full);
    const fb = $('[data-kb="full"]', layer);
    if (fb) { fb.innerHTML = KB.full ? I.shrink : I.expand; fb.setAttribute("aria-pressed", KB.full ? "true" : "false"); }
  }
  if (KB.full) { kbSetChrome(false); kbBars(false); }
  else { kbBars(true); kbSetChrome(true); }
  if (remember) kv.set("kbfull", KB.full);
  clearTimeout(KB.idleT);
  if (KB.full) KB.idleT = setTimeout(() => { if (KB.full) kbSetChrome(false); }, 1800);
}
function kbChromeOnScroll(host) {
  if (KB.suppress) return;
  const y = host.scrollTop, dy = y - (KB.lastY || 0);
  KB.lastY = y;
  if (Math.abs(dy) < 1) return;
  KB.acc = (KB.acc > 0 && dy > 0) || (KB.acc < 0 && dy < 0) ? KB.acc + dy : dy;
  if (KB.acc > 18 && y > 40 && KB.chrome) { kbSetChrome(false); KB.acc = 0; }
  else if (KB.acc < -18 && !KB.chrome) { kbSetChrome(true); KB.acc = 0; }
  if (KB.full) {
    clearTimeout(KB.idleT);
    KB.idleT = setTimeout(() => { if (KB.full && host.scrollTop > 30) kbSetChrome(false); }, 1000);
  }
}
function kbBindLayerGestures(layer) {
  if (layer.dataset.kbgest) return;
  layer.dataset.kbgest = "1";
  layer.addEventListener("click", e => {
    if (st.screen !== "inner" || KB.view !== "read") return;
    if (e.target.closest("a, img, figure, pre, table, svg, button, .kb-zoom, .kb-top, .kb-prog")) return;
    if (KB.full) { if (KB.chrome) kbSetFull(false, false); else kbSetChrome(true); return; }
    kbSetChrome(!KB.chrome);
  });
}
function kbArticleHost() { return $("#kb-read .kb-scroll"); }
function kbDoc() { return kbArticleHost() ? $(".art-doc", kbArticleHost()) : null; }
function kbEnterRead() {
  if (R) return;
  scr.classList.add("reading");
  try { N.reading(true); } catch (e) { }
  if (st.screen === "outer" || KB.full) kbBars(false);
  else kbBars(true);
}
function kbExitRead() {
  if (R) return;
  scr.classList.remove("reading");
  KB.full = false; KB.chrome = true;
  clearTimeout(KB.idleT);
  try { N.reading(false); } catch (e) { }
  kbBars(true);
  const layer = $("#kb-read");
  if (layer) layer.classList.remove("full", "nochrome");
}
function kbRenderArticle(force) {
  const host = kbArticleHost(), pair = KB.article;
  if (!host || !pair) return;
  const { c, a } = pair;
  const key = c.id + "/" + a.id + "/" + (a.updated || "");
  if (!force && KB.mounted === key && $(".art-doc", host)) return;
  KB.mounted = key;
  host.innerHTML = `<div class="art" data-theme="${esc(st.theme)}" data-font="${esc(st.font)}" lang="zh-CN"><div class="art-doc"></div><div class="kb-loading"><span class="ring"></span></div></div>`;
  const art = $(".art", host);
  if (art) applyTypo(art);
  kbBindScroll(host);
  const url = `/kb/a/${encodeURIComponent(c.id)}/${encodeURIComponent(a.id)}.html`;
  kbGetArticle(url).then(html => {
    if (KB.mounted !== key) return;
    const doc = $(".art-doc", host); if (!doc) return;
    doc.innerHTML = html;
    kbPrepArticle(doc);
    kbMarkSeen(a);
    kbRestoreArticle(host, a);
    kbUpdateProg(host);
  }).catch(err => {
    const doc = $(".art-doc", host); if (!doc) return;
    const msg = err && err.message ? err.message : "";
    doc.innerHTML = `<div class="kb-err"><p>这篇还没下载好</p>${msg ? `<p class="note">${esc(msg)}</p>` : ""}<button class="pill primary" data-kb="retry-art">重试</button></div>`;
  }).finally(() => { const l = $(".kb-loading", host); if (l) l.remove(); });
}
function kbGetArticle(url) {
  if (!KB.fetched[url]) {
    KB.fetched[url] = fetch(url).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
    KB.fetched[url].catch(() => { delete KB.fetched[url]; });
  }
  return KB.fetched[url];
}
function kbPrepArticle(doc) {
  $$("img", doc).forEach(img => {
    img.decoding = "async";
    if (!img.getAttribute("loading")) img.setAttribute("loading", "lazy");
    img.addEventListener("error", () => img.classList.add("kb-img-missing"), { once: true });
  });
  kbPrepMermaid(doc);
  kbPrepCode(doc);
  kbPrepTables(doc);
}

/* mermaid：同一 figure 里可能有 light/dark 两版 SVG（契约），旧产物只有单个当浅色 */
function kbPrepMermaid(doc) {
  $$("figure", doc).forEach(fig => {
    const svgs = [...fig.querySelectorAll("svg")].filter(s => !s.closest(".kb-mm-badge"));
    if (!svgs.length) return;
    fig.classList.add("kb-mm");
    const hasLight = svgs.some(s => s.classList.contains("kb-mm-light"));
    const hasDark = svgs.some(s => s.classList.contains("kb-mm-dark"));
    if (!hasLight && !hasDark) svgs[0].classList.add("kb-mm-light");          // 旧单图 = 浅色
    else if (!hasLight && svgs.length > 1) svgs[0].classList.add("kb-mm-light");
    let ultra = false;
    svgs.forEach(s => {
      let vb = (s.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
      if ((vb.length < 4 || !(vb[2] > 0)) && s.getAttribute("width") && s.getAttribute("height")) {
        const w = parseFloat(s.getAttribute("width")), h = parseFloat(s.getAttribute("height"));
        if (w > 0 && h > 0) { s.setAttribute("viewBox", `0 0 ${w} ${h}`); vb = [0, 0, w, h]; }
      }
      s.removeAttribute("width");
      s.removeAttribute("height");
      s.style.width = "";
      s.style.height = "";
      s.style.maxWidth = "";
      if (vb.length >= 4) {
        s.setAttribute("viewBox", `0 0 ${vb[2]} ${vb[3]}`);
        if (vb[3] / vb[2] > 1.6) s.style.maxWidth = `calc(68vh * ${(vb[2] / vb[3]).toFixed(4)})`;
        if (vb[2] > 1800) ultra = true;
      }
    });
    if (ultra) fig.classList.add("kb-mm-ultra");
    let badge = $(".kb-mm-badge", fig);
    if (!badge) { badge = el("span", "kb-mm-badge"); fig.appendChild(badge); }
    badge.innerHTML = `${I.expand}<span>${ultra ? "宽图 · 查看大图" : "查看大图"}</span>`;
  });
}

/* 代码块：语言标签 + 复制按钮（复制内容不含标签栏） */
const KB_LANG = {
  py: "Python", python: "Python", python3: "Python", ipython: "Python",
  js: "JavaScript", javascript: "JavaScript", mjs: "JavaScript", jsx: "JavaScript",
  ts: "TypeScript", typescript: "TypeScript", tsx: "TypeScript",
  sql: "SQL", sh: "Shell", bash: "Shell", shell: "Shell", zsh: "Shell", console: "Shell",
  java: "Java", kotlin: "Kotlin", go: "Go", rust: "Rust", ruby: "Ruby", php: "PHP",
  c: "C", cpp: "C++", "c++": "C++", cxx: "C++", csharp: "C#", "c#": "C#", cs: "C#",
  html: "HTML", xml: "XML", css: "CSS", scss: "SCSS", json: "JSON", yaml: "YAML", yml: "YAML",
  toml: "TOML", ini: "INI", diff: "Diff", patch: "Diff", mermaid: "Mermaid",
  text: "TEXT", txt: "TEXT", plain: "TEXT", plaintext: "TEXT", markdown: "Markdown", md: "Markdown"
};
function kbLangName(code) {
  const m = (code.className || "").match(/(?:language|lang)-([\w+#.-]+)/i);
  const raw = m ? m[1].toLowerCase() : "";
  return KB_LANG[raw] || (raw ? raw.toUpperCase() : "TEXT");
}
function kbPrepCode(doc) {
  $$("pre", doc).forEach(pre => {
    if (pre.closest(".kb-codewrap")) return;
    const code = pre.querySelector("code") || pre;
    const wrap = el("div", "kb-codewrap");
    const bar = el("div", "kb-code-bar",
      `<span class="kb-lang">${esc(kbLangName(code))}</span><button class="kb-copy" type="button" data-kb-copy>复制</button>`);
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(bar);
    wrap.appendChild(pre);
  });
}
function kbCopyFallback(text) {
  try {
    const ta = el("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
function kbCopyText(text) {
  return new Promise(resolve => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true)).catch(() => resolve(kbCopyFallback(text)));
        return;
      }
    } catch (err) { /* 继续走兜底 */ }
    resolve(kbCopyFallback(text));
  });
}
function kbCopyCode(btn) {
  const wrap = btn.closest(".kb-codewrap");
  const pre = wrap && wrap.querySelector("pre");
  if (!pre) return;
  kbCopyText(pre.textContent).then(ok => {
    btn.textContent = ok ? "已复制" : "复制失败";
    toast(ok ? "已复制代码" : "复制失败");
    setTimeout(() => { btn.textContent = "复制"; }, 1400);
  });
}

/* 表格：外包一层做右侧渐隐提示；表头/首列 sticky 由 CSS 完成 */
function kbPrepTables(doc) {
  $$("table", doc).forEach(tbl => {
    let tw = tbl.closest(".kb-tw");
    if (!tw) {
      tw = el("div", "kb-tw");
      tbl.parentNode.insertBefore(tw, tbl);
      tw.appendChild(tbl);
    }
    if (tw.closest(".kb-tw-wrap")) return;
    const wrap = el("div", "kb-tw-wrap");
    tw.parentNode.insertBefore(wrap, tw);
    wrap.appendChild(tw);
    const update = () => {
      const max = Math.max(0, tw.scrollWidth - tw.clientWidth);
      wrap.classList.toggle("can-scroll", max > 4);
      wrap.classList.toggle("at-end", max <= 4 || tw.scrollLeft >= max - 4);
    };
    tw.addEventListener("scroll", update, { passive: true });
    update();
    requestAnimationFrame(update);
    setTimeout(update, 200);
  });
}

function kbRestoreArticle(host, a) {
  const p = KB.prog[a.id];
  KB.userScrolled = false;
  KB.suppress = true;
  const pct = p && p.pct != null ? Math.max(0, Math.min(1, p.pct)) : 0;
  KB.ratio = pct;
  const apply = () => {
    if (KB.userScrolled || !host) return;
    const max = Math.max(0, host.scrollHeight - host.clientHeight);
    if (max > 0) host.scrollTop = Math.round(pct * max);
    kbUpdateProg(host);
  };
  setTimeout(() => { KB.suppress = false; KB.lastY = host ? host.scrollTop : 0; KB.ratio = pct; }, 600);
  if (!pct) return;
  requestAnimationFrame(apply);
  $$("img", host).forEach(img => {
    if (img.complete) return;
    img.addEventListener("load", () => { if (!KB.userScrolled) apply(); }, { once: true });
  });
}
function kbMarkSeen(a) {
  if (!a) return;
  const v = a.updated || "";
  if (KB.seen[a.id] !== v) { KB.seen[a.id] = v; kbSave(); }
}
function kbBindScroll(host) {
  if (!host || host.dataset.kbbound) return;
  host.dataset.kbbound = "1";
  let t = 0;
  host.addEventListener("scroll", () => {
    KB.userScrolled = true;
    const max = Math.max(1, host.scrollHeight - host.clientHeight);
    KB.ratio = host.scrollTop / max;
    kbUpdateProg(host);
    if (st.screen === "inner" && KB.view === "read") kbChromeOnScroll(host);
    clearTimeout(t); t = setTimeout(() => kbSaveArticle(host), 400);
  }, { passive: true });
}
function kbSaveArticle(host) {
  const a = KB.article && KB.article.a;
  if (!a || !host) return;
  const max = Math.max(0, host.scrollHeight - host.clientHeight);
  const pct = max > 0 ? Math.min(1, host.scrollTop / max) : 0;
  KB.prog[a.id] = { y: Math.round(host.scrollTop), pct: +pct.toFixed(4), at: Date.now() };
  kbSave();
}
function kbUpdateProg(host) {
  const bar = $("#kb-read .kb-prog i");
  if (!bar || !host) return;
  const max = Math.max(0, host.scrollHeight - host.clientHeight);
  bar.style.width = Math.round((max > 0 ? host.scrollTop / max : 0) * 100) + "%";
}
/* 旋转/折叠后按比例恢复位置：见 ResizeObserver / setScreen 调用 */
function kbRestoreRatio() {
  const host = kbArticleHost();
  if (!host || KB.view !== "read") return;
  const ratio = Math.max(0, Math.min(1, KB.ratio || 0));
  KB.suppress = true;
  const apply = () => {
    const max = Math.max(0, host.scrollHeight - host.clientHeight);
    if (max > 0) host.scrollTop = Math.round(ratio * max);
    kbUpdateProg(host);
  };
  requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
  clearTimeout(KB.ratioT);
  KB.ratioT = setTimeout(() => {
    apply();
    KB.suppress = false;
    KB.lastY = host.scrollTop;
    const max = Math.max(1, host.scrollHeight - host.clientHeight);
    KB.ratio = host.scrollTop / max;
  }, 420);
}
function kbOpenToc() {
  const doc = kbDoc();
  if (!doc) return;
  const items = $$("h2[id], h3[id]", doc).map(h => ({ id: h.id, t: h.textContent.trim(), l3: h.tagName === "H3" }));
  if (!items.length) { toast("这篇没有小节标题"); return; }
  openSheet(`<div class="sh-head"><h3>目录</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
    <div class="sh-body flush"><ul class="list kb-toc">${items.map(h => `<li class="${h.l3 ? "kb-toc-3" : ""}"><button data-kb-go="${esc(h.id)}"><span class="lw">${esc(h.t)}</span></button></li>`).join("")}</ul></div>`);
}
/* ---------- 全屏查看器（图片 / mermaid 共用，替换旧 kb-zoom） ---------- */
const KBV = {
  open: false, kind: "", natW: 800, natH: 600, base: 1, z: 1, tx: 0, ty: 0, rot: 0,
  fit: "width", pointers: new Map(), lastTap: 0, lastTapX: 0, lastTapY: 0, moved: false
};
function kbViewer() {
  let v = $("#kb-viewer");
  if (v) return v;
  v = el("div", "kb-viewer"); v.id = "kb-viewer";
  v.innerHTML = `<div class="kbv-stage"><div class="kbv-frame"><div class="kbv-media"></div></div></div>
    <div class="kbv-top"><span class="kbv-cap"></span><button class="kbv-close" data-kbv="close" aria-label="关闭">${I.x}</button></div>
    <div class="kbv-bar">
      <button data-kbv="out" aria-label="缩小">−</button><span class="kbv-zoom">100%</span><button data-kbv="in" aria-label="放大">＋</button>
      <span class="kbv-sep"></span><button data-kbv="fit">整图</button><button data-kbv="rot" aria-label="旋转">${I.rotate}</button>
    </div>`;
  scr.appendChild(v);
  kbvBind(v);
  return v;
}
function kbvMediaEl() { return $("#kb-viewer .kbv-media"); }
function kbViewerOpen() { const v = $("#kb-viewer"); return !!(v && v.classList.contains("on")); }
function kbCloseViewer() {
  const v = $("#kb-viewer"); if (!v) return;
  v.classList.remove("on");
  KBV.open = false; KBV.pointers.clear(); KBV.moved = false;
  const media = kbvMediaEl(); if (media) media.innerHTML = "";
}
function kbvCloseIfOpen() { if (KBV.open) kbCloseViewer(); }
function kbvApply() {
  const v = $("#kb-viewer"); if (!v) return;
  const stage = $(".kbv-stage", v), frame = $(".kbv-frame", v), media = $(".kbv-media", v);
  if (!stage || !frame || !media) return;
  const sc = KBV.base * KBV.z;
  const swap = KBV.rot % 180 !== 0;
  const w = (swap ? KBV.natH : KBV.natW) * sc, h = (swap ? KBV.natW : KBV.natH) * sc;
  const mx = Math.max(0, (w - stage.clientWidth) / 2) + 40;
  const my = Math.max(0, (h - stage.clientHeight) / 2) + 40;
  KBV.tx = Math.max(-mx, Math.min(mx, KBV.tx));
  KBV.ty = Math.max(-my, Math.min(my, KBV.ty));
  media.style.width = KBV.natW + "px";
  media.style.height = KBV.natH + "px";
  media.style.transform = `rotate(${KBV.rot}deg)`;
  frame.style.transform = `translate(${KBV.tx}px, ${KBV.ty}px) scale(${sc})`;
  const z = $(".kbv-zoom", v); if (z) z.textContent = Math.round(KBV.z * 100) + "%";
}
function kbvFit(mode) {
  if (!KBV.open) return;
  if (mode) KBV.fit = mode;
  const stage = $("#kb-viewer .kbv-stage"); if (!stage) return;
  const cs = getComputedStyle(stage);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const sw = Math.max(80, stage.clientWidth - padX - 12), sh = Math.max(80, stage.clientHeight - padY - 8);
  const swap = KBV.rot % 180 !== 0;
  const ew = swap ? KBV.natH : KBV.natW, eh = swap ? KBV.natW : KBV.natH;
  const contain = Math.min(sw / ew, sh / eh);
  const fitW = sw / ew;
  let base;
  if (KBV.fit === "contain") base = contain;
  else if (fitW >= 0.55) base = Math.min(fitW, 2.5);
  else base = 1;   // 窄屏上「适应宽度」等于没放大：给原生尺寸，可拖动看细节
  if (!isFinite(base) || base <= 0) base = contain;
  KBV.base = base; KBV.z = 1; KBV.tx = 0; KBV.ty = 0;
  kbvApply();
}
function kbvZoomAt(newZ, cx, cy) {
  const stage = $("#kb-viewer .kbv-stage"); if (!stage) return;
  newZ = Math.max(1, Math.min(5, newZ));
  const r = stage.getBoundingClientRect();
  const mx = cx - (r.left + r.width / 2), my = cy - (r.top + r.height / 2);
  const s0 = KBV.base * KBV.z, s1 = KBV.base * newZ;
  KBV.tx = mx - (mx - KBV.tx) / s0 * s1;
  KBV.ty = my - (my - KBV.ty) / s0 * s1;
  KBV.z = newZ;
  kbvApply();
}
function kbvStep(dir) { kbvZoomAt(KBV.z + dir * 0.25, innerWidth / 2, innerHeight / 2); }
function kbvDoubleTap() {
  if (KBV.z > 1.02) { KBV.fit = "contain"; kbvFit("contain"); }
  else { KBV.fit = "contain"; kbvFit("contain"); KBV.z = 2; kbvApply(); }
}
function kbvBind(v) {
  const stage = $(".kbv-stage", v);
  const ids = new Map();
  let drag = null;
  stage.addEventListener("pointerdown", e => {
    if (!KBV.open) return;
    ids.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 不做 pointer capture：capture 会把后续 click 的 target 改成 stage，导致点图被误判成点空白
    if (ids.size === 1) {
      drag = { x: e.clientX, y: e.clientY, tx: KBV.tx, ty: KBV.ty, moved: false };
      KBV.pinch = null;
    } else if (ids.size === 2) {
      const [a, b] = [...ids.values()];
      KBV.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: KBV.z };
      drag = null; KBV.moved = true;
    }
  });
  stage.addEventListener("pointermove", e => {
    if (!KBV.open || !ids.has(e.pointerId)) return;
    ids.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ids.size >= 2 && KBV.pinch) {
      const [a, b] = [...ids.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      kbvZoomAt(KBV.pinch.z0 * (d / KBV.pinch.d0), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; KBV.moved = true; }
      if (drag.moved) { KBV.tx = drag.tx + dx; KBV.ty = drag.ty + dy; kbvApply(); }
    }
  });
  const up = e => {
    ids.delete(e.pointerId);
    if (ids.size === 0) {
      const wasMoved = KBV.moved || (drag && drag.moved);
      if (!wasMoved && drag) {
        const now = Date.now();
        if (now - KBV.lastTap < 320 && Math.abs(e.clientX - KBV.lastTapX) < 26 && Math.abs(e.clientY - KBV.lastTapY) < 26) {
          KBV.lastTap = 0; kbvDoubleTap();
        } else { KBV.lastTap = now; KBV.lastTapX = e.clientX; KBV.lastTapY = e.clientY; }
      }
      if (!wasMoved) KBV.moved = false;
      drag = null; KBV.pinch = null;
    } else if (ids.size === 1) {
      const p = [...ids.values()][0];
      drag = { x: p.x, y: p.y, tx: KBV.tx, ty: KBV.ty, moved: true };
      KBV.pinch = null;
    }
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  stage.addEventListener("wheel", e => {
    if (!KBV.open) return;
    e.preventDefault();
    kbvZoomAt(KBV.z * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });
  v.addEventListener("click", e => {
    const btn = e.target.closest("[data-kbv]");
    if (btn) {
      const act = btn.dataset.kbv;
      if (act === "close") kbCloseViewer();
      else if (act === "in") kbvStep(1);
      else if (act === "out") kbvStep(-1);
      else if (act === "fit") kbvFit("contain");
      else if (act === "rot") { KBV.rot = (KBV.rot + 90) % 360; kbvFit(KBV.fit === "contain" ? "contain" : "width"); }
      return;
    }
    if (e.target.closest(".kbv-frame, .kbv-media")) return;
    if (KBV.moved) { KBV.moved = false; return; }
    kbCloseViewer();
  });
}
function kbvNatural() {
  const media = kbvMediaEl(); if (!media) return;
  const svg = media.querySelector("svg"), img = media.querySelector("img");
  if (svg) {
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    KBV.natW = vb.length >= 4 ? vb[2] : (parseFloat(svg.getAttribute("width")) || 800);
    KBV.natH = vb.length >= 4 ? vb[3] : (parseFloat(svg.getAttribute("height")) || 600);
    svg.setAttribute("width", KBV.natW); svg.setAttribute("height", KBV.natH);
    svg.style.width = "100%"; svg.style.height = "100%";
  } else if (img) {
    KBV.natW = img.naturalWidth || 800;
    KBV.natH = img.naturalHeight || 600;
  }
}
function kbOpenViewer(kind, payload, caption) {
  const v = kbViewer(), media = kbvMediaEl();
  if (!media) return;
  media.innerHTML = ""; media.style.transform = "";
  KBV.open = true; KBV.kind = kind; KBV.rot = 0; KBV.fit = "width"; KBV.z = 1; KBV.tx = 0; KBV.ty = 0;
  KBV.pointers.clear(); KBV.moved = false; KBV.lastTap = 0;
  if (kind === "svg" && payload) {
    const clone = payload.cloneNode(true);
    clone.removeAttribute("class"); clone.removeAttribute("style");
    clone.setAttribute("width", "100%"); clone.setAttribute("height", "100%");
    media.appendChild(clone);
    const vb = (payload.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    KBV.natW = vb.length >= 4 ? vb[2] : (parseFloat(payload.getAttribute("width")) || 800);
    KBV.natH = vb.length >= 4 ? vb[3] : (parseFloat(payload.getAttribute("height")) || 600);
    kbvNatural();
  } else {
    const img = el("img", "kbv-img"); img.alt = "";
    media.appendChild(img);
    KBV.natW = 800; KBV.natH = 600;
    img.onload = () => { if (KBV.open) { kbvNatural(); kbvFit(KBV.fit); } };
    img.src = payload;
  }
  const cap = $(".kbv-cap", v); if (cap) cap.textContent = caption || "";
  v.classList.add("on");
  requestAnimationFrame(() => kbvFit("width"));
}
function kbFigSvg(fig) {
  const svgs = [...fig.querySelectorAll("svg")].filter(s => !s.closest(".kb-mm-badge"));
  return svgs.find(s => getComputedStyle(s).display !== "none") || svgs[0] || null;
}
function kbZoom(src) { kbOpenViewer("img", src, ""); }
function kbOpenArticle(articleId) {
  const x = kbFind(articleId);
  if (!x) { toast("没有这篇文章"); return; }
  if (KB.view === "read") kbSaveArticle(kbArticleHost());
  KB.course = x.c; KB.article = x; KB.view = "read"; KB.mounted = ""; KB.userScrolled = false;
  KB.chrome = true; KB.lastY = 0; KB.acc = 0; KB.suppress = false; KB.ratio = 0;
  KB.lastViewport = innerWidth + "x" + innerHeight;
  KB.full = st.screen === "inner" && !!kv.get("kbfull", false);
  if (KB.full) KB.chrome = false;   // 沉浸模式进入即收起顶栏
  renderKb();
}
function kbOpenCourse(courseId) {
  const c = kbCourseById(courseId);
  if (!c) return;
  kbvCloseIfOpen();
  if (KB.view === "read") kbSaveArticle(kbArticleHost());
  KB.course = c; KB.article = null; KB.view = "list"; KB.mounted = "";
  KB.scroll["list:" + c.id] = 0;
  kbExitRead();
  const layer = $("#kb-read"); if (layer) layer.hidden = true;
  renderKb();
}
function kbLeaveRead() {
  kbvCloseIfOpen();
  if (KB.view === "read") kbSaveArticle(kbArticleHost());
  KB.view = KB.course ? "list" : "courses";
  KB.article = null; KB.mounted = "";
  kbExitRead();
  const layer = $("#kb-read"); if (layer) layer.hidden = true;
}
function kbBack() {
  if (KB.view === "read") { kbLeaveRead(); renderKb(); return; }
  if (KB.view === "list") { KB.view = "courses"; KB.course = null; renderKb(); return; }
  setTab("physical");
}
function renderKb() {
  const v = $("#v-kb"); if (!v) return;
  kbCaptureScroll();
  if (!KB.index) kbLoadIndex();
  if (!KB.index || !KB.index.courses || !KB.index.courses.length) {
    v.innerHTML = kbEmptyHTML();
    if (!KB.autoTried && kbNeedsSync()) { KB.autoTried = true; kbSync(false); }
    return;
  }
  if (KB.view === "read" && st.screen === "outer" && KB.full) kbSetFull(false, false);
  if (KB.view === "read") kbLayer();
  else { const layer = $("#kb-read"); if (layer) layer.hidden = true; }
  if (KB.view === "courses") v.innerHTML = kbCoursesHTML();
  else v.innerHTML = kbListHTML();
  if (KB.view === "read") { kbEnterRead(); kbRenderArticle(); }
  else kbExitRead();
  kbRestoreScroll();
  if (KB.view === "courses" && !KB.autoTried && kbNeedsSync()) { KB.autoTried = true; kbSync(false); }
}

/* ---------- 课程页事件 ---------- */
scr.addEventListener("click", e => {
  if (e.target.closest("#kb-viewer")) return;   // 查看器内部的按钮/空白由 #kb-viewer 处理
  const copyBtn = e.target.closest("[data-kb-copy]");
  if (copyBtn) { e.preventDefault(); kbCopyCode(copyBtn); return; }
  const kbBtn = e.target.closest("[data-kb]");
  if (kbBtn) {
    const act = kbBtn.dataset.kb;
    if (act === "back") kbBack();
    else if (act === "courses") { kbLeaveRead(); KB.view = "courses"; KB.course = null; renderKb(); }
    else if (act === "sync") kbSync(true);
    else if (act === "full") { if (st.screen === "inner" && KB.view === "read") kbSetFull(!KB.full); }
    else if (act === "themes") { if (KB.view === "read") kbSetChrome(true); openThemes(true); }
    else if (act === "toc") { if (KB.view === "read") kbSetChrome(true); kbOpenToc(); }
    else if (act === "retry-art") kbRenderArticle(true);
    return;
  }
  const course = e.target.closest("[data-kb-course]");
  if (course) { kbOpenCourse(course.dataset.kbCourse); return; }
  const open = e.target.closest("[data-kb-open]");
  if (open) {
    const [cid, aid] = open.dataset.kbOpen.split("/");
    const c = kbCourseById(cid);
    if (c) { KB.course = c; kbOpenArticle(aid); }
    return;
  }
  const art = e.target.closest("[data-kb-art]");
  if (art) { kbOpenArticle(art.dataset.kbArt); return; }
  const mmFig = e.target.closest(".art-doc figure.kb-mm");
  if (mmFig && KB.view === "read") {
    const svg = kbFigSvg(mmFig);
    if (svg) { e.preventDefault(); kbOpenViewer("svg", svg, (mmFig.querySelector("figcaption") || {}).textContent || ""); return; }
  }
  const link = e.target.closest(".kb-art a[data-kb-article], .kb-art a[href]");
  if (link && KB.view === "read") {
    e.preventDefault();
    const id = link.getAttribute("data-kb-article");
    if (id) { kbOpenArticle(id); return; }
    const href = link.getAttribute("href") || "";
    if (/^https?:/i.test(href)) { try { N.openExternal(href); } catch (err) { } }
    return;
  }
  const img = e.target.closest(".art-doc img");
  if (img && KB.view === "read" && !img.classList.contains("kb-img-missing")) {
    e.preventDefault();
    const fig = img.closest("figure");
    kbOpenViewer("img", img.currentSrc || img.src, (fig && fig.querySelector("figcaption") || {}).textContent || "");
    return;
  }
});
sheet.addEventListener("click", e => {
  const go = e.target.closest("[data-kb-go]");
  if (!go) return;
  closeSheet();
  const doc = kbDoc(), host = kbArticleHost();
  if (!doc || !host) return;
  const target = doc.querySelector("#" + CSS.escape(go.dataset.kbGo));
  if (!target) return;
  const top = target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 8;
  host.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
});

/* ===================== 查单词 ===================== */
function lookupHome() { return !st.query.trim() && !(st.screen === "inner" && st.pick); }
// 空闲和输入两种状态之间，搜索框从原位置滑到新位置（FLIP），宽度在内屏也会变化
function flipBox(before) {
  const box = $("#v-physical .qbox"); if (!before || !box || reduced) return;
  const after = box.getBoundingClientRect();
  const dx = before.left - after.left, dy = before.top - after.top;
  if (Math.abs(dx) + Math.abs(dy) < 1 && Math.abs(before.width - after.width) < 1) return;
  box.animate([{ transform: `translate(${dx}px, ${dy}px)`, width: before.width + "px" }, { transform: "none", width: after.width + "px" }], { duration: 300, easing: "cubic-bezier(.2, .8, .2, 1)" });
}
function renderPhysical() {
  const v = $("#v-physical");
  const old = $(".qbox", v), before = old && !v.hidden ? old.getBoundingClientRect() : null, wasHome = v.classList.contains("home");
  const hadFocus = document.activeElement?.id === "q";
  const col = `
    <label class="qbox">${I.search}<input id="q" type="search" enterkeyhint="search" placeholder="输入英文单词" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(st.query)}"><button class="clr" data-act="clear" aria-label="清除">${I.x}</button></label>
    <div class="acts">
      <button class="act" data-act="camera">${I.camera}<span>拍一页</span></button>
      <button class="act" data-act="album">${I.photo}<span>从相册选</span></button>
    </div>
    ${recents.length ? `<div class="recent"><div class="rt">最近查过</div><div class="rchips">${recents.slice(0, 8).map(w => `<button data-word="${esc(w)}">${esc(w)}</button>`).join("")}</div></div>` : ""}
    <ul class="list results" id="results"></ul>`;
  v.innerHTML = `<button class="circle gear" data-act="settings" aria-label="设置">${I.gear}</button>` + (st.screen === "inner"
    ? `<div class="split"><div class="col">${col}</div><div class="pane" id="ppane"></div></div>`
    : `<div class="col">${col}</div>`);
  if (st.screen === "inner") renderPane($("#ppane"), st.pick, "");
  const home = lookupHome();
  v.classList.toggle("home", home);
  renderResults();
  if (hadFocus) $("#q").focus({ preventScroll: true });
  if (wasHome !== home) flipBox(before);
}
function renderResults() {
  const r = $("#results"); if (!r) return;
  const q = st.query.trim();
  const row = (w, m, key = w) => `<li class="${st.pick === w ? "on" : ""}"><button data-word="${esc(key)}"><span class="lw">${esc(w)}</span><span class="lm">${esc(m)}</span></button></li>`;
  if (!q) { r.innerHTML = recents.map(w => row(w, senseOf(w))).join(""); return; }
  const hits = JSON.parse(N.prefix(q));
  r.innerHTML = hits.length ? hits.map(h => row(h.w, h.m, h.q || h.w)).join("") : `<li class="empty">词典里没有 ${esc(q)}</li>`;
}
function setQuery(q) {
  const v = $("#v-physical"), box = $(".qbox", v), before = box.getBoundingClientRect();
  st.query = q;
  const home = lookupHome();
  if (v.classList.contains("home") !== home) { v.classList.toggle("home", home); flipBox(before); }
  renderResults();
}
function clearQuery() { st.query = ""; st.pick = null; renderPhysical(); $("#q").focus({ preventScroll: true }); N.keyboard(true); }
function pickWord(k) {
  const i = recents.indexOf(k); if (i >= 0) recents.splice(i, 1);
  recents.unshift(k); recents.length = Math.min(recents.length, 50); kv.set("recents", recents);
  showWord(k, "查单词");
}
if (!CARD) {
  const pv = $("#v-physical");
  pv.addEventListener("input", e => { if (e.target.id === "q") setQuery(e.target.value); });
  pv.addEventListener("keydown", e => {
    if (e.target.id !== "q") return;
    if (e.key === "Enter") { e.preventDefault(); const f = $("#results [data-word]"); if (f) { pickWord(f.dataset.word); if (st.screen === "outer") { e.target.blur(); N.keyboard(false); } } }
  });
  pv.addEventListener("click", e => {
    const w = e.target.closest("[data-word]"); if (w) { pickWord(w.dataset.word); if (st.screen === "outer" && st.kb) N.keyboard(false); return; }
    const a = e.target.closest("[data-act]"); if (!a) return;
    if (a.dataset.act === "clear") { e.preventDefault(); clearQuery(); }
    else if (a.dataset.act === "settings") openSettings();
    else openCamera(a.dataset.act === "album");
  });
}

/* ===================== 生词本 ===================== */
function dayOf(t) {
  const now = Date.now(); if (now - t < 10 * 60e3) return "刚刚";
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  if (t >= d0.getTime()) return "今天";
  if (t >= d0.getTime() - 86400e3) return "昨天";
  return "更早";
}
function renderWords() {
  const v = $("#v-words");
  const items = [...saved].filter(([, m]) => st.words === "all" || m.type === st.words).sort((a, b) => b[1].t - a[1].t);
  const groups = ["刚刚", "今天", "昨天", "更早"].map(d => [d, items.filter(([, m]) => dayOf(m.t) === d)]).filter(([, l]) => l.length);
  const col = `
    <div class="lg-head"><h2>生词本</h2><button class="txt-btn" data-act="export">导出</button></div>
    <div class="chips">${[["all", "全部"], ["book", "书库"], ["physical", "查单词"]].map(([k, t]) => `<button data-wf="${k}" aria-pressed="${st.words === k}">${t}</button>`).join("")}</div>
    ${groups.length ? groups.map(([d, l]) => `<div class="sec-s">${d}</div><ul class="list">${l.map(([w, m]) => `<li class="${st.pick === w ? "on" : ""}" data-li="${esc(w)}"><button data-word="${esc(w)}"><span class="lw">${esc(w)}</span><span class="ls">${esc(m.src)}</span><span class="lm">${esc(senseOf(w))}</span></button></li>`).join("")}</ul>`).join("")
      : '<div class="empty">这里还没有词</div>'}`;
  if (st.screen === "inner") {
    v.innerHTML = `<div class="split"><div class="col">${col}</div><div class="pane" id="wpane"></div></div>`;
    renderPane($("#wpane"), saved.has(st.pick) ? st.pick : null, saved.size ? `共 ${saved.size} 个生词` : "");
  } else v.innerHTML = col;
}
function exportCsv() {
  const q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = [["word", "lemma", "phonetic", "meaning", "context_sense", "sentence", "source", "added_at"].join(",")];
  [...saved].sort((a, b) => a[1].t - b[1].t).forEach(([lemma, m]) => {
    const info = lookupWord(lemma);
    rows.push([m.word || lemma, lemma, info.phonetic, senseOf(lemma), m.sense, m.sentence, m.src, new Date(m.t).toISOString()].map(q).join(","));
  });
  const name = N.exportCsv(rows.join("\n") + "\n");
  toast(name ? `已导出 ${saved.size} 个词到 下载/${name}` : "导出失败");
}
if (!CARD) {
  const wv = $("#v-words");
  let sw = null, swiped = false;
  wv.addEventListener("pointerdown", e => { const li = e.target.closest("li[data-li]"); swiped = false; sw = li ? { li, x: e.clientX, y: e.clientY, dx: 0 } : null; });
  wv.addEventListener("pointermove", e => {
    if (!sw) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (!sw.on && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5 && dx < 0) { sw.on = true; sw.li.classList.add("swiping"); }
    if (sw.on) { sw.dx = Math.min(0, dx); sw.li.firstElementChild.style.transform = `translateX(${sw.dx}px)`; }
  });
  const end = () => {
    if (!sw || !sw.on) { sw = null; return; }
    const { li, dx } = sw; sw = null; swiped = true;
    li.classList.remove("swiping"); li.firstElementChild.style.transform = "";
    if (dx < -90) {
      const w = li.dataset.li; li.classList.add("del");
      setTimeout(() => { saved.delete(w); saveSaved(); if (st.pick === w) st.pick = null; renderWords(); toast(`已删除 ${w}`); }, 240);
    }
  };
  wv.addEventListener("pointerup", end); wv.addEventListener("pointercancel", end);
  wv.addEventListener("click", e => {
    if (swiped) { swiped = false; return; }
    const f = e.target.closest("[data-wf]"); if (f) { st.words = f.dataset.wf; renderWords(); return; }
    if (e.target.closest('[data-act="export"]')) { exportCsv(); return; }
    const w = e.target.closest("[data-word]"); if (w) showWord(w.dataset.word, saved.get(w.dataset.word)?.src || "生词本");
  });
}

/* ===================== 单词详情 ===================== */
function wordHTML(info, opts) {
  const { lemma, form, word } = info;
  const isSaved = saved.has(lemma);
  const ctx = opts.sentence && N.hasJev() && senseItems(info).length > 1;
  const trs = opts.sentence && N.hasTr() ? `<button class="icbtn trs" data-trs aria-label="翻译整句">文</button>` : "";
  const saveBtn = info.found ? `<button class="icbtn star${isSaved ? " on" : ""}" data-save="${esc(lemma)}" aria-label="加入生词本">${isSaved ? I.starOn : I.star}</button>` : "";
  const swap = opts.swap ? `<button class="txt-btn" data-swap style="font-size:14px">换边</button>` : "";
  const head = `<div class="wd-h"><div class="grow"><div class="hwt"><div class="hw">${esc(lemma)}</div>${trs}${saveBtn}</div>
      <div class="ph">${info.phonetic ? `<span>/${esc(info.phonetic)}/</span>` : ""}${N.canSpeak() ? `<button class="say" data-say="${esc(lemma)}" aria-label="朗读">${I.speak}</button>` : ""}${form ? `<span class="note">${esc(word)} 的${form}</span>` : ""}</div></div>
      ${swap}${opts.close ? `<button class="x" data-close aria-label="关闭">${I.x}</button>` : ""}</div>`;
  if (!info.found) return `<div class="wd">${head.replace(`<div class="hw">${esc(lemma)}</div>`, `<div class="hw">${esc(word || lemma)}</div>`)}
    <p style="font-size:17px;margin:0;color:var(--muted)">词典里没有 ${esc(word || lemma)}</p></div>`;
  return `<div class="wd">${head}
    ${ctx ? `<div class="ctx loading"><span class="k">本句中</span><span class="v">…</span></div>` : ""}
    <ol class="senses">${info.lines.map(([p, m], i) => `<li data-i="${i}"><span class="pos">${esc(p)}</span><span>${esc(m)}</span></li>`).join("")}</ol></div>`;
}
const ctxCache = new Map(kv.get("ctxcache", []));
async function resolveCtx(root, info, sentence) {
  const c = root.querySelector(".ctx"); if (!c) return null;
  const items = senseItems(info), key = info.lemma + "|" + hash(sentence);
  let choice = ctxCache.get(key);
  if (!choice) {
    try {
      const a = await jevAsk(sentence, { ["sense_" + qid(info.lemma)]: senseQuestion(info.word, items) });
      choice = a["sense_" + qid(info.lemma)]?.choice;
    } catch (e) { choice = null; }
    if (choice) { ctxCache.set(key, choice); kv.set("ctxcache", [...ctxCache].slice(-300)); }
  }
  if (!c.isConnected) return choice;
  if (!choice) { c.remove(); return null; }
  c.classList.remove("loading");
  c.querySelector(".v").textContent = choice;
  const idx = items.find(([s]) => s === choice)?.[1];
  const li = root.querySelector(`.senses li[data-i="${idx}"]`);
  if (li) { li.classList.add("cur"); li.insertAdjacentHTML("beforeend", '<span class="tag">本句</span>'); }
  root.dataset.sense = choice;
  return choice;
}
function renderPane(pane, word, emptyText) {
  if (!word) { pane.innerHTML = `<div class="pane-empty">${esc(emptyText)}</div>`; return; }
  pane.innerHTML = wordHTML(lookupWord(word), {});
  pane.firstElementChild.style.animation = "fadeUp 300ms var(--ease)";
}
function showWord(word, src) {
  const info = lookupWord(word);
  st.pick = info.lemma; st.pickSrc = src;
  if (st.screen === "inner") { render(st.tab); return; }
  openSheet(`<div class="sh-body">${wordHTML(info, { close: true })}</div>`, "lk-card", () => { st.pick = null; });
}
function toggleSave(lemma, src, btn, extra = {}) {
  if (saved.has(lemma)) saved.delete(lemma);
  else {
    saved.set(lemma, Object.assign({ src, type: extra.book ? "book" : "physical", t: Date.now() }, extra));
    toast("已加入生词本");
  }
  saveSaved();
  if (btn) { const on = saved.has(lemma); btn.className = "icbtn star" + (on ? " on" : ""); btn.innerHTML = on ? I.starOn : I.star; }
  markSaved();
  if (!st.book && st.tab === "words" && st.screen === "outer" && !CARD) renderWords();
}
scr.addEventListener("click", e => {
  const s = e.target.closest("[data-say]"); if (s) { speak(s.dataset.say); return; }
  const targetSave = e.target.closest("[data-target-save]");
  if (targetSave && activeTarget) { toggleTargetSave(activeTarget, targetSave.dataset.targetSave, targetSave); return; }
  const targetShare = e.target.closest("[data-target-share]");
  if (targetShare && activeTarget) { shareExcerpt(targetShare); return; }
  const exRatio = e.target.closest("[data-ex-ratio]");
  if (exRatio && excerptState) {
    excerptState.ratio = exRatio.dataset.exRatio;
    settings.excerptRatio = excerptState.ratio; kv.set("settings", settings);
    $$("[data-ex-ratio]", sheet).forEach(b => b.setAttribute("aria-pressed", b.dataset.exRatio === excerptState.ratio));
    renderExcerptPreview();
    return;
  }
  if (e.target.closest("[data-ex-cancel]")) { closeSheet(); return; }
  if (e.target.closest("#ex-share") && excerptState) { if (excerptState.dataUrl) N.shareCard(excerptState.dataUrl); return; }
  if (e.target.closest("[data-trs]") && R) { const hl = $(".w.hl", R.flow); translateInBook(st.lkSentence, rectIn(hl || R.lk), null, hl && blockText(hl)); return; }
  const v = e.target.closest("[data-save]");
  if (v) {
    const lk = v.closest(".lk");
    if (st.book && lk) {
      toggleSave(v.dataset.save, st.book.title, v, { book: st.book.id, pos: R ? { ch: R.ch, off: R.lkOff ?? anchorOffset() } : null,
        sentence: st.lkSentence || "", sense: lk.querySelector(".wd")?.dataset.sense || "", word: st.lkWord || v.dataset.save });
    } else toggleSave(v.dataset.save, st.book ? st.book.title : (st.pickSrc || "查单词"), v, { word: v.dataset.save });
  }
});

/* ===================== 阅读器 ===================== */
let R = null;
const bookUrl = (id, path) => `/book/${id}/${path.split("/").map(encodeURIComponent).join("/")}`;
/* ---------- 原书样式：参照 ReadiumCSS 的做法，保留原书的版式（对齐、缩进、小型大写、间距、图片宽度），
   去掉与阅读设置冲突的属性（字体、字号基准、颜色、行高、页面定位），选择器限定在书页内 ---------- */
const FS_KW = { "xx-small": ".6em", "x-small": ".75em", small: ".89em", medium: "1em", large: "1.2em", "x-large": "1.5em", "xx-large": "2em" };
const DROP_PROP = /^(color|background|position|top|left|right|bottom|inset|z-index|overflow|height|min-height|max-height|columns?|column-|widows|orphans|hyphens|font-family|transform|filter|box-shadow|text-shadow|outline|cursor|pointer-events|user-select|transition|animation|mix-blend|-webkit-|-epub-|adobe-)/;
function cleanDecl(s, root, isP) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const p = s.item(i); let v = s.getPropertyValue(p);
    if (p === "font-family") { if (/mono|courier|consol/i.test(v)) out += "font-family:monospace;"; continue; }
    if (DROP_PROP.test(p) || p.endsWith("-color")) continue;
    if (root && /^(font-size|line-height|margin|padding|text-indent|width|max-width)/.test(p)) continue;
    if (p === "font-size") v = FS_KW[v] || v.replace(/^([\d.]+)(px|pt)$/, (_, n, u) => +(n / (u === "pt" ? 12 : 16)).toFixed(3) + "em");
    if (p === "text-align" && /^(justify|left|start|-webkit-auto|auto)$/.test(v)) continue;
    if (/^break-(before|after)$/.test(p) && /^(page|always|left|right|recto|verso)$/.test(v)) v = "column";
    out += `${p}:${v};`;
  }
  // 段落用了段间距却没写缩进时，去掉默认的首行缩进：段间距和缩进只用一种
  if (isP && !s.textIndent && /^margin-(top|bottom):(?!0(px|em|rem|%)?$)/m.test(out.replace(/;/g, "\n"))) out += "text-indent:0;";
  return out;
}
function splitSel(sel) {
  const out = []; let d = 0, cur = "";
  for (const c of sel) { if (c === "(" || c === "[") d++; else if (c === ")" || c === "]") d--; if (c === "," && !d) { out.push(cur); cur = ""; } else cur += c; }
  return out.concat(cur).map(s => s.trim()).filter(Boolean);
}
// 每个样式表只作用于引用它的章节（合集里各卷的样式表互不相同）：章节容器带上样式表的类名 sid
function scopeRules(rules, out, sid) {
  for (const r of rules) {
    if (r instanceof CSSStyleRule) {
      let root = true;
      const sels = splitSel(r.selectorText).map(s => {
        s = s.replace(/^(html|:root)\b\s*/i, "").replace(/(^|[\s>+~])body\b/gi, "$1.bk-body");
        if (!/^\.bk-body(\.[\w-]+|#[\w-]+)*$/.test(s || ".bk-body")) root = false;
        s = s || ".bk-body";
        return s.startsWith(".bk-body") ? `.rd-flow .${sid}${s.slice(8)}` : `.rd-flow .${sid} ${s}`;
      });
      const decl = cleanDecl(r.style, root, /(^|[\s>+~])p(\.[\w-]+)*$/i.test(r.selectorText.split(",").pop().trim()));
      if (decl) out.push(`${sels.join(",")}{${decl}}`);
    } else if (r instanceof CSSMediaRule) { if (matchMedia(r.conditionText).matches) scopeRules(r.cssRules, out, sid); }
    else if (r instanceof CSSSupportsRule) { if (CSS.supports(r.conditionText)) scopeRules(r.cssRules, out, sid); }
  }
  return out;
}
function scopeCss(text, sid) {
  const c = new CSSStyleSheet();
  try { c.replaceSync(text); } catch { return ""; }
  return scopeRules(c.cssRules, [], sid).join("\n");
}
const cssCache = new Map(), sheetIds = new Map();
const sidOf = k => sheetIds.get(k) || (sheetIds.set(k, "bk-s" + sheetIds.size), sheetIds.get(k));
function sheetsOf(doc, base, url) {
  const linked = $$('link[rel~="stylesheet"][href]', doc).map(l => {
    const href = new URL(l.getAttribute("href"), base).href, sid = sidOf(href);
    if (!cssCache.has(href)) cssCache.set(href, fetch(href).then(r => r.text()).then(t => scopeCss(t, sid)).catch(() => ""));
    return cssCache.get(href).then(t => [href, t, sid]);
  });
  const inline = $$("style", doc).map((s, i) => { const k = url + "#style" + i, sid = sidOf(k); return Promise.resolve([k, scopeCss(s.textContent, sid), sid]); });
  return Promise.all(linked.concat(inline));
}
const injected = new Set();
function injectCss(sheets) {
  for (const [k, t] of sheets) {
    if (!t || injected.has(k)) continue;
    injected.add(k);
    const s = document.createElement("style"); s.className = "bk-css"; s.textContent = t; document.head.append(s);
  }
}
function dropBookCss() { $$("style.bk-css").forEach(s => s.remove()); injected.clear(); }

// 关闭原书排版时只保留图片的百分比宽度（如章首小花饰），否则小图会被拉满整栏
async function keepImageWidths(doc, body, base) {
  const sheets = await Promise.all($$('link[rel~="stylesheet"][href]', doc).map(l =>
    fetch(new URL(l.getAttribute("href"), base).href).then(r => r.text()).then(t => { const c = new CSSStyleSheet(); c.replaceSync(t); return c; }).catch(() => null)));
  $$("style", doc).forEach(s => { const c = new CSSStyleSheet(); c.replaceSync(s.textContent); sheets.push(c); });
  const pct = (v) => /^[\d.]+%$/.test(v) ? parseFloat(v) : null;
  const widthOf = (st) => {
    const w = pct(st.width) ?? pct(st.maxWidth);
    if (w != null) return w;
    const l = pct(st.marginLeft), r = pct(st.marginRight);
    return l != null && r != null ? 100 - l - r : null;
  };
  const set = (n, w) => {
    if (w == null || w <= 0 || w >= 100) return;
    const imgs = n.localName === "img" ? [n] : !n.textContent.trim() ? $$("img", n) : [];
    imgs.forEach(img => img.dataset.w = w);
  };
  for (const c of sheets) for (const r of c?.cssRules || []) {
    if (!r.selectorText || !r.style) continue;
    const w = widthOf(r.style);
    if (w != null) try { $$(r.selectorText, body).forEach(n => set(n, w)); } catch {}
  }
  $$("[style]", body).forEach(n => set(n, widthOf(n.style)));
  $$("[style]", body).forEach(n => n.removeAttribute("style"));
  $$("img[data-w]", body).forEach(img => img.setAttribute("style", `max-width:${img.dataset.w}%`));
}

const epubType = n => (n.getAttribute("epub:type") || n.getAttributeNS?.("http://www.idpf.org/2007/ops", "type") || "") + " " + (n.getAttribute("role") || "");
function isNoteRef(a) {
  if (/noteref/.test(epubType(a))) return true;
  const t = a.textContent.trim();
  return t.length <= 6 && /^[\[(]?(\d{1,3}|[*†‡§¶]+|[ivx]{1,4})[\])]?$/i.test(t) && (!!a.closest("sup") || /\d/.test(t) || /[*†‡§¶]/.test(t));
}

async function parseChapter(i, pub) {
  const id = st.book.id, url = bookUrl(id, st.book.spine[i]);
  const txt = await (await fetch(url)).text();
  let doc = new DOMParser().parseFromString(txt, "application/xhtml+xml");
  if (doc.querySelector("parsererror") || !doc.body) doc = new DOMParser().parseFromString(txt, "text/html");
  const body = doc.body || doc.documentElement;
  const base = new URL(url, location.href);
  let sheets = [];
  if (pub) {
    sheets = await sheetsOf(doc, base, url);
    $$("[style]", body).forEach(n => { const d = cleanDecl(n.style, false, n.localName === "p"); d ? n.setAttribute("style", d) : n.removeAttribute("style"); });
  } else await keepImageWidths(doc, body, base);
  $$("script, style, link, meta, title, iframe, object, embed", body).forEach(n => n.remove());
  $$("[src]", body).forEach(n => n.setAttribute("src", new URL(n.getAttribute("src"), base).href));
  $$("image", body).forEach(n => {
    const h = n.getAttribute("xlink:href") || n.getAttribute("href");
    if (h) { const abs = new URL(h, base).href; n.setAttribute("href", abs); n.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", abs); }
  });
  // 书内链接改成（章节，锚点）；注释链接点开浮层，其余链接跳转
  const spineIdx = new Map(st.book.spine.map((p, k) => [new URL(bookUrl(id, p), location.href).href, k]));
  $$("a[href]", body).forEach(a => {
    const u = new URL(a.getAttribute("href"), base), frag = decodeURIComponent(u.hash.slice(1)); u.hash = "";
    a.removeAttribute("href");
    const ch = spineIdx.get(u.href); if (ch == null) return;
    a.dataset.ch = ch; if (frag) a.dataset.frag = frag;
    if (frag && isNoteRef(a)) a.classList.add("nref");
  });
  $$("aside", body).forEach(n => { if (/footnote|rearnote|endnote/.test(epubType(n))) n.classList.add("fn-aside"); });
  // 文件开头本来就是新的一页：正文出现之前的元素上的强制分页去掉，否则会多出一个空白页
  const lead = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n; (n = lead.nextNode());) {
    if (n.nodeType === 3 ? n.nodeValue.trim() : /^(img|svg|image|hr)$/i.test(n.localName)) break;
    if (n.nodeType === 1) n.classList.add("rd-lead");
  }
  // 一个文件里有多章时，前面已有正文的章节标题另起一页
  let count = 0;
  const tw = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    if (n.nodeType === 3) count += n.nodeValue.trim().length;
    else if (/^h[12]$/i.test(n.localName)) { if (count > 150) n.classList.add("brk"); count = -1e9; }
    else if (count < 0 && n.localName === "p") count = 0;
  }
  // 只有一张图的页（插图、地图、封面）单独占一页，垂直居中
  const solo = body.textContent.trim().length < 40 && $$("img, svg", body).filter(n => !n.closest("svg") || n.localName === "svg").length === 1;
  const cls = ["bk-body", body.getAttribute("class") || "", solo ? "solo" : "", ...sheets.map(x => x[2])].join(" ").trim();
  const bid = body.getAttribute("id");
  const html = `<div class="${esc(cls)}"${bid ? ` id="${esc(bid)}"` : ""}>${body.innerHTML}</div>`;
  return { html, sheets, dropcap: !sheets.some(([, t]) => /first-letter|drop-?cap/i.test(t)) };
}
const chCache = new Map();
async function chapterHTML(i) {
  const key = st.book.id + ":" + i + ":" + (st.pub ? 1 : 0);
  if (!chCache.has(key)) { const p = parseChapter(i, st.pub); chCache.set(key, p); p.catch(() => chCache.delete(key)); }
  const c = await chCache.get(key);
  injectCss(c.sheets);
  if (R && !c.dropcap) R.r.removeAttribute("data-dropcap");
  return c.html;
}
// 一个 spine 文件里可能有好几章：按目录锚点所在的页确定当前章节
function tocPage(e) {
  if (R && e.ch === R.ch) return R.marks?.get(e.frag) ?? 0;
  return R?.fragPages?.[e.ch]?.[e.frag] ?? 0;
}
function tocIndexAt(ch, page) {
  let idx = -1;
  (st.book.toc || []).forEach((e, i) => { if (e.ch < ch || (e.ch === ch && tocPage(e) <= page)) idx = i; });
  return idx;
}
function chapterTitle(ch, page = 1e9) {
  const i = tocIndexAt(ch, page);
  return i >= 0 ? st.book.toc[i].t : st.book.title;
}
function fragPagesOf(flow, ch) {
  const out = {};
  for (const e of st.book.toc || []) {
    if (e.ch !== ch || !e.frag) continue;
    const t = flow.querySelector("#" + CSS.escape(e.frag));
    if (t) { const fr = flow.getBoundingClientRect(), r = t.getBoundingClientRect(); out[e.frag] = Math.max(0, Math.floor((r.left - fr.left + 2) / R.step)); }
  }
  return out;
}
async function openBook(id, coverEl) {
  const b = BOOKS.find(x => x.id === id); if (!b || st.busy) return;
  clearTurnQueue();
  const t0 = performance.now();
  // Gutenberg 等会把纸书页码（如 {32}）也写进目录，去掉
  if (b.toc) b.toc = b.toc.filter(e => !/^[\[{]\d+[\]}]$/.test(e.t.trim()));
  st.book = b;
  const pr = progOf(id); pr.opened = Date.now(); if (pr.status !== "done") pr.status = "reading"; saveProg();
  const r = el("div", "reader"); r.dataset.theme = st.theme; r.dataset.font = st.font; r.dataset.dropcap = ""; applyTypo(r);
  r.innerHTML = `
    <div class="rd-clip"><div class="rd-flow" lang="${esc(b.lang || "en")}"></div></div>
    <div class="rd-clip measure"><div class="rd-flow" lang="${esc(b.lang || "en")}"></div></div>
    <div class="rd-spine"></div><div class="ribbon"></div>
    <div class="rd-run head L"></div><div class="rd-run head R"></div><div class="rd-run foot L"></div><div class="rd-run foot R"></div>
    <div class="rd-turn"></div>
    <div class="rd-ui rd-topbar"><button class="rbtn" data-r="close" aria-label="关闭图书">${I.x}</button><button class="rbtn" data-r="bm" aria-label="书签">${I.bm}</button></div>
    <div class="rd-ui rd-botbar"><span style="width:40px"></span><span class="rd-pos"></span><button class="rbtn" data-r="menu" aria-label="菜单">${I.menu}</button></div>
    <div class="rmenu">
      <button data-r="toc"><span>目录</span><span class="sub" id="rm-pos"></span>${I.list}</button>
      <button data-r="find"><span>查单词</span>${I.search}</button>
      <button data-r="themes"><span>主题与设置</span>${I.aa}</button>
      <button data-r="bookwords"><span>本书生词</span><span class="sub" id="rm-count"></span>${I.star}</button>
    </div>
    <button class="rd-back" data-r="back" hidden>返回原处</button>
    <div class="lk" role="dialog"></div>`;
  if (st.kb) N.keyboard(false);
  document.activeElement?.blur?.();
  scr.appendChild(r); scr.classList.add("reading");
  N.reading(true); N.bars(false, true);
  const clips = $$(".rd-clip", r);
  R = { r, clip: clips[0], flow: $(".rd-flow", clips[0]), mclip: clips[1], mflow: $(".rd-flow", clips[1]), turn: $(".rd-turn", r), lk: $(".lk", r), menu: $(".rmenu", r),
    ch: 0, page: 0, pages: 1, counts: null, tnDirty: true, wordNodes: null, wordNodeIndex: null, wordRects: null };
  bindReader();
  if (coverEl && !reduced) zoomFromCover(coverEl, r);
  else r.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: "ease-out" });
  await document.fonts.ready;
  await loadChapter(Math.min(pr.ch || 0, b.spine.length - 1), { off: pr.off || 0 });
  N.perf("open_book", Math.round(performance.now() - t0));
  setTimeout(measureAll, 400);
}
function rectIn(elm) { const a = elm.getBoundingClientRect(), s = scr.getBoundingClientRect(); return { x: a.left - s.left, y: a.top - s.top, w: a.width, h: a.height }; }
function zoomFromCover(coverEl, r) {
  const c = rectIn(coverEl), [W, H] = dims();
  const ghost = coverEl.cloneNode(true); ghost.style.cssText += `;position:absolute;z-index:55;left:0;top:0;width:${c.w}px;height:${c.h}px;transform-origin:0 0;margin:0`;
  scr.appendChild(ghost);
  r.style.opacity = "0"; st.busy = true;
  ghost.animate([{ transform: `translate(${c.x}px,${c.y}px) scale(1)` }, { transform: `translate(0,0) scale(${W / c.w},${H / c.h})` }], { duration: 540, easing: "cubic-bezier(.3,.7,.1,1)", fill: "forwards" });
  r.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 320, easing: "ease-out", fill: "forwards" }).finished.then(() => { r.style.opacity = ""; r.getAnimations().forEach(a => a.cancel()); ghost.remove(); st.busy = false; });
}
function closeBook() {
  if (!R) return;
  clearTurnQueue();
  if (st.busy) return;
  const b = st.book; savePos(true);
  const r = R.r; st.busy = true;
  hideLookup(); R.menu.classList.remove("on"); r.classList.remove("ui");
  scr.classList.remove("reading", "ui");
  N.reading(false); N.bars(true, !darkUI());
  if (st.tab !== "library") setTab("library", false); else renderLibrary();
  const target = $(`#v-library [data-open="${b.id}"] .cover`);
  const done = () => { r.remove(); R = null; st.book = null; st.busy = false; dropBookCss(); };
  if (!target || reduced) { r.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-out", fill: "forwards" }).finished.then(done); return; }
  const c = rectIn(target), [W, H] = dims();
  const ghost = target.cloneNode(true); ghost.style.cssText += `;position:absolute;z-index:55;left:0;top:0;width:${c.w}px;height:${c.h}px;transform-origin:0 0`;
  scr.appendChild(ghost);
  r.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-out", fill: "forwards" });
  ghost.animate([{ transform: `translate(0,0) scale(${W / c.w},${H / c.h})`, opacity: 0 }, { opacity: 1, offset: .25 }, { transform: `translate(${c.x}px,${c.y}px) scale(1)`, opacity: 1 }], { duration: 480, easing: "cubic-bezier(.3,.7,.1,1)", fill: "forwards" })
    .finished.then(() => { ghost.remove(); done(); });
}

/* ---------- 分页 ---------- */
function geometry() {
  const [W, H] = dims();
  const spread = spreadAvailable() && st.spread;
  const side = { s: [20, 40], m: [30, 60], l: [44, 84] }[st.margin][spread ? 1 : 0];
  const g = spread ? { top: 58, bottom: 52, side, gap: 84 } : { top: 60, bottom: 52, side, gap: 60 };
  // 单页时限制行长，每行约 65–75 个字符
  if (!spread) g.side = Math.max(side, (W - st.size * 34) / 2);
  const headY = Math.max(24, sat() - 4);
  g.top = Math.max(g.top, headY + 34);
  return { W, H, spread, g, headY };
}
function layout(anchor, opts = {}) {
  const { W, H, spread, g, headY } = geometry();
  const clipW = W - g.side * 2, clipH = H - g.top - g.bottom;
  const pageW = spread ? (clipW - g.gap) / 2 : clipW;
  Object.assign(R, { W, H, spread, clipL: g.side, clipT: g.top, clipW, clipH, pageW, gap: g.gap, step: pageW + g.gap, headY });
  R.r.style.setProperty("--clip-h", clipH * 0.9 + "px"); R.r.style.setProperty("--page-h", clipH + "px");
  for (const [clip, flow] of [[R.clip, R.flow], [R.mclip, R.mflow]]) {
    Object.assign(clip.style, { left: g.side + "px", top: g.top + "px", width: clipW + "px", height: clipH + "px" });
    Object.assign(flow.style, { width: clipW + "px", columnCount: spread ? 2 : 1, columnGap: g.gap + "px", transform: "translateX(0)" });
  }
  $(".rd-spine", R.r).style.display = spread ? "" : "none";
  const runs = { "head.L": [g.side, headY], "head.R": [g.side + pageW + g.gap, headY], "foot.L": [g.side, H - 34], "foot.R": [g.side + pageW + g.gap, H - 34] };
  Object.entries(runs).forEach(([k, [x, y]]) => {
    const e = $(".rd-run." + k, R.r);
    Object.assign(e.style, { left: x + "px", top: y + "px", width: (spread ? pageW : clipW) + "px", display: !spread && k.endsWith("R") ? "none" : "" });
  });
  $(".ribbon", R.r).style.left = (W - g.side - 26) + "px";
  R.tnDirty = true;
  R.wordNodes = null; R.wordNodeIndex = null; R.wordRects = null;
  R.pages = pageOf($(".end", R.flow)) + 1;
  if (spread && R.pages % 2) R.pages += 1;
  R.marks = new Map(Object.entries(fragPagesOf(R.flow, R.ch)));
  let p = 0;
  if (opts.last) p = R.pages - 1;
  else if (opts.frag) { const t = R.flow.querySelector("#" + CSS.escape(opts.frag)); p = t ? pageOf(t) : 0; }
  else if (opts.page != null) p = opts.page;
  else if (anchor != null) p = pageForOffset(anchor);
  setPage(Math.max(0, Math.min(p, R.pages - 1)));
}
function relayout() { if (!R) return; const a = anchorOffset(); layout(a); }
async function loadChapter(ch, opts = {}) {
  const html = await chapterHTML(ch);
  if (!R) return;
  R.flow.innerHTML = `<section class="ch">${html}</section><span class="end"></span>`;
  R.ch = ch; R.tnDirty = true; R.wordNodes = null; R.wordNodeIndex = null; R.wordRects = null;
  markSaved();
  layout(opts.off ?? null, opts);
  // 图片加载完成后版面会变，按当前位置重新分页
  $$("img, image", R.flow).forEach(img => { if (img.tagName === "IMG" && img.complete) return; img.addEventListener("load", relayoutSoon, { once: true }); });
  $$("img", R.flow).forEach(classifyImg);
  [ch + 1, ch - 1].forEach(i => { if (i >= 0 && i < st.book.spine.length) chapterHTML(i); });
}
// 线稿图（花饰、地图、图表）四周是白底且几乎没有颜色：浅色主题里融进底色，深色主题里反相
const imgKind = new Map();
function classifyImg(img) {
  const go = () => {
    let k = imgKind.get(img.src);
    if (!k) {
      try {
        const N = 24, c = document.createElement("canvas"); c.width = c.height = N;
        const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, N, N);
        const d = x.getImageData(0, 0, N, N).data; let edge = 0, light = 0, sat = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]), px = (i / 4) % N, py = (i / 4 / N) | 0;
          sat += d[i + 3] < 20 ? 0 : mx - mn;
          if (px === 0 || py === 0 || px === N - 1 || py === N - 1) { edge++; if (d[i + 3] < 20 || mn > 225) light++; }
        }
        k = light / edge > 0.6 && sat / (N * N) < 24 ? "im-line" : "im-photo";
      } catch { k = "im-photo"; }
      imgKind.set(img.src, k);
    }
    img.classList.add(k);
  };
  if (img.complete && img.naturalWidth) go(); else img.addEventListener("load", go, { once: true });
}
let relayoutT;
function relayoutSoon() { clearTimeout(relayoutT); relayoutT = setTimeout(() => { if (!R) return; if (st.busy || R.lk.classList.contains("on")) relayoutSoon(); else relayout(); }, 120); }
function pageOf(e) {
  const fr = R.flow.getBoundingClientRect(), r = e.getBoundingClientRect();
  return Math.max(0, Math.floor((r.left - fr.left + 2) / R.step));
}

// 位置按（章节，章内字符偏移）保存：用文本节点和 Range 的位置算出字符所在的页
function tindex() {
  if (!R.tnDirty) return R.tn;
  const tn = []; let acc = 0;
  const w = document.createTreeWalker(R.flow, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) { const L = n.nodeValue.length; if (n.nodeValue.trim()) tn.push([n, acc]); acc += L; }
  R.tn = tn; R.tnDirty = false;
  return tn;
}
function rectAt(n, i) {
  const t = n.nodeValue;
  while (i < t.length - 1 && /\s/.test(t[i])) i++;
  const r = document.createRange(); r.setStart(n, i); r.setEnd(n, Math.min(i + 1, t.length));
  return r.getClientRects()[0] || r.getBoundingClientRect();
}
function pageAtRect(rc) { const fr = R.flow.getBoundingClientRect(); return Math.max(0, Math.floor((rc.left - fr.left + 2) / R.step)); }
function anchorOffset() {
  if (!R) return 0;
  const tn = tindex(); if (!tn.length) return 0;
  let lo = 0, hi = tn.length - 1, ans = tn.length;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pageAtRect(rectAt(tn[m][0], 0)) >= R.page) { ans = m; hi = m - 1; } else lo = m + 1; }
  const prev = tn[ans - 1];
  if (prev) {
    const [n, acc] = prev, L = n.nodeValue.length;
    if (pageAtRect(rectAt(n, L - 1)) >= R.page) {
      let a = 0, b = L - 1;
      while (a < b) { const m = (a + b) >> 1; if (pageAtRect(rectAt(n, m)) >= R.page) b = m; else a = m + 1; }
      return acc + a;
    }
  }
  return ans >= tn.length ? tn[tn.length - 1][1] : tn[ans][1];
}
function pageForOffset(off) {
  const tn = tindex(); if (!tn.length) return 0;
  let lo = 0, hi = tn.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (tn[m][1] <= off) { ans = m; lo = m + 1; } else hi = m - 1; }
  const [n, acc] = tn[ans];
  return pageAtRect(rectAt(n, Math.max(0, Math.min(n.nodeValue.length - 1, off - acc))));
}

/* ---------- 全书页码：后台逐章分页，结果按书、字号、字体、屏幕缓存 ---------- */
const measureKey = () => [st.size, st.font, st.theme === "bold", R.W, R.H, R.spread, st.lh, st.margin, st.justify, st.pub].join("|");
async function measureAll() {
  if (!R) return;
  const key = measureKey(), cached = kv.get("pages:" + st.book.id, null);
  if (cached && cached.fragPages && cached.key === key && cached.counts.length === st.book.spine.length) { R.counts = cached.counts; R.fragPages = cached.fragPages; setPage(R.page); return; }
  const token = R.measureToken = {}, counts = [], fragPages = [], book = st.book;
  for (let i = 0; i < book.spine.length; i++) {
    if (!R || st.book !== book || R.measureToken !== token) return;
    const html = await chapterHTML(i);
    if (!R || R.measureToken !== token) return;
    R.mflow.innerHTML = `<section class="ch">${html}</section><span class="end"></span>`;
    const fr = R.mflow.getBoundingClientRect(), er = $(".end", R.mflow).getBoundingClientRect();
    let n = Math.max(0, Math.floor((er.left - fr.left + 2) / R.step)) + 1;
    if (R.spread && n % 2) n++;
    counts.push(n); fragPages.push(fragPagesOf(R.mflow, i));
    if (i % 4 === 3) await wait(0);
  }
  R.mflow.innerHTML = "";
  R.counts = counts; R.fragPages = fragPages;
  kv.set("pages:" + book.id, { key, counts, fragPages });
  if (!st.busy) setPage(R.page);
}
function invalidatePages() { if (!R) return; R.counts = null; R.measureToken = null; setTimeout(measureAll, 300); }
function globalStart(ch) { let s = 0; for (let i = 0; i < ch; i++) s += R.counts[i]; return s; }
function totalPages() { return R.counts.reduce((a, b) => a + b, 0) - R.counts[R.ch] + R.pages; }

function runText(p, side) {
  if (p < 0 || p >= R.pages) return { head: "", foot: "" };
  return {
    head: p === 0 || [...R.marks.values()].includes(p) ? "" : (R.spread && side === "L" ? st.book.title : chapterTitle(R.ch, p)),
    foot: R.counts ? String(globalStart(R.ch) + p + 1) : ""
  };
}
function setPage(p) {
  R.page = R.spread ? p - (p % 2) : p;
  // 翻页只改 flow 的 transform，按词缓存的 client rects 会留在上一页的位置；
  // 不清掉的话下一次 wordAt() 会按旧坐标命中失败（长按有震动但查不出词）。
  R.wordNodes = null; R.wordNodeIndex = null; R.wordRects = null;
  R.flow.style.transform = `translateX(${-R.page * R.step}px)`;
  R.marks = new Map(Object.entries(fragPagesOf(R.flow, R.ch)));
  const L = runText(R.page, "L"), Rr = runText(R.page + 1, "R");
  $(".rd-run.head.L", R.r).textContent = L.head; $(".rd-run.foot.L", R.r).textContent = L.foot;
  $(".rd-run.head.R", R.r).textContent = R.spread ? Rr.head : ""; $(".rd-run.foot.R", R.r).textContent = R.spread ? Rr.foot : "";
  const span = R.spread ? 2 : 1, lastInCh = Math.min(R.pages, R.page + span);
  let pos;
  if (R.counts) {
    const g = globalStart(R.ch) + R.page, total = totalPages(), last = Math.min(total, g + span), left = total - last;
    pos = `${R.spread ? `${g + 1}–${last}` : g + 1} / ${total}${left ? `，本书还剩 ${left} 页` : ""}`;
  } else pos = R.pages - lastInCh ? `本章还剩 ${R.pages - lastInCh} 页` : "本章最后一页";
  $(".rd-pos", R.r).textContent = pos;
  const marked = (bookmarks[st.book.id] || []).some(m => m.ch === R.ch && Math.abs(pageForOffset(m.off) - R.page) < span);
  R.r.classList.toggle("bm", marked);
  $('[data-r="bm"]', R.r).innerHTML = marked ? I.bmOn : I.bm;
  savePos();
}
let saveT;
function savePos(now) {
  clearTimeout(saveT);
  const f = () => {
    if (!R) return;
    const pr = progOf(st.book.id);
    pr.ch = R.ch; pr.off = anchorOffset();
    pr.progress = R.counts ? Math.min(1, (globalStart(R.ch) + R.page + (R.spread ? 2 : 1)) / totalPages())
      : Math.min(1, (R.ch + (R.page + 1) / R.pages) / st.book.spine.length);
    saveProg();
  };
  if (now) f(); else saveT = setTimeout(f, 400);
}

/* ---------- 翻页 ---------- */
function sheetFor(p, side) {
  const s = el("div", "rd-sheet" + (R.spread ? " " + side : ""));
  s.style.width = (R.spread ? R.W / 2 : R.W) + "px";
  if (p < 0 || p >= R.pages) return s;
  const x = side === "R" ? R.clipL + R.pageW + R.gap - R.W / 2 : R.clipL;
  const clip = el("div", "clip"); Object.assign(clip.style, { left: x + "px", top: R.clipT + "px", width: R.pageW + "px", height: R.clipH + "px" });
  const f = R.flow.cloneNode(true); f.style.transform = `translateX(${-p * R.step}px)`;
  clip.appendChild(f); s.appendChild(clip);
  const t = runText(p, side);
  [[t.head, R.headY], [t.foot, R.H - 34]].forEach(([txt, y]) => { const e = el("div", "rd-run"); e.textContent = txt; Object.assign(e.style, { left: x + "px", top: y + "px", width: R.pageW + "px" }); s.append(e); });
  return s;
}
function viewFor(p) {
  const v = el("div"); v.style.cssText = `position:absolute;top:0;left:0;width:${R.W}px;height:100%`;
  if (R.spread) { const l = sheetFor(p, "L"), r = sheetFor(p + 1, "R"); l.style.left = "0px"; r.style.left = R.W / 2 + "px"; v.append(l, r); }
  else { const s = sheetFor(p, "S"); s.style.left = "0px"; v.append(s); }
  return v;
}
const animOff = () => reduced || N.animScale?.() === 0;
const turnQueue = [];
let turnRunner = null;
function clearTurnQueue() {
  while (turnQueue.length) turnQueue.shift().resolve();
}
function queueTurn(dir) {
  return new Promise(resolve => {
    if (!R) { resolve(); return; }
    if (turnQueue.length >= 12) { resolve(); return; }
    turnQueue.push({ dir, resolve });
    if (!turnRunner) turnRunner = runTurnQueue();
  });
}
async function runTurnQueue() {
  try {
    while (turnQueue.length && R) {
      const job = turnQueue.shift();
      await animateTurn(job.dir, turnQueue.length > 0);
      job.resolve();
    }
  } finally {
    clearTurnQueue(); turnRunner = null;
  }
}
function turn(dir) { return queueTurn(dir); }
async function animateTurn(dir, fast = false) {
  if (!R) return;
  if (R.back && ++R.back.turns > 3) clearBack();
  const stepN = R.spread ? 2 : 1, to = R.page + dir * stepN;
  const sameCh = to >= 0 && to < R.pages;
  if (!sameCh && (R.ch + dir < 0 || R.ch + dir >= st.book.spine.length)) {
    R.flow.animate([{ translate: "0" }, { translate: `${-dir * 14}px` }, { translate: "0" }], { duration: 320, easing: "ease-out" }); return;
  }
  hideLookup(); R.r.classList.remove("ui"); scr.classList.remove("ui"); R.menu.classList.remove("on"); N.bars(false, true);
  const go = async () => { if (sameCh) setPage(to); else await loadChapter(R.ch + dir, dir > 0 ? { page: 0 } : { last: true }); };
  const mode = animOff() ? "none" : st.turn;
  st.busy = true;
  const layer = R.turn; layer.innerHTML = "";
  try {
    if (mode === "none") await go();
    else if (mode === "fade") {
      const v = viewFor(R.page); layer.append(v); await go();
      await v.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fast ? 180 : 320, easing: "ease-out", fill: "forwards" }).finished;
    } else if (mode === "slide") {
      const strip = el("div"); strip.style.cssText = "position:absolute;inset:0";
      strip.append(viewFor(R.page)); layer.append(strip);
      await go();
      const b = viewFor(R.page); b.style.left = dir * R.W + "px"; strip.append(b);
      await strip.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-dir * R.W}px)` }], { duration: fast ? 240 : 420, easing: "cubic-bezier(.22,.8,.2,1)", fill: "forwards" }).finished;
    } else await curl(dir, go, fast ? 280 : 450);
  } finally { layer.innerHTML = ""; st.busy = false; }
}
async function curl(dir, go, duration) {
  const layer = R.turn, D = duration, ease = "cubic-bezier(.42,.05,.2,1)";
  const flip = el("div", "rd-flip"), from = R.page;
  const coverV = viewFor(from); layer.append(coverV); // 换章时新内容加载期间先盖住旧页
  let front, back, under, hingeLeft, keys, castOn;
  if (R.spread) {
    const half = R.W / 2; flip.style.width = half + "px";
    if (dir > 0) {
      const fromL = sheetFor(from, "L"); front = sheetFor(from + 1, "R");
      await go(); const to = R.page;
      under = [[fromL, 0], [sheetFor(to + 1, "R"), half]]; back = sheetFor(to, "L"); flip.style.left = half + "px"; hingeLeft = true; keys = [0, -180]; castOn = under[1][0];
    } else {
      front = sheetFor(from, "L"); const fromR = sheetFor(from + 1, "R");
      await go(); const to = R.page;
      under = [[sheetFor(to, "L"), 0], [fromR, half]]; back = sheetFor(to + 1, "R"); flip.style.left = "0px"; hingeLeft = false; keys = [0, 180]; castOn = under[0][0];
    }
  } else {
    flip.style.left = "0px"; flip.style.width = R.W + "px"; hingeLeft = true; back = sheetFor(-1, "S");
    if (dir > 0) { front = sheetFor(from, "S"); await go(); under = [[sheetFor(R.page, "S"), 0]]; keys = [0, -180]; }
    else { const cur = sheetFor(from, "S"); await go(); under = [[cur, 0]]; front = sheetFor(R.page, "S"); keys = [-180, 0]; }
    castOn = under[0][0];
  }
  flip.style.transformOrigin = hingeLeft ? "left center" : "right center";
  under.forEach(([s, x]) => { s.style.left = x + "px"; layer.append(s); });
  back.classList.add("back"); flip.append(front, back); layer.append(flip);
  coverV.remove();
  const opening = keys[0] === 0;
  const shade = (sheetEl, deg, frames) => { const s = el("div", "shade"); s.style.background = `linear-gradient(${deg}deg, var(--r-shade), transparent 80%)`; sheetEl.append(s); s.animate(frames, { duration: D, easing: ease, fill: "forwards" }); };
  shade(front, hingeLeft ? 90 : 270, opening ? [{ opacity: 0 }, { opacity: 1, offset: .5 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0 }]);
  shade(back, hingeLeft ? 270 : 90, [{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0 }]);
  shade(castOn, hingeLeft ? 90 : 270, opening ? [{ opacity: .9 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: .8, offset: .6 }, { opacity: 0 }]);
  await flip.animate([{ transform: `rotateY(${keys[0]}deg)` }, { transform: `rotateY(${keys[1]}deg)` }], { duration: D, easing: ease, fill: "forwards" }).finished;
}
handlers.volume = d => { if (R && !sheet.classList.contains("on")) turn(+d); };

/* ---------- 阅读器手势 ---------- */
function wordAt(x, y) {
  const r = document.caretRangeFromPoint(x, y); if (!r) return null;
  const n = r.startContainer; if (n.nodeType !== 3 || !R.flow.contains(n)) return null;
  // caretRangeFromPoint() is allowed to snap to the previous caret at a line
  // break. Build word rectangles around the returned text node and choose the
  // rectangle nearest to the actual touch point. This also handles one word
  // whose Range is split into several client rects by wrapping.
  if (!R.wordNodes || !R.wordNodeIndex || !R.wordRects || !R.wordNodeIndex.has(n)) {
    R.wordNodes = [];
    R.wordNodeIndex = new Map();
    const tw = document.createTreeWalker(R.flow, NodeFilter.SHOW_TEXT);
    for (let t; (t = tw.nextNode());) if (t.nodeValue && t.nodeValue.trim()) { R.wordNodeIndex.set(t, R.wordNodes.length); R.wordNodes.push(t); }
    R.wordRects = new WeakMap();
  }
  const at = R.wordNodeIndex.get(n); if (at == null) return null;
  const from = Math.max(0, at - 2), to = Math.min(R.wordNodes.length, at + 3);
  let best = null;
  for (let ni = from; ni < to; ni++) {
    const node = R.wordNodes[ni], text = node.nodeValue;
    let entries = R.wordRects.get(node);
    if (!entries || entries.text !== text) {
      entries = { text, words: [] };
      const re = /[A-Za-z][A-Za-z’'\-]*/g;
      for (let m; (m = re.exec(text));) {
        const range = document.createRange(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
        entries.words.push({ a: m.index, b: m.index + m[0].length, range, rects: [...range.getClientRects()] });
      }
      R.wordRects.set(node, entries);
    }
    for (const word of entries.words) for (const rc of word.rects) {
      const dx = x < rc.left ? rc.left - x : x > rc.right ? x - rc.right : 0;
      const dy = y < rc.top ? rc.top - y : y > rc.bottom ? y - rc.bottom : 0;
      if (dx > 10 || dy > 10) continue;
      const score = dx * dx + dy * dy + (node === n ? 0 : 0.25);
      if (!best || score < best.score) best = { node, a: word.a, b: word.b, range: word.range, score };
    }
  }
  return best ? { node: best.node, a: best.a, b: best.b, range: best.range } : null;
}
function sameWord(a, b) { return !!a && !!b && a.node === b.node && a.a === b.a && a.b === b.b; }
function wrapWord(w) {
  const p = w.node.parentElement;
  if (p.classList.contains("w") && w.a === 0 && w.b === w.node.nodeValue.length) return p;
  const s = document.createElement("span"); s.className = "w tmp";
  w.range.surroundContents(s); R.tnDirty = true;
  R.wordNodes = null; R.wordNodeIndex = null; R.wordRects = null;
  return s;
}
function unwrap(s) {
  if (!s || !s.classList.contains("tmp") || !s.parentNode) return;
  const p = s.parentNode;
  while (s.firstChild) p.insertBefore(s.firstChild, s);
  s.remove(); p.normalize(); R.tnDirty = true; R.wordNodes = null; R.wordNodeIndex = null; R.wordRects = null;
}
function sentenceOf(span) {
  const block = span.closest("p, li, blockquote, td, h1, h2, h3, h4, div, section") || R.flow;
  const pre = document.createRange(); pre.setStart(block, 0); pre.setEndBefore(span);
  const text = block.textContent, off = pre.toString().length;
  let a = off, b = off + span.textContent.length;
  while (a > 0 && !/[.?!]/.test(text[a - 1])) a--;
  while (b < text.length && !/[.?!]/.test(text[b])) b++;
  let s = text.slice(a, Math.min(text.length, b + 1)).replace(/\s+/g, " ").trim();
  if (s.length > 400) { const c = off - a; s = s.slice(Math.max(0, c - 200), c + 200); }
  return s;
}
function bindReader() {
  const r = R.r; let down = null, tapT = null, lastTap = null;
  r.addEventListener("contextmenu", e => e.preventDefault());
  r.addEventListener("pointerdown", e => {
    if (e.target.closest(".rd-ui, .rmenu, .lk, button")) return;
    const near = lastTap && Date.now() - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
    clearTimeout(tapT); tapT = null;
    const w = st.busy ? null : wordAt(e.clientX, e.clientY);
    down = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), target: e.target, locked: false, selecting: false, cancelled: false,
      dbl: near && !!w, w, span: null, anchor: null, sel: null, last: null, edge: 0, edgeT: null, active: true };
    try { r.setPointerCapture(e.pointerId); } catch (ignored) { }
    if (down.dbl) { lastTap = null; down.active = false; lookupInBook(wrapWord(w)); down = null; return; }
    if (w) armPress(down);
    else if (st.busy) {
      // 翻页/开书动画没结束时手底下压着的是克隆页，测不出词；等动画结束再补测一次，
      // 否则这段时间按下去的长按会被整段丢掉，只剩系统自己的长按震动。
      const d = down;
      const retry = () => {
        if (down !== d || !d.active || d.cancelled) return;
        if (st.busy) { setTimeout(retry, 40); return; }
        const w2 = wordAt(d.x, d.y); if (!w2) return;
        d.w = w2; armPress(d);
      };
      setTimeout(retry, 40);
    }
  });
  const armPress = d => {
    clearTimeout(d.pressT); clearTimeout(d.lockT);
    d.pressT = setTimeout(() => {
      if (down !== d) return;
      d.span = wrapWord(d.w); d.span.classList.add("press"); d.sentence = sentenceOf(d.span);
    }, 130);
    d.lockT = setTimeout(() => {
      if (down !== d || !d.active || d.cancelled) return;
      d.locked = true; d.state = "locked";
      d.span = d.span || wrapWord(d.w); d.sentence = d.sentence || sentenceOf(d.span);
      d.span.classList.remove("press"); d.span.classList.add("locked");
      N.haptic?.(); N.warmNet();
    }, 360);
  };
  const cancelBeforeLock = d => {
    clearTimeout(d.pressT); clearTimeout(d.lockT);
    d.cancelled = true;
    if (d.span && !d.span.classList.contains("hl")) { d.span.classList.remove("press", "locked"); unwrap(d.span); d.span = null; }
  };
  r.addEventListener("pointermove", e => {
    if (!down || e.pointerId !== down.pointerId) return;
    if (!down.locked) {
      // 大屏上按住时手指会滚动几个像素，容差给到 18px；真正的滑动翻页要 40px 以上
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 18) cancelBeforeLock(down);
      return;
    }
    const w2 = wordAt(e.clientX, e.clientY);
    if (!down.selecting && w2 && !sameWord(down.w, w2)) {
      if (down.span) { down.span.classList.remove("press", "locked"); unwrap(down.span); down.span = null; }
      down.anchor = wordAt(down.x, down.y);
      down.selecting = !!down.anchor;
      down.state = down.selecting ? "selecting" : "locked";
      r.classList.toggle("selection-mode", down.selecting);
    }
    if (down.selecting) extendSel(down, e.clientX, e.clientY);
  });
  r.addEventListener("pointerup", e => {
    if (!down || e.pointerId !== down.pointerId) return;
    const d = down; d.active = false; clearTimeout(d.pressT); clearTimeout(d.lockT); clearTimeout(d.edgeT);
    down = null; r.classList.remove("selection-mode", "sel-edge-left", "sel-edge-right");
    try { r.releasePointerCapture(e.pointerId); } catch (ignored) { }
    if (d.span) d.span.classList.remove("press", "locked");
    if (d.sel) { finishSel(d); return; }
    if (d.locked && d.w && !d.cancelled) { lookupInBook(d.span || wrapWord(d.w)); return; }
    if (d.dbl) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { turn(dx < 0 ? 1 : -1); return; }
    // 按住超过锁定时间却没锁定（手指漂移、没按中词）时不能当成点按去翻页：
    // 手指还在原词附近就照常查词，否则什么都不做
    // （词卡或菜单开着时仍走下面的点按逻辑，先把它们关掉）
    if (Date.now() - d.t >= 360 && !R.lk.classList.contains("on") && !R.menu.classList.contains("on")) {
      if (d.w && Math.hypot(dx, dy) < 40) { const w = wordAt(d.x, d.y); if (w) lookupInBook(wrapWord(w)); }
      return;
    }
    // 收藏过的词（点状下划线）点一下就查，不用长按；再点正在查的这个词关掉卡片
    const sv = d.w && !R.menu.classList.contains("on") && d.w.node.parentElement?.closest(".w.sv");
    if (sv && R.flow.contains(sv)) {
      lastTap = { t: Date.now(), x: e.clientX, y: e.clientY }; // 紧跟着的第二下按双击查词处理，不会把卡片关掉
      if (sv.classList.contains("hl") && R.lk.classList.contains("on")) hideLookup(); else lookupInBook(sv);
      return;
    }
    const link = d.target?.closest?.("a[data-ch]");
    if (link && R.flow.contains(link) && !R.lk.classList.contains("on") && !R.menu.classList.contains("on")) {
      if (link.classList.contains("nref")) openNote(link); else followLink(link);
      return;
    }
    const x = e.clientX - r.getBoundingClientRect().left;
    const act = () => {
      if (R.lk.classList.contains("on")) { hideLookup(); return; }
      if (R.menu.classList.contains("on")) { R.menu.classList.remove("on"); return; }
      if (x < R.W * 0.28) turn(-1);
      else if (x > R.W * 0.72) turn(1);
      else { const on = !r.classList.contains("ui"); r.classList.toggle("ui", on); scr.classList.toggle("ui", on); N.bars(on, !["quiet", "focus"].includes(st.theme)); }
    };
    lastTap = { t: Date.now(), x: e.clientX, y: e.clientY };
    // 点在中间的单词上时稍等，留给双击查词
    if (d.w && x >= R.W * 0.28 && x <= R.W * 0.72 && !R.lk.classList.contains("on")) tapT = setTimeout(() => { tapT = null; act(); }, 260); else act();
  });
  r.addEventListener("pointercancel", e => {
    if (!down || e.pointerId !== down.pointerId) return;
    clearTimeout(down.pressT); clearTimeout(down.lockT); clearTimeout(down.edgeT);
    down.active = false; if (down.span) { down.span.classList.remove("press", "locked"); unwrap(down.span); }
    down = null; r.classList.remove("selection-mode", "sel-edge-left", "sel-edge-right");
  });
  r.addEventListener("click", e => {
    const b = e.target.closest("[data-r]"); if (!b) return;
    const a = b.dataset.r;
    if (a === "close") closeBook();
    else if (a === "menu") {
      $("#rm-pos").textContent = R.counts ? `${globalStart(R.ch) + R.page + 1} / ${totalPages()}` : "";
      $("#rm-count").textContent = bookWords().length || "";
      R.menu.classList.toggle("on");
    }
    else if (a === "bm") toggleBookmark();
    else if (a === "back") goBack();
    else { R.menu.classList.remove("on"); ({ toc: openToc, find: openFind, themes: openThemes, bookwords: openBookWords })[a](); }
  });
  R.lk.addEventListener("click", e => { if (e.target.closest("[data-close]")) hideLookup(); });
}
function toggleBookmark() {
  const list = bookmarks[st.book.id] || (bookmarks[st.book.id] = []), span = R.spread ? 2 : 1;
  const i = list.findIndex(m => m.ch === R.ch && Math.abs(pageForOffset(m.off) - R.page) < span);
  if (i >= 0) list.splice(i, 1); else list.push({ ch: R.ch, off: anchorOffset(), t: Date.now() });
  kv.set("bookmarks", bookmarks);
  setPage(R.page);
  toast(i >= 0 ? "已移除书签" : "已添加书签");
}

/* ---------- 拖动选句与整句翻译 ---------- */
// 按住先锁定一个词，继续拖动时按词边界扩展选区；松手后再决定查词、翻译短语或翻译句子。
function extendSel(d, x, y) {
  edgeWatch(d, x);
  let w2 = wordAt(x, y); if (!w2) return;
  if (!d.anchor) return;
  const w1 = d.anchor;
  const [a, b] = w1.range.compareBoundaryPoints(Range.START_TO_START, w2.range) <= 0 ? [w1, w2] : [w2, w1];
  const range = document.createRange();
  range.setStart(a.node, a.a); range.setEnd(b.node, b.b);
  d.sel = range; d.last = w2.range;
  CSS.highlights.set("rsel", new Highlight(range));
}
function edgeWatch(d, x) {
  if (!d.selecting || !d.anchor) return;
  const rx = x - R.r.getBoundingClientRect().left, edge = Math.max(28, R.W * 0.07);
  const dir = rx > R.W - edge ? 1 : rx < edge ? -1 : 0;
  if (dir === d.edge) return;
  clearTimeout(d.edgeT); d.edge = dir;
  R.r.classList.toggle("sel-edge-left", dir < 0); R.r.classList.toggle("sel-edge-right", dir > 0);
  if (!dir) return;
  const step = () => {
    if (!d.active || !d.selecting || d.edge !== dir) return;
    const to = R.page + dir * (R.spread ? 2 : 1);
    if (!R || to < 0 || to >= R.pages) { toast(dir > 0 ? "已到本章末尾" : "已到本章开头"); return; }
    turnForSelection(to);
    if (d.sel) CSS.highlights.set("rsel", new Highlight(d.sel));
    d.edgeT = setTimeout(step, 900);
  };
  d.edgeT = setTimeout(step, 450);
}
function turnForSelection(to) {
  const before = R.flow.style.transform;
  setPage(to);
  const after = R.flow.style.transform;
  if (!animOff() && before !== after) R.flow.animate([{ transform: before }, { transform: after }], {
    duration: 250, easing: "cubic-bezier(.2,.8,.2,1)", fill: "none"
  });
}
const TOKEN_RE = /[A-Za-z][A-Za-z’'\-]*/g;
function tokensOf(text) { return text.match(TOKEN_RE) || []; }
function textOffset(root, node, offset) {
  if (!root || !node || (root !== node && !root.contains(node))) return 0;
  const r = document.createRange(); r.selectNodeContents(root); r.setEnd(node, offset); return r.toString().length;
}
function rangeBlock(range) {
  let n = range.startContainer; if (n.nodeType === 3) n = n.parentElement;
  const block = n.closest("p, li, blockquote, td, h1, h2, h3, h4, div, section");
  return block && block !== R.flow ? block : R.flow;
}
function sentenceForRange(range) {
  const block = rangeBlock(range), text = block.textContent || "";
  const start = textOffset(block, range.startContainer, range.startOffset);
  const end = textOffset(block, range.endContainer, range.endOffset);
  let a = Math.max(0, Math.min(start, text.length)), b = Math.max(a, Math.min(end, text.length));
  while (a > 0 && !/[.?!]/.test(text[a - 1])) a--;
  while (b < text.length && !/[.?!]/.test(text[b])) b++;
  while (b < text.length && /[\s"'”’)\]]/.test(text[b])) b++;
  return { text: text.slice(a, b).replace(/\s+/g, " ").trim(), start: a, end: b, selectedStart: start, selectedEnd: end };
}
function targetFromSelection(d) {
  const raw = d.sel.toString().replace(/\s+/g, " ").trim(), tokens = tokensOf(raw);
  const sentence = sentenceForRange(d.sel), sentenceText = d.sentence || sentence.text, sentenceTokens = tokensOf(sentenceText).length;
  const complete = sentenceText === raw || /[.?!]["'”’)\]]*$/.test(raw);
  const mostlySentence = sentenceTokens > 0 && tokens.length / sentenceTokens >= .82;
  let type = tokens.length <= 1 ? "word" : (complete || mostlySentence ? "sentence" : "phrase");
  const last = d.last || d.sel;
  const focus = wordAt(...centerOf(last));
  return { type, text: raw, phraseText: raw, fullText: raw, tokens, sentence: sentenceText, range: d.sel, lastRange: last, anchor: rectOfRange(last),
    focusWord: focus ? focus.node.nodeValue.slice(focus.a, focus.b) : tokens[tokens.length - 1] || "" };
}
function finishSel(d) {
  clearTimeout(d.edgeT);
  const target = targetFromSelection(d);
  if (target.type === "word") { CSS.highlights.delete("rsel"); const w = wordAt(...centerOf(d.last)); if (w) lookupInBook(wrapWord(w)); return; }
  if (target.text.length > 1500) target.text = target.text.slice(0, 1500);
  renderReadingTarget(target, target.type, target.anchor);
}
function blockText(span) { return (span.closest("p, li, blockquote, td, h1, h2, h3, h4, div") || R.flow).textContent; }
function centerOf(range) { const c = range.getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; }
function rectOfRange(range) { const a = range.getBoundingClientRect(), s = scr.getBoundingClientRect(); return { x: a.left - s.left, y: a.top - s.top, w: a.width, h: a.height }; }
function translateInBook(text, rect, range, ctx) {
  const target = { type: "sentence", text: text.trim(), phraseText: text.trim(), fullText: text.trim(), tokens: tokensOf(text), sentence: ctx && ctx.replace(/\s+/g, " ").trim() || text.trim(), range, lastRange: null, anchor: rect, focusWord: st.lkWord || "" };
  renderReadingTarget(target, "sentence", rect);
}
function targetKey(target, type) {
  return [st.book?.id || "", R?.ch ?? "", target.sentence || target.text, target.text, type].join("|");
}
function toggleTargetSave(target, type, btn) {
  const map = type === "phrase" ? savedPhrases : savedQuotes, key = targetKey(target, type);
  const existed = map.has(key);
  if (existed) {
    map.delete(key); toast(type === "phrase" ? "已取消收藏短语" : "已取消保存摘录");
  } else {
    map.set(key, { text: target.text, sentence: target.sentence, book: st.book?.id || "", ch: R?.ch ?? 0, off: R ? anchorOffset() : 0, t: Date.now() });
    toast(type === "phrase" ? "已收藏短语" : "已保存摘录");
  }
  kv.set(type === "phrase" ? "savedPhrases" : "savedQuotes", [...map]);
  if (btn) {
    const on = map.has(key), label = type === "phrase" ? "短语" : "摘录";
    btn.className = "pill " + (on ? "done" : "alt"); btn.textContent = on ? `已保存${label}` : `保存${label}`;
  }
}
function offlinePhraseHTML(info) {
  return info.found ? info.lines.map(([p, m]) => esc((p ? p + " " : "") + m)).join("<br>") : "";
}
function renderReadingTarget(target, type, sr) {
  if (!R) return;
  const isPhrase = type === "phrase", label = isPhrase ? "短语" : "句子";
  const text = target.text;   // 只翻选中的这段，不再把选区换成整句
  hideLookup({ preserveSelection: true });
  activeTarget = Object.assign({}, target, { type, text });
  st.lkSentence = target.sentence || ""; st.lkWord = target.focusWord || "";
  const anchor = sr || target.anchor || rectOfRange(target.lastRange || target.range);
  const phraseInfo = isPhrase ? lookupWord(text) : null;
  const offline = phraseInfo && offlinePhraseHTML(phraseInfo);
  const map = isPhrase ? savedPhrases : savedQuotes, on = map.has(targetKey(target, type));
  const action = on ? `已保存${label}` : `保存${label}`;
  activeTarget.offline = !!offline;
  showCard(`<div class="grab"></div><div class="reading-target">
      <div class="target-head"><span class="target-kind">${label}</span><button class="x" data-close="1" aria-label="关闭">${I.x}</button></div>
      <div class="target-scroll">
        <div class="trx src">${esc(text)}</div>
        <div class="trx target-out" id="rt-out">${offline || (N.hasTr() ? "…" : "未配置整句翻译")}</div>
      </div>
      <div class="acts"><button class="pill ${on ? "done" : "alt"}" data-target-save="${type}">${action}</button><button class="pill alt share" data-target-share="1">分享书摘</button></div>
    </div>`, anchor);
  if (N.hasTr() && !offline) translateText(text, $("#rt-out", R.lk), target.sentence);
}

/* ---------- 分享书摘：摘录 + 中文译文画成像素风竖版 PNG，交给系统分享面板 ---------- */
const EXCERPT_W = 1080;
const EXCERPT_H = { "34": 1440, "916": 1920, "11": 1080 };   // 聊天 / 朋友圈竖屏 / 方形
const EXCERPT = { paper: "#f7f1de", ink: "#241d12", muted: "#4a4237", faint: "#8a7f6c", accent: "#d95f2b", line: "rgba(36,29,18,.30)" };
const CJK_RE = /[\u3000-\u9fff\uff00-\uffef]/;
function excerptLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split(/\n+/)) {
    const tokens = para.match(/[\u3000-\u9fff\uff00-\uffef]|[^\s\u3000-\u9fff\uff00-\uffef]+/g) || [];
    let line = "";
    for (const tk of tokens) {
      if (!line) { line = tk; continue; }
      const sep = CJK_RE.test(line.slice(-1)) || CJK_RE.test(tk[0]) ? "" : " ";
      const test = line + sep + tk;
      if (ctx.measureText(test).width <= maxW) line = test; else { out.push(line); line = tk; }
    }
    if (line) out.push(line);
  }
  return out;
}
/** 在给定区域里挑一个放得下的字号；最小字号还放不下就截断加省略号。 */
function excerptFit(ctx, text, o) {
  let best = null;
  for (let size = o.sizeMax; size >= o.sizeMin; size -= 2) {
    ctx.font = `${o.weight} ${size}px ${o.family}`;
    const lines = excerptLines(ctx, text, o.maxW);
    best = { size, lines };   // 每次覆盖，循环结束留下的是最小字号（截断时保留最多文字）
    if (lines.length * size * o.lineH <= o.maxH) return { size, lines, lineH: o.lineH };
  }
  const maxLines = Math.max(1, Math.floor(o.maxH / (best.size * o.lineH)));
  const lines = best.lines.slice(0, maxLines);
  lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s,，。.;；:：、]*$/, "") + "…";
  return { size: best.size, lines, lineH: o.lineH };
}
async function excerptCanvas({ quote, trans, title, author, ratio }) {
  const H = EXCERPT_H[ratio] || EXCERPT_H["34"];
  const c = document.createElement("canvas");
  c.width = EXCERPT_W; c.height = H;
  const ctx = c.getContext("2d");
  const K = EXCERPT, PAD = 104, innerW = EXCERPT_W - PAD * 2;
  const QUOTE_FONT = '"Literata", Georgia, serif', TEXT_FONT = '"Noto Sans SC", "MiSans", sans-serif', PIX_FONT = '"Fusion Pixel", "Noto Sans SC", sans-serif';
  try { await Promise.all([document.fonts.load('600 56px Literata'), document.fonts.load('400 34px "Fusion Pixel"'), document.fonts.load('400 40px "Noto Sans SC"')]); } catch (e) { }
  // 纸面、CRT 扫描线、四角硬框
  ctx.fillStyle = K.paper; ctx.fillRect(0, 0, EXCERPT_W, H);
  ctx.fillStyle = "rgba(36,29,18,.035)";
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, EXCERPT_W, 1);
  ctx.strokeStyle = "rgba(36,29,18,.55)"; ctx.lineWidth = 3; ctx.lineCap = "square";
  const arm = 72, inset = 44;
  [[inset, inset, 1, 1], [EXCERPT_W - inset, inset, -1, 1], [inset, H - inset, 1, -1], [EXCERPT_W - inset, H - inset, -1, -1]]
    .forEach(([x, y, sx, sy]) => { ctx.beginPath(); ctx.moveTo(x, y + arm * sy); ctx.lineTo(x, y); ctx.lineTo(x + arm * sx, y); ctx.stroke(); });
  // 顶部标签与分隔线
  ctx.textBaseline = "top";
  ctx.font = `400 34px ${PIX_FONT}`; ctx.fillStyle = K.accent; ctx.fillText("书 摘", PAD, PAD - 12);
  ctx.textAlign = "right"; ctx.font = `400 28px ${PIX_FONT}`; ctx.fillStyle = K.faint; ctx.fillText("EXCERPT", EXCERPT_W - PAD, PAD - 8);
  ctx.textAlign = "left";
  ctx.fillStyle = K.line; ctx.fillRect(PAD, PAD + 44, innerW, 2);
  // 摘录与译文：先量出总高，整块在中间区域垂直居中
  const quoteTop = PAD + 100, bottomRuleY = H - PAD - 104, availH = bottomRuleY - quoteTop - 24;
  const sizeMax = H >= 1800 ? 84 : H <= 1200 ? 56 : 68;
  const q = excerptFit(ctx, quote, { maxW: innerW, maxH: Math.round(availH * (trans ? .62 : 1)), sizeMax, sizeMin: 34, lineH: 1.5, family: QUOTE_FONT, weight: 600 });
  const qBlockH = q.lines.length * q.size * q.lineH;
  let t = null, tBlockH = 0;
  if (trans) {
    t = excerptFit(ctx, trans, { maxW: innerW - 28, maxH: availH - qBlockH - 62, sizeMax: 42, sizeMin: 29, lineH: 1.7, family: TEXT_FONT, weight: 400 });
    tBlockH = t.lines.length * t.size * t.lineH;
  }
  const totalH = qBlockH + (t ? 62 + tBlockH : 0);
  let y = quoteTop + Math.max(0, (availH - totalH) / 2);
  ctx.font = `600 ${q.size}px ${QUOTE_FONT}`; ctx.fillStyle = K.ink;
  for (const ln of q.lines) { ctx.fillText(ln, PAD, y); y += q.size * q.lineH; }
  if (t) {
    const tTop = y + 62;
    ctx.fillStyle = K.accent; ctx.fillRect(PAD, tTop + 4, 6, 28);
    ctx.font = `400 ${t.size}px ${TEXT_FONT}`; ctx.fillStyle = K.muted;
    let ty = tTop;
    for (const ln of t.lines) { ctx.fillText(ln, PAD + 26, ty); ty += t.size * t.lineH; }
  }
  // 出处
  ctx.fillStyle = "rgba(36,29,18,.22)"; ctx.fillRect(PAD, bottomRuleY, innerW, 2);
  const meta = [title, author].filter(Boolean).join("  ·  ");
  ctx.fillStyle = K.accent; ctx.fillRect(PAD, bottomRuleY + 32, 14, 14);
  ctx.font = `400 34px ${PIX_FONT}`; ctx.fillStyle = K.muted;
  if (meta) ctx.fillText(meta, PAD + 30, bottomRuleY + 28, innerW - 30);
  return c.toDataURL("image/png");
}
async function excerptWaitTranslation(out) {
  let last = "", stable = 0;
  for (let i = 0; i < 120; i++) {
    const txt = out.textContent.trim();
    if (txt && txt !== "…") {
      if (txt === last) { if (++stable >= 4) return txt; } else { last = txt; stable = 0; }
    } else { last = ""; stable = 0; }
    await new Promise(r => setTimeout(r, 100));
  }
  return out.textContent.trim();
}
function translateAwait(text, ctxText) {
  const title = st.book ? `书名：《${st.book.title}》\n` : "";
  const c = ctxText && ctxText.length > text.length + 20 && ctxText.length < 1500 ? `<context>${ctxText}</context>\n` : "";
  const payload = `${title}${c}<text>${text}</text>`;
  if (trCache.has(payload)) return Promise.resolve(trCache.get(payload));
  if (!N.hasTr()) return Promise.resolve("");
  return new Promise(resolve => {
    let done = false; const id = ++trSeq; let out = "";
    trWait[id] = d => {
      if (d.delta) out += d.delta;
      if (d.done && !done) { done = true; trCache.set(payload, out); resolve(out); }
      if (d.error && !done) { done = true; resolve(out || ""); }
    };
    N.translate(id, payload, false);
    setTimeout(() => { if (!done) { done = true; resolve(out || ""); } }, 20000);
  });
}
let excerptState = null;
const EXCERPT_RATIOS = [["34", "3:4 聊天"], ["916", "9:16 竖屏"], ["11", "1:1 方形"]];
async function openExcerptSheet(state) {
  if (!settings.excerptRatio || !EXCERPT_H[settings.excerptRatio]) settings.excerptRatio = "34";
  excerptState = Object.assign({ ratio: settings.excerptRatio, dataUrl: "" }, state);
  const chips = EXCERPT_RATIOS.map(([k, t]) => `<button data-ex-ratio="${k}" aria-pressed="${excerptState.ratio === k}">${t}</button>`).join("");
  openSheet(`<div class="sh-body"><div class="ex-sheet">
    <div class="ex-preview"><img id="ex-img" alt="书摘卡预览"></div>
    <div class="ex-ratios">${chips}</div>
    <div class="acts"><button class="pill alt" data-ex-cancel="1">取消</button><button class="pill primary" id="ex-share">分享</button></div>
  </div></div>`, "ex-wrap");
  await renderExcerptPreview();
}
async function renderExcerptPreview() {
  if (!excerptState) return;
  const url = await excerptCanvas(excerptState);
  excerptState.dataUrl = url;
  const img = $("#ex-img");
  if (img) img.src = url;
}
const BAD_TRANS = /^(网络|请求|未配置|Jev|HTTP|翻译失败|…)/;
async function shareExcerpt(btn) {
  const t = activeTarget;
  if (!t || !R) return;
  const quote = (t.text || "").replace(/\s+/g, " ").trim();
  if (!quote) return;
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
  try {
    let trans = "";
    const out = $("#rt-out", R.lk);
    if (out) { const s2 = await excerptWaitTranslation(out); if (s2 && !BAD_TRANS.test(s2)) trans = s2; }
    if (!trans) trans = (await translateAwait(quote, t.sentence)).trim();
    if (trans && BAD_TRANS.test(trans)) trans = "";
    await openExcerptSheet({ quote, trans, title: st.book?.title || "", author: st.book?.author || "" });
    if (!trans) toast("没拿到译文，先分享原文");
  } catch (e) {
    toast("生成书摘失败");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/* ---------- 阅读中查词 ---------- */
function lookupInBook(span) {
  activeTarget = null;
  $$(".w.hl", R.flow).forEach(s => { if (s !== span) { s.classList.remove("hl"); unwrap(s); } });
  span.classList.add("hl");
  const info = lookupWord(span.textContent), lk = R.lk, sentence = sentenceOf(span);
  st.lkSentence = sentence; st.lkWord = span.textContent;
  const tn = tindex(); const n = span.firstChild;
  const hit = tn.find(([node]) => node === n); R.lkOff = hit ? hit[1] : null;
  showCard('<div class="grab"></div>' + wordHTML(info, { sentence, close: true }), rectIn(span));
  N.warmNet();
  if (info.found) resolveCtx($(".wd", lk), info, sentence);
}
function showCard(html, sr) {
  const lk = R.lk;
  lk.classList.remove("on");
  lk.innerHTML = html;
  const atTop = st.screen === "outer" && sr.y > R.H * 0.48;
  lk.style.transition = "none"; lk.classList.toggle("top", atTop); void lk.offsetWidth; lk.style.transition = "";
  // 卡片不能挡住被查的词：高度限制在词上方或下方的空间里，超出时在卡片内滚动
  lk.style.maxHeight = st.screen === "outer" ? (atTop ? sr.y - 6 : R.H - sr.y - sr.h - 6) + "px" : "";
  if (st.screen === "inner") {
    const onLeft = sr.x < R.W / 2;
    const x = R.spread ? (onLeft ? R.W * 0.75 : R.W * 0.25) - 170 : Math.min(R.W - 360, Math.max(20, sr.x - 170));
    lk.style.left = x + "px";
    // 单页时卡片和词在同一栏：词在下半页就把卡片放到上方，并把高度限制在词的另一侧
    const up = !R.spread && sr.y + sr.h / 2 > R.H / 2;
    lk.style.top = up ? "64px" : ""; lk.style.bottom = up ? "" : "64px";
    if (!R.spread) lk.style.maxHeight = (up ? sr.y - 74 : R.H - 74 - sr.y - sr.h) + "px";
  } else lk.style.left = lk.style.bottom = lk.style.top = "";
  void lk.offsetWidth; lk.classList.add("on");
}
/* ---------- 书内链接与注释 ---------- */
async function noteOf(a) {
  const ch = +a.dataset.ch, frag = a.dataset.frag;
  let root = R.flow;
  if (ch !== R.ch) { root = document.createElement("div"); root.innerHTML = await chapterHTML(ch); }
  let t = root.querySelector("#" + CSS.escape(frag));
  if (!t) return null;
  if (!/^(aside|li|dd|p|blockquote)$/.test(t.localName)) t = t.closest("aside, li, dd, p, blockquote, div:not(.bk-body)") || t;
  const c = t.cloneNode(true);
  c.classList.remove("fn-aside");
  // 去掉注释开头指回正文的编号链接
  $$("a[data-ch]", c).forEach(x => { if (/^[\[(]?([\divx]{1,4}|[*†‡§¶]+)[\])]?\.?$|↩|↑|^back\b|返回/i.test(x.textContent.trim())) x.remove(); });
  $$("[id]", c).forEach(x => x.removeAttribute("id")); c.removeAttribute("id");
  return c.textContent.trim() ? c : null;
}
async function openNote(a) {
  const n = await noteOf(a);
  if (!R) return;
  if (!n) { followLink(a); return; }
  hideLookup();
  showCard(`<div class="grab"></div><div class="note">${n.outerHTML}</div>`, rectIn(a));
}
async function followLink(a) {
  const ch = +a.dataset.ch, frag = a.dataset.frag;
  R.back = { ch: R.ch, off: anchorOffset(), turns: 0 };
  if (ch === R.ch) { const t = frag && R.flow.querySelector("#" + CSS.escape(frag)); setPage(t ? pageOf(t) : 0); }
  else await loadChapter(ch, frag ? { frag } : { page: 0 });
  $(".rd-back", R.r).hidden = false;
}
async function goBack() {
  const b = R.back; clearBack();
  if (b.ch === R.ch) setPage(pageForOffset(b.off)); else await loadChapter(b.ch, { off: b.off });
}
function clearBack() { if (!R) return; R.back = null; $(".rd-back", R.r).hidden = true; }
function hideLookup(opts = {}) {
  if (!R) return;
  R.lk.classList.remove("on");
  if (!opts.preserveSelection) CSS.highlights.delete("rsel");
  $$(".w.hl", R.flow).forEach(s => { s.classList.remove("hl"); if (s.classList.contains("sv")) s.classList.remove("tmp"); else unwrap(s); });
  st.lkSentence = ""; st.lkWord = "";
  activeTarget = null;
}
let formsKey = "", formsRe = null;
function markSaved() {
  if (!R) return;
  $$(".w.sv", R.flow).forEach(s => { s.classList.remove("sv"); if (!s.classList.contains("hl")) { s.classList.add("tmp"); unwrap(s); } });
  const lemmas = [...saved.keys()];
  if (!lemmas.length) return;
  const key = lemmas.join(",");
  if (key !== formsKey) {
    // 词库暂时取不到时跳过标记；这里抛异常会让整章排版中断，翻页和取词一起失效
    let forms;
    try { forms = [...new Set(JSON.parse(N.formsOf(JSON.stringify(lemmas))))]; } catch (e) { return; }
    formsKey = key;
    formsRe = new RegExp("\\b(" + forms.sort((a, b) => b.length - a.length).map(f => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "gi");
  }
  const nodes = [], w = document.createTreeWalker(R.flow, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) { formsRe.lastIndex = 0; if (formsRe.test(n.nodeValue)) nodes.push(n); }
  for (const n of nodes) {
    const t = n.nodeValue, frag = document.createDocumentFragment(); let last = 0, m;
    if (n.parentElement.classList.contains("w")) { n.parentElement.classList.add("sv"); continue; }
    formsRe.lastIndex = 0;
    while ((m = formsRe.exec(t))) { frag.append(t.slice(last, m.index)); const s = el("span", "w sv"); s.textContent = m[0]; frag.append(s); last = m.index + m[0].length; }
    frag.append(t.slice(last)); n.replaceWith(frag);
  }
  R.tnDirty = true;
}
function bookWords() { return [...saved].filter(([, m]) => st.book && m.book === st.book.id); }

/* ---------- 阅读器里的卡片 ---------- */
function openToc() {
  const toc = st.book.toc && st.book.toc.length ? st.book.toc : st.book.spine.map((_, i) => ({ t: `第 ${i + 1} 部分`, ch: i, frag: "" }));
  const curIdx = st.book.toc && st.book.toc.length ? tocIndexAt(R.ch, R.page + (R.spread ? 1 : 0)) : R.ch;
  const chs = toc.map((c, i) => `<li class="${i === curIdx ? "cur" : ""}"><button data-go-ch="${c.ch}" data-frag="${esc(c.frag || "")}"><span class="lw">${esc(c.t)}</span><span class="ls">${R.counts ? globalStart(c.ch) + tocPage(c) + 1 : ""}</span></button></li>`).join("");
  const marks = (bookmarks[st.book.id] || []).slice().sort((a, b) => a.ch - b.ch || a.off - b.off);
  const total = R.counts ? totalPages() : st.book.spine.length;
  const cur = R.counts ? globalStart(R.ch) + R.page : R.ch;
  const label = v => R.counts ? `第 ${v + 1} 页` : `第 ${v + 1} 部分`;
  openSheet(`<div class="sh-head"><h3>${esc(st.book.title)}</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
    <div class="sh-body flush">
      <div style="padding:4px 20px 8px"><input class="scrub" id="scrub" type="range" min="0" max="${total - 1}" step="1" value="${cur}" aria-label="阅读进度"><div class="scrub-l"><span id="scrub-l">${label(cur)}</span><span>共 ${total} ${R.counts ? "页" : "部分"}</span></div></div>
      <div class="sec-s">目录</div><ul class="list toc">${chs}</ul>
      ${marks.length ? `<div class="sec-s">书签</div><ul class="list">${marks.map(m => `<li><button data-go-ch="${m.ch}" data-off="${m.off}"><span class="lw">${esc(chapterTitle(m.ch, m.ch === R.ch ? pageForOffset(m.off) : 0))}</span><span class="ls">${new Date(m.t).toLocaleDateString("zh-CN")}</span></button></li>`).join("")}</ul>` : ""}
    </div>`);
  setTimeout(() => $("#sheet .toc li.cur")?.scrollIntoView({ block: "center" }), 0);
  const sc = $("#scrub");
  let scrubT;
  sc.addEventListener("input", () => {
    const v = +sc.value; $("#scrub-l").textContent = label(v);
    clearTimeout(scrubT); scrubT = setTimeout(() => goGlobal(v), 80);
  });
}
async function goGlobal(v) {
  if (!R) return;
  if (!R.counts) { if (v !== R.ch) await loadChapter(v, { page: 0 }); return; }
  let ch = 0, s = 0;
  while (ch < R.counts.length - 1 && s + (ch === R.ch ? R.pages : R.counts[ch]) <= v) { s += ch === R.ch ? R.pages : R.counts[ch]; ch++; }
  if (ch === R.ch) setPage(Math.min(R.pages - 1, v - s)); else await loadChapter(ch, { page: v - s });
}
function openFind() {
  openSheet(`<div class="sh-head"><h3>查单词</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
    <div class="sh-body flush" id="fbody"><label class="search">${I.search}<input id="fq" placeholder="输入单词" autocomplete="off" autocapitalize="off" spellcheck="false"></label><ul class="list" id="fres" style="margin-top:8px"></ul></div>`);
  const q = $("#fq"), res = $("#fres");
  q.addEventListener("input", () => {
    const v = q.value.trim();
    res.innerHTML = v ? (JSON.parse(N.prefix(v)).slice(0, 8).map(h => `<li><button data-fw="${esc(h.w)}"><span class="lw">${esc(h.w)}</span><span class="lm">${esc(h.m)}</span></button></li>`).join("") || `<li class="empty">词典里没有 ${esc(v)}</li>`) : "";
  });
  setTimeout(() => { q.focus({ preventScroll: true }); N.keyboard(true); }, 350);
}
function openBookWords() {
  const ws = bookWords();
  openSheet(`<div class="sh-head"><h3>本书生词</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
    <div class="sh-body flush">${ws.length ? `<ul class="list">${ws.map(([w, m]) => `<li><button data-go-ch="${m.pos ? m.pos.ch : ""}" data-off="${m.pos ? m.pos.off : ""}"><span class="lw">${esc(w)}</span><span class="lm">${esc(m.sense || senseOf(w))}</span></button></li>`).join("")}</ul>` : '<div class="empty">长按书里的单词，加入生词本后会出现在这里</div>'}</div>`);
}
const THEMES = [["original", "原色", "#fcfcfd", "#1c2024"], ["quiet", "安静", "#212225", "#b0b4ba"], ["paper", "纸张", "#f9f9f8", "#21201c"], ["bold", "粗体", "#fcfcfd", "#1c2024"], ["calm", "平静", "#f2f0e7", "#3b352b"], ["focus", "专注", "#111110", "#ffe7b3"]];
/* 阅读设置：书（R）和课程文章（.art）共用一套状态；有书时同步分页，没有书时只改 CSS 变量 */
function readerSurface() { return R ? R.r : $(".art"); }
function setReaderTheme(k) {
  const wasBold = st.theme === "bold";
  st.theme = k; saveReaderPrefs();
  const surface = readerSurface(); if (surface) surface.dataset.theme = k;
  $$(".kb-read, .kb-pane").forEach(n => { n.dataset.theme = k; });
  if (R && wasBold !== (st.theme === "bold")) { relayout(); invalidatePages(); }
}
function stepReaderSize(d) {
  st.size = Math.max(14, Math.min(26, st.size + d)); saveReaderPrefs();
  const surface = readerSurface(); if (surface) applyTypo(surface);
  if (R) { const a = anchorOffset(); layout(a); invalidatePages(); }
}
async function setReaderPref(k, v) {
  st[k] = v; saveReaderPrefs();
  const surface = readerSurface();
  if (k === "font") {
    if (surface) surface.dataset.font = st.font;
    await document.fonts.ready;
    if (R) { const a = anchorOffset(); layout(a); invalidatePages(); }
  }
  if (k === "lh" || k === "margin") {
    if (surface) applyTypo(surface);
    if (R) { const a = anchorOffset(); layout(a); invalidatePages(); }
  }
  if (k === "turn" && R) demoTurn();
}
async function toggleReaderFlag(k, btn) {
  st[k] = !st[k]; saveReaderPrefs(); btn.setAttribute("aria-checked", st[k]);
  const surface = readerSurface(); if (surface) applyTypo(surface);
  if (!R) return;
  const a = anchorOffset();
  if (k === "pub") { chCache.clear(); dropBookCss(); R.r.dataset.dropcap = ""; await loadChapter(R.ch, { off: a }); }
  else layout(a);
  invalidatePages();
}
function toggleSpread(btn) {
  if (!R) return;
  st.spread = !st.spread; saveReaderPrefs(); btn.setAttribute("aria-checked", st.spread);
  relayout(); invalidatePages();
}
function openThemes(forArt = false) {
  const seg = (key, opts) => `<span class="mini">${opts.map(([v, t]) => `<button data-set="${key}" data-v="${v}" aria-pressed="${st[key] === v}">${t}</button>`).join("")}</span>`;
  const fontOpts = forArt ? [["literata", "Literata"], ["source", "Source Serif"], ["sans", "系统"]] : [["literata", "Literata"], ["source", "Source Serif"], ["sans", "无衬线"]];
  openSheet(`<div class="sh-head"><h3>${forArt ? "主题与字号" : "主题与设置"}</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
    <div class="sh-body">
      <div class="size-row"><div class="seg2"><button data-size="-1" aria-label="缩小字号" style="font-size:14px">A</button><button data-size="1" aria-label="放大字号" style="font-size:28px">A</button></div></div>
      <div class="themes">${THEMES.map(([k, n, bg, fg]) => `<button class="th" data-th="${k}" aria-pressed="${st.theme === k}" style="--tb:${bg};--tf:${fg}"><span class="aa" style="${k === "bold" ? "font-weight:700" : ""}">Aa</span><span class="nm">${n}</span></button>`).join("")}</div>
      <div class="opts">
        <div class="opt"><span>字体</span>${seg("font", fontOpts)}</div>
        <div class="opt"><span>行距</span>${seg("lh", [["s", "紧凑"], ["m", "适中"], ["l", "宽松"]])}</div>
        <div class="opt"><span>两端对齐</span><button class="switch" role="switch" data-sw="justify" aria-checked="${st.justify}" aria-label="两端对齐"></button></div>
        ${forArt ? "" : `<div class="opt"><span>页边距</span>${seg("margin", [["s", "窄"], ["m", "中"], ["l", "宽"]])}</div>
        <div class="opt"><span>原书排版</span><button class="switch" role="switch" data-sw="pub" aria-checked="${st.pub}" aria-label="原书排版"></button></div>
        <div class="opt"><span>翻页</span>${seg("turn", [["curl", "仿真"], ["slide", "滑动"], ["fade", "淡入"], ["none", "无"]])}</div>
        ${spreadAvailable() ? `<div class="opt"><span>双页</span><button class="switch" role="switch" data-spread aria-checked="${st.spread}" aria-label="双页"></button></div>` : ""}`}
      </div>
    </div>`);
}

/* ---------- 设置 ---------- */
function openSettings() {
  if (st.kb) N.keyboard(false);
  openSheet(`<div class="sh-head"><h3>设置</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
    <div class="sh-body">
      <div class="opts" style="margin-top:0">
        <div class="opt"><span>界面主题</span><span class="mini">${[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]].map(([v, t]) => `<button data-ut="${v}" aria-pressed="${settings.uitheme === v}">${t}</button>`).join("")}</span></div>
        <div class="opt"><span>Jev 判断生词</span><button class="txt-btn" data-st="testjev">测试连接</button></div>
        <div class="opt"><span>在线更新</span><button class="txt-btn" data-st="update" data-update-state="idle">检查更新</button></div>
        <div class="opt"><span>音量键翻页</span><button class="switch" role="switch" data-st="volume" aria-checked="${!!settings.volume}" aria-label="音量键翻页"></button></div>
      </div>
      <label class="fl"><span>读者水平</span><textarea class="field" data-sf="level">${esc(settings.level)}</textarea></label>
      <div class="opts"><div class="opt"><span>「认识」的词</span><button class="txt-btn" data-st="clearknown">${known.size ? `清除 ${known.size} 个` : "没有记录"}</button></div></div>
      <div class="about">书边译 ${esc(N.version())}<br>词典 ECDICT，MIT 许可<br>字体 Literata、Source Serif 4，SIL Open Font License</div>
    </div>`, "", () => {});
}

handlers.update = d => {
  const b = sheet.querySelector('[data-st="update"]');
  if (!b) return;
  const state = d.state || "error";
  b.dataset.updateState = state;
  b.disabled = state === "checking" || state === "downloading";
  if (state === "checking") b.textContent = "正在检查";
  else if (state === "available") {
    b.disabled = false;
    b.textContent = `更新到 ${d.version}`;
    toast(d.notes ? `发现新版本 ${d.version}：${d.notes}` : `发现新版本 ${d.version}`);
  } else if (state === "downloading") b.textContent = `${d.percent || 0}%`;
  else if (state === "ready") b.textContent = "已打开安装器";
  else if (state === "permission") { b.disabled = false; b.textContent = "允许后再试"; toast(d.msg || "请允许安装未知应用"); }
  else if (state === "current") { b.disabled = false; b.textContent = "已是最新"; toast("当前已是最新版本"); }
  else { b.disabled = false; b.dataset.updateState = "idle"; b.textContent = "检查更新"; toast(d.msg || "检查更新失败"); }
};
sheet.addEventListener("change", e => {
  const f = e.target.closest("[data-sf]"); if (!f) return;
  settings[f.dataset.sf] = f.value.trim() || DEFAULT_LEVEL;
  kv.set("settings", settings);
});

sheet.addEventListener("click", async e => {
  if (e.target.closest("[data-close]")) { closeSheet(); return; }
  const ut = e.target.closest("[data-ut]");
  if (ut) {
    settings.uitheme = ut.dataset.ut; kv.set("settings", settings); applyUITheme();
    $$("[data-ut]", sheet).forEach(b => b.setAttribute("aria-pressed", b === ut));
    if (!R) N.bars(true, !darkUI());
    return;
  }
  const swap = e.target.closest("[data-swap]");
  if (swap) { const l = !document.documentElement.classList.contains("side-l"); document.documentElement.classList.toggle("side-l", l); kv.set("cardSide", l ? "l" : "r"); return; }
  const bk = e.target.closest("[data-bk]");
  if (bk) {
    const id = sheet.dataset.book;
    if (bk.dataset.bk === "toggle") { const p = progOf(id); p.status = p.status === "done" ? "reading" : "done"; if (p.status === "done") p.progress = 1; saveProg(); closeSheet(); renderLibrary(); }
    else if (bk.textContent !== "确认删除") bk.textContent = "确认删除";
    else { N.deleteBook(id); BOOKS = BOOKS.filter(b => b.id !== id); delete prog[id]; saveProg(); closeSheet(); renderLibrary(); toast("已删除"); }
    return;
  }
  const s = e.target.closest("[data-st]");
  if (s) {
    if (s.dataset.st === "volume") { settings.volume = !settings.volume; s.setAttribute("aria-checked", settings.volume); kv.set("settings", settings); }
    else if (s.dataset.st === "update") {
      if (s.dataset.updateState === "available") {
        s.dataset.updateState = "downloading"; s.disabled = true; s.textContent = "准备下载"; N.installUpdate();
      } else {
        s.dataset.updateState = "checking"; s.disabled = true; s.textContent = "正在检查"; N.checkUpdate();
      }
    }
    else if (s.dataset.st === "clearknown") {
      if (!known.size) return;
      if (s.textContent !== "确认清除") { s.textContent = "确认清除"; return; }
      known.clear(); kv.set("known", []); s.textContent = "没有记录"; toast("已清除");
    } else if (s.dataset.st === "testjev") {
      s.textContent = "正在连接";
      try {
        const a = await jevAsk("It is a way I have of driving off the spleen.", { hard_spleen: { type: "noul", instructions: { word: "spleen", question: NOUL.question }, criteria: NOUL.criteria } });
        s.textContent = a.hard_spleen ? "连接正常" : "返回格式不对";
      } catch (err) { s.textContent = err.message || "连接失败"; }
    }
    return;
  }
  const fw = e.target.closest("[data-fw]"); if (fw) { if (st.kb) N.keyboard(false); $("#fbody").innerHTML = `<div style="padding:4px 20px 0">${wordHTML(lookupWord(fw.dataset.fw), {})}</div>`; return; }
  const th = e.target.closest("[data-th]");
  if (th) {
    setReaderTheme(th.dataset.th);
    $$("[data-th]", sheet).forEach(b => b.setAttribute("aria-pressed", b === th));
    return;
  }
  const sz = e.target.closest("[data-size]");
  if (sz) { stepReaderSize(+sz.dataset.size); return; }
  const set = e.target.closest("[data-set]");
  if (set) {
    await setReaderPref(set.dataset.set, set.dataset.v);
    $$(`[data-set="${set.dataset.set}"]`, sheet).forEach(b => b.setAttribute("aria-pressed", b === set));
    return;
  }
  const sw = e.target.closest("[data-sw]");
  if (sw) { await toggleReaderFlag(sw.dataset.sw, sw); return; }
  const sp = e.target.closest("[data-spread]");
  if (sp) { toggleSpread(sp); return; }
  if (!R) return;
  const go = e.target.closest("[data-go-ch]");
  if (go && go.dataset.goCh !== "") {
    closeSheet();
    const ch = +go.dataset.goCh, off = go.dataset.off, frag = go.dataset.frag;
    if (off != null && off !== "") { if (ch === R.ch) setPage(pageForOffset(+off)); else await loadChapter(ch, { off: +off }); }
    else await loadChapter(ch, frag ? { frag } : { page: 0 });
    return;
  }
});
async function demoTurn() { // 选了翻页方式后，在书页上演示一次
  if (st.turn === "none" || !R) return;
  await wait(150);
  const fwd = R.page + (R.spread ? 2 : 1) < R.pages;
  await turn(fwd ? 1 : -1); await wait(180); await turn(fwd ? -1 : 1);
}

/* ===================== 拍照找生词 ===================== */
function openCamera(fromAlbum) {
  if (st.kb) N.keyboard(false);
  document.activeElement?.blur?.();
  st.awaitScan = true;
  if (fromAlbum) N.album(); else N.camera();
}
handlers.scanImage = d => {
  st.awaitScan = false;
  document.activeElement?.blur?.(); N.keyboard(false);
  st.scan = { url: d.url, w: d.w, h: d.h, t0: Date.now(), hard: [], maybe: [], words: [], offline: false, done: false };
  st.more = false;
  cam.className = "cam";
  cam.innerHTML = `
    <div class="photo-bg"></div>
    <div class="photo" id="photo"><img src="${esc(d.url)}" alt=""><div class="scanline"></div></div>
    <div class="res" id="res"></div>`;
  placePhoto();
  void cam.offsetWidth; cam.classList.add("on", "result");
  $("#res", cam).innerHTML = `<div class="res-head"><button class="back" data-c="cancel">${I.chev}查单词</button><span class="sp"></span></div><div class="sum" id="stage-t">正在识别文字</div>`;
  cam.classList.add("listed");
};
function placePhoto() {
  const s = st.scan; if (!s) return;
  const [W, H] = dims(), top = sat(), pbg = $(".photo-bg", cam), res = $("#res", cam), ph = $("#photo", cam);
  const box = st.screen === "outer" ? { x: 0, y: top, w: W, h: Math.round(H * 0.42) } : { x: 0, y: top, w: W - 380, h: H - top };
  Object.assign(pbg.style, { left: box.x + "px", top: box.y + "px", width: box.w + "px", height: box.h + "px" });
  const k = Math.min((box.w - 40) / s.w, (box.h - 30) / s.h);
  s.k = k;
  Object.assign(ph.style, { width: s.w * k + "px", height: s.h * k + "px", left: box.x + (box.w - s.w * k) / 2 + "px", top: box.y + (box.h - s.h * k) / 2 + "px" });
  if (st.screen === "outer") Object.assign(res.style, { left: "0px", width: W + "px", top: box.y + box.h + "px", bottom: "0px", borderLeft: "0" });
  else Object.assign(res.style, { left: W - 380 + "px", width: "380px", top: top + "px", bottom: "0px", borderLeft: "0.5px solid var(--line)" });
}
handlers.scanCancel = () => { st.awaitScan = false; };
handlers.ocr = async r => {
  const s = st.scan; if (!s || !cam.classList.contains("on")) return;
  if (!r.ok) {
    $("#res", cam).innerHTML = `<div class="res-head"><button class="back" data-c="cancel">${I.chev}查单词</button><span class="sp"></span></div>
      <div class="fail"><span style="font-size:17px">没有识别到文字</span><button class="pill primary" data-c="again" style="flex:none">重拍</button></div>`;
    return;
  }
  s.words = r.words; s.passage = r.passage;
  const line = $(".scanline", cam), h = $("#photo", cam).offsetHeight;
  const judging = judge(r.cands, r.passage);
  if (!reduced) await line.animate([{ top: "-70px", opacity: 1 }, { top: h - 70 + "px", opacity: 1, offset: .92 }, { top: h - 70 + "px", opacity: 0 }], { duration: 1150, easing: "cubic-bezier(.45,.05,.4,1)" }).finished;
  const t = $("#stage-t", cam); if (t) t.textContent = "正在判断哪些是生词";
  await judging;
  if (st.scan !== s) return;
  s.done = true; s.ms = Date.now() - s.t0;
  drawMarks();
  $$(".hw2", cam).forEach((x, i) => setTimeout(() => x.classList.add("lit"), i * 60));
  renderScanList();
};
async function judge(cands, passage) {
  const s = st.scan;
  cands = cands.slice().sort((a, b) => b.rank - a.rank).slice(0, 40);
  try {
    if (!N.hasJev() || !cands.length) throw new Error("offline");
    const q = {};
    cands.forEach(c => { q["hard_" + qid(c.lemma)] = { type: "noul", instructions: { word: c.w, question: NOUL.question }, criteria: NOUL.criteria }; });
    const a = await jevAsk(passage, q);
    cands.forEach(c => { c.p = a["hard_" + qid(c.lemma)]?.noul ?? 0; });
    s.hard = cands.filter(c => c.p >= 0.5).sort((x, y) => y.p - x.p);
    s.maybe = cands.filter(c => c.p < 0.5).sort((x, y) => y.p - x.p);
    const q2 = {};
    s.hard.forEach(c => { const items = senseItems(lookupWord(c.lemma)); if (items.length > 1) q2["sense_" + qid(c.lemma)] = senseQuestion(c.w, items); });
    if (Object.keys(q2).length) {
      try { const a2 = await jevAsk(passage, q2); s.hard.forEach(c => { c.sense = a2["sense_" + qid(c.lemma)]?.choice || ""; }); } catch (e) { /* 语境义拿不到时只显示词典释义 */ }
    }
  } catch (e) {
    s.offline = true; s.hard = cands.slice(0, 20); s.maybe = [];
  }
}
function drawMarks() {
  const s = st.scan, ph = $("#photo", cam);
  $$(".hw2", ph).forEach(m => m.remove());
  const hard = new Set(s.hard.map(c => c.lemma).filter(l => !known.has(l)));
  for (const w of s.words) {
    if (!hard.has(w.lemma)) continue;
    const m = el("span", "hw2"); m.dataset.sw = w.lemma;
    Object.assign(m.style, { left: w.x * s.k - 2 + "px", top: w.y * s.k - 1 + "px", width: w.w * s.k + 4 + "px", height: w.h * s.k + 2 + "px" });
    ph.append(m);
  }
}
function renderScanList() {
  const s = st.scan;
  const hard = s.hard.filter(x => !known.has(x.lemma)), maybe = s.maybe.filter(x => !known.has(x.lemma));
  const row = (x, i) => {
    const info = lookupWord(x.lemma), on = saved.has(info.lemma);
    return `<li style="animation-delay:${i * 50}ms" data-sw="${esc(x.lemma)}"><div class="row"><span><span class="lw">${esc(info.lemma)}</span>${x.w !== x.lemma ? `<span class="note" style="margin-left:6px">原文 ${esc(x.w)}</span>` : ""}${info.phonetic ? `<span class="note" style="margin-left:6px">/${esc(info.phonetic)}/</span>` : ""}</span>
      <span class="rowacts"><button data-ss="${esc(info.lemma)}" aria-pressed="${on}" aria-label="收藏">${on ? I.starOn : I.star}</button><button data-known="${esc(x.lemma)}" aria-label="认识">${I.check}</button></span>
      <span class="lm">${esc(x.sense || senseOf(info.lemma))}${x.sense ? '<span class="tagc">本句</span>' : ""}</span></div></li>`;
  };
  const sum = s.offline ? "离线判断，可能不准" : `${hard.length} 个生词，识别和判断共 ${(s.ms / 1000).toFixed(1)} 秒`;
  $("#res", cam).innerHTML = `<div class="res-head"><button class="back" data-c="cancel">${I.chev}查单词</button><span class="sp"></span><button class="txt-btn" data-c="again">重拍</button></div>
    <div class="sum">${sum}</div>
    <div class="scroll"><ul class="list">${hard.length ? hard.map(row).join("") : '<li class="empty">这一页没有生词</li>'}${st.more ? '<li><div class="sec-s" style="padding-left:0">可能认识</div></li>' + maybe.map((x, i) => row(x, i + hard.length)).join("") : ""}</ul>
    ${maybe.length ? `<button class="more" data-c="more">${st.more ? "收起" : `还有 ${maybe.length} 个可能认识的词`}</button>` : ""}</div>`;
}
function closeCam() { cam.classList.remove("on"); st.scan = null; }
if (!CARD) {
  cam.addEventListener("click", e => {
    const c = e.target.closest("[data-c]");
    if (c) {
      const a = c.dataset.c;
      if (a === "cancel") closeCam();
      else if (a === "again") { st.awaitScan = true; N.camera(); }
      else if (a === "more") { st.more = !st.more; renderScanList(); }
      return;
    }
    const ss = e.target.closest("[data-ss]");
    if (ss) { const x = [...st.scan.hard, ...st.scan.maybe].find(c => c.lemma === ss.dataset.ss); toggleSave(ss.dataset.ss, "拍照", null, { word: x?.w, sense: x?.sense || "", sentence: "" }); renderScanList(); return; }
    const kn = e.target.closest("[data-known]");
    if (kn) { known.add(kn.dataset.known); kv.set("known", [...known]); $$(`.hw2[data-sw="${CSS.escape(kn.dataset.known)}"]`, cam).forEach(h => h.classList.add("gone")); renderScanList(); toast("以后不再列出这个词"); return; }
    const sw = e.target.closest("[data-sw]");
    if (sw) {
      $$(".on[data-sw]", cam).forEach(n => n.classList.remove("on"));
      $$(`[data-sw="${CSS.escape(sw.dataset.sw)}"]`, cam).forEach(n => n.classList.add("on"));
      if (sw.matches(".hw2")) $(`li[data-sw="${CSS.escape(sw.dataset.sw)}"]`, cam)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      else if (!sw.matches(".hw2")) { const x = [...st.scan.hard, ...st.scan.maybe].find(c => c.lemma === sw.dataset.sw); if (x && st.screen === "outer") showWordCard(x.lemma, "拍照"); }
    }
  });
}
function showWordCard(word, src) { const info = lookupWord(word); st.pickSrc = src; openSheet(`<div class="sh-body">${wordHTML(info, { close: true })}</div>`, "lk-card"); }

/* ===================== 外屏 / 内屏 ===================== */
let lastW = innerWidth;
async function setScreen(s) {
  if (s === st.screen) return;
  const anchor = R ? anchorOffset() : null;
  st.screen = s; fit();
  if (sheet.classList.contains("on") && !CARD) closeSheet();
  if (!CARD) render(st.tab);
  if (R) { hideLookup(); layout(anchor); invalidatePages(); }
  if (KB.view === "read") kbRestoreRatio();
  if (KBV.open) kbvFit("width");
  KB.lastViewport = innerWidth + "x" + innerHeight;
  if (cam.classList?.contains("on")) { placePhoto(); if (st.scan?.done) drawMarks(); $$(".hw2", cam).forEach(x => x.classList.add("lit")); }
}
new ResizeObserver(() => {
  const s = innerWidth >= 600 ? "inner" : "outer";
  const vp = innerWidth + "x" + innerHeight;
  if (CARD) { document.documentElement.classList.toggle("inner-card", s === "inner"); st.screen = s; fit(); KB.lastViewport = vp; return; }
  if (s !== st.screen) { setScreen(s); lastW = innerWidth; KB.lastViewport = vp; return; }
  if (KB.lastViewport && KB.lastViewport !== vp) {
    KB.lastViewport = vp;
    if (KB.view === "read") kbRestoreRatio();
    if (KBV.open) kbvFit("width");
  }
  if (R && !st.busy && !st.kb && Math.abs(innerWidth - lastW) + Math.abs(innerHeight - R.H) > 1) { relayout(); invalidatePages(); }
  lastW = innerWidth;
  if (cam.classList?.contains("on") && st.scan) { placePhoto(); if (st.scan.done) drawMarks(); $$(".hw2", cam).forEach(x => x.classList.add("lit")); }
}).observe(document.documentElement);

/* ===================== 返回键 ===================== */
window.onBack = () => {
  if (CARD) { closeCard(); return true; }
  if (kbViewerOpen()) { kbCloseViewer(); return true; }
  if (sheet.classList.contains("on")) { closeSheet(); return true; }
  if (cam.classList.contains("on")) { closeCam(); return true; }
  if (R) {
    if (R.lk.classList.contains("on")) { hideLookup(); return true; }
    if (R.menu.classList.contains("on")) { R.menu.classList.remove("on"); return true; }
    closeBook(); return true;
  }
  if (st.tab === "kb" && KB.view === "read" && KB.full) { kbSetFull(false, false); return true; }
  if (st.tab === "kb" && (KB.view === "read" || KB.view === "list")) { kbBack(); return true; }
  if (st.tab === "physical" && (st.query || st.pick)) { clearQuery(); return true; }
  if (st.tab !== "physical") { setTab("physical"); return true; }
  return false;
};

/* ===================== 外部入口卡片 ===================== */
function closeCard() { closeSheet(); setTimeout(() => N.close(), reduced ? 0 : 300); }
function cardFor(text) {
  const words = text.match(/[A-Za-z][A-Za-z’'\-]*/g) || [];
  if (words.length > 1 && N.hasTr()) {
    openSheet(`<div class="sh-head"><h3>整句翻译</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
      <div class="sh-body"><div class="wd"><div class="trx src">${esc(text.trim())}</div><div class="trx" id="trout"></div></div></div>`, "lk-card", closeCard);
    translateText(text.trim(), $("#trout"));
  } else if (words.length) {
    openSheet(`<div class="sh-body" style="padding-top:14px">${wordHTML(lookupWord(words[0]), { close: true, swap: st.screen === "inner" })}</div>`, "lk-card", closeCard);
  } else {
    openSheet(`<div class="sh-head"><h3>查单词</h3><button class="x" data-close aria-label="关闭">${I.x}</button></div>
      <div class="sh-body flush" id="fbody"><label class="search">${I.search}<input id="fq" placeholder="输入单词" autocomplete="off" autocapitalize="off" spellcheck="false"></label><ul class="list" id="fres" style="margin-top:8px"></ul></div>`, "lk-card", closeCard);
    const q = $("#fq"), res = $("#fres");
    q.addEventListener("input", () => {
      const v = q.value.trim();
      res.innerHTML = v ? (JSON.parse(N.prefix(v)).slice(0, 8).map(h => `<li><button data-fw="${esc(h.w)}"><span class="lw">${esc(h.w)}</span><span class="lm">${esc(h.m)}</span></button></li>`).join("") || `<li class="empty">词典里没有 ${esc(v)}</li>`) : "";
    });
    setTimeout(() => { q.focus({ preventScroll: true }); N.keyboard(true); }, 350);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => N.perf("card_paint", Math.round(performance.now()))));
}
async function startCard() {
  document.documentElement.classList.add("card-mode");
  if (kv.get("cardSide", "r") === "l") document.documentElement.classList.add("side-l");
  st.screen = innerWidth >= 600 ? "inner" : "outer"; fit();
  document.documentElement.classList.toggle("inner-card", st.screen === "inner");
  let q = params.get("q") || "";
  // 剪贴板只在窗口获得焦点后才能读
  if (params.get("clip")) for (let i = 0; i < 10 && !q; i++) { await wait(80); q = N.clip(); }
  cardFor(q);
}

// 回到 App 时不主动弹出键盘：查单词页保持展示，键盘由用户点输入框再弹
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && !CARD && st.kb) { document.activeElement?.blur?.(); N.keyboard(false); }
});

/* ===================== 启动 ===================== */
if (CARD) startCard();
else { fit(); setTab("physical"); }
N.ready();
