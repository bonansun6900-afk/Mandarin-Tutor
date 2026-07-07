/* 读报 Mandarin Reader — dictionary lookup, segmentation, article reader, vocab. */
"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const CFG = window.APP_CONFIG || {};
// "?offline" forces localStorage mode (useful for testing without Supabase)
const hasSupabase = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY) &&
  !new URLSearchParams(location.search).has("offline");

const state = {
  dict: new Map(),      // headword (simp or trad) -> [{simp, trad, pinyin, defs}]
  maxWordLen: 1,
  hsk: {},              // word -> level 1..6
  articles: [],
  current: null,
  filters: { level: "intermediate", topic: "", source: "", search: "" },
  vocab: [],            // [{word, pinyin, definition, context}]
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Pinyin: numbered syllables ("zhong1 guo2") -> tone marks ("zhōng guó")
// ---------------------------------------------------------------------------
const TONE_MARKS = {
  a: "āáǎàa", e: "ēéěèe", i: "īíǐìi", o: "ōóǒòo", u: "ūúǔùu", ü: "ǖǘǚǜü",
};
function toneSyllable(syl) {
  const m = syl.match(/^([a-zA-ZüÜ:]+)([1-5])$/);
  if (!m) return syl.replace(/u:/g, "ü");
  let body = m[1].replace(/u:/gi, "ü").replace(/v/g, "ü");
  const tone = parseInt(m[2], 10);
  if (tone === 5) return body;
  const lower = body.toLowerCase();
  let idx = -1;
  if (lower.includes("a")) idx = lower.indexOf("a");
  else if (lower.includes("e")) idx = lower.indexOf("e");
  else if (lower.includes("ou")) idx = lower.indexOf("o");
  else {
    for (let i = lower.length - 1; i >= 0; i--) {
      if ("iouü".includes(lower[i])) { idx = i; break; }
    }
  }
  if (idx === -1) return body;
  const ch = lower[idx];
  const marked = TONE_MARKS[ch] ? TONE_MARKS[ch][tone - 1] : body[idx];
  const isUpper = body[idx] !== lower[idx];
  return body.slice(0, idx) + (isUpper ? marked.toUpperCase() : marked) + body.slice(idx + 1);
}
function prettyPinyin(numbered) {
  return numbered.split(/\s+/).map(toneSyllable).join(" ");
}

// ---------------------------------------------------------------------------
// Dictionary loading (CC-CEDICT)
// ---------------------------------------------------------------------------
async function loadDictionary() {
  const res = await fetch("data/cedict_ts.u8");
  if (!res.ok) throw new Error("Failed to load dictionary");
  const text = await res.text();
  const lineRe = /^(\S+)\s(\S+)\s\[([^\]]+)\]\s\/(.+)\/\s*$/;
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const m = line.match(lineRe);
    if (!m) continue;
    const [, trad, simp, pinyin, defsRaw] = m;
    const entry = { simp, trad, pinyin, defs: defsRaw.split("/").filter(Boolean) };
    for (const key of simp === trad ? [simp] : [simp, trad]) {
      if (!state.dict.has(key)) state.dict.set(key, []);
      state.dict.get(key).push(entry);
    }
    if (simp.length > state.maxWordLen) state.maxWordLen = Math.min(simp.length, 8);
  }
}

async function loadHsk() {
  try {
    const res = await fetch("data/hsk.json");
    if (res.ok) state.hsk = await res.json();
  } catch { /* difficulty badges just won't show */ }
}

// ---------------------------------------------------------------------------
// Segmentation: greedy longest-match against the dictionary
// ---------------------------------------------------------------------------
const CJK_RE = /[㐀-鿿豈-﫿]/;

function segment(text) {
  const tokens = [];
  let i = 0;
  let plain = "";
  const flushPlain = () => { if (plain) { tokens.push({ t: plain, dict: false }); plain = ""; } };
  while (i < text.length) {
    if (!CJK_RE.test(text[i])) { plain += text[i]; i++; continue; }
    flushPlain();
    let matched = null;
    const max = Math.min(state.maxWordLen, text.length - i);
    for (let len = max; len >= 1; len--) {
      const cand = text.substr(i, len);
      if (state.dict.has(cand)) { matched = cand; break; }
    }
    if (matched) {
      tokens.push({ t: matched, dict: true });
      i += matched.length;
    } else {
      tokens.push({ t: text[i], dict: false });
      i++;
    }
  }
  flushPlain();
  return tokens;
}

// ---------------------------------------------------------------------------
// Supabase REST helpers (no SDK needed)
// ---------------------------------------------------------------------------
function sbHeaders() {
  const h = { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" };
  // Legacy anon keys are JWTs and must also go in the Authorization header;
  // new sb_publishable_* keys are sent via apikey only.
  if (CFG.SUPABASE_ANON_KEY.startsWith("eyJ")) {
    h.Authorization = `Bearer ${CFG.SUPABASE_ANON_KEY}`;
  }
  return h;
}
async function sbGet(path) {
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}
async function sbPost(table, row) {
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}
async function sbPatch(table, filter, patch) {
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: sbHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}
async function sbDelete(table, filter) {
  const res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: sbHeaders(),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------
async function loadArticles() {
  if (hasSupabase) {
    try {
      state.articles = await sbGet("articles?select=*&order=published_at.desc.nullslast&limit=300");
      return;
    } catch (err) {
      console.error("Supabase load failed, falling back to local file:", err);
    }
  }
  try {
    const res = await fetch("data/articles.local.json");
    state.articles = res.ok ? await res.json() : [];
  } catch {
    state.articles = [];
  }
}

// ---------------------------------------------------------------------------
// Vocab (Supabase if configured, else localStorage)
// ---------------------------------------------------------------------------
const VOCAB_KEY = "mandarin-reader-vocab";

async function loadVocab() {
  if (hasSupabase) {
    try {
      state.vocab = await sbGet("vocab?select=*&order=created_at.desc");
      return;
    } catch (err) {
      console.error("Vocab load failed:", err);
    }
  }
  try { state.vocab = JSON.parse(localStorage.getItem(VOCAB_KEY) || "[]"); }
  catch { state.vocab = []; }
}

async function saveVocabWord(item) {
  if (state.vocab.some((v) => v.word === item.word)) return;
  // Flashcard defaults; in Supabase mode the table defaults do the same.
  item = { ...item, box: 0, due_at: new Date().toISOString(), reviews: 0 };
  state.vocab.unshift(item);
  updateVocabCount();
  if (hasSupabase) {
    const { box, due_at, reviews, ...row } = item; // let DB defaults fill SRS columns
    try { await sbPost("vocab", row); return; } catch (err) { console.error(err); }
  }
  localStorage.setItem(VOCAB_KEY, JSON.stringify(state.vocab));
}

async function removeVocabWord(word) {
  state.vocab = state.vocab.filter((v) => v.word !== word);
  updateVocabCount();
  if (hasSupabase) {
    try { await sbDelete("vocab", `word=eq.${encodeURIComponent(word)}`); return; }
    catch (err) { console.error(err); }
  }
  localStorage.setItem(VOCAB_KEY, JSON.stringify(state.vocab));
}

function isSaved(word) { return state.vocab.some((v) => v.word === word); }
function updateVocabCount() { $("vocabCount").textContent = state.vocab.length; }

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------
const TOPIC_LABELS = {
  economy: "经济 Economy", trade: "贸易 Trade", tech: "科技 Tech",
  business: "商业 Business", culture: "文化 Culture", arts: "艺术 Arts",
  society: "社会 Society", world: "国际 World", science: "科学 Science",
};
function topicLabel(t) { return TOPIC_LABELS[t] || t || "其他 Other"; }

function visibleArticles() {
  const { level, topic, source, search } = state.filters;
  const q = search.trim().toLowerCase();
  return state.articles.filter((a) =>
    (!level || a.level === level) &&
    (!topic || a.topic === topic) &&
    (!source || a.source === source) &&
    (!q || (a.title || "").toLowerCase().includes(q) || (a.content || "").toLowerCase().includes(q))
  );
}

function renderTopicChips() {
  const topics = [...new Set(state.articles.map((a) => a.topic).filter(Boolean))];
  const box = $("topicChips");
  box.innerHTML = "";
  const all = document.createElement("button");
  all.className = "chip" + (state.filters.topic === "" ? " active" : "");
  all.textContent = "全部 All";
  all.onclick = () => { state.filters.topic = ""; renderList(); };
  box.appendChild(all);
  for (const t of topics) {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.filters.topic === t ? " active" : "");
    chip.textContent = topicLabel(t);
    chip.onclick = () => { state.filters.topic = state.filters.topic === t ? "" : t; renderList(); };
    box.appendChild(chip);
  }
}

function renderSourceFilter() {
  const sources = [...new Set(state.articles.map((a) => a.source).filter(Boolean))].sort();
  const sel = $("sourceFilter");
  const current = state.filters.source;
  sel.innerHTML = '<option value="">All sources</option>' +
    sources.map((s) => `<option${s === current ? " selected" : ""}>${s}</option>`).join("");
}

function renderList() {
  renderTopicChips();
  renderSourceFilter();
  const list = $("articleList");
  list.innerHTML = "";
  const items = visibleArticles();
  const empty = $("listEmpty");
  if (!state.articles.length) {
    empty.innerHTML = hasSupabase
      ? "数据库里还没有文章。Run <code>npm run scrape</code> to fetch news articles."
      : "还没有文章。Run <code>npm run scrape:local</code> to fetch news articles (no Supabase needed), or add your Supabase keys to <code>config.js</code>.";
    empty.classList.remove("hidden");
    return;
  }
  if (!items.length) {
    empty.textContent = "No articles match these filters — try another level or topic.";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  for (const a of items) {
    const card = document.createElement("div");
    card.className = "card";
    const excerpt = (a.content || "").replace(/\s+/g, " ").slice(0, 80);
    const date = a.published_at ? new Date(a.published_at).toLocaleDateString() : "";
    card.innerHTML = `
      <h2 class="zh">${escapeHtml(a.title)}</h2>
      <p class="excerpt zh">${escapeHtml(excerpt)}…</p>
      <div class="card-meta">
        <span class="badge ${a.level || "advanced"}">${(a.level || "?").toUpperCase()}</span>
        <span class="topic-tag">${escapeHtml(topicLabel(a.topic))}</span>
        <span>${escapeHtml(a.source || "")}</span>
        <span>${date}</span>
        <span>${a.word_count || ""} 字</span>
      </div>`;
    card.onclick = () => openArticle(a);
    list.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Reader view
// ---------------------------------------------------------------------------
function renderSegmented(container, text) {
  container.innerHTML = "";
  for (const tok of segment(text)) {
    if (tok.dict) {
      const span = document.createElement("span");
      span.className = "w" + (isSaved(tok.t) ? " saved" : "");
      span.textContent = tok.t;
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(tok.t));
    }
  }
}

function openArticle(a) {
  state.current = a;
  closePopup();
  $("listView").classList.add("hidden");
  $("vocabView").classList.add("hidden");
  $("flashView").classList.add("hidden");
  $("readerView").classList.remove("hidden");
  const date = a.published_at ? new Date(a.published_at).toLocaleDateString() : "";
  $("articleMeta").innerHTML = `
    <span class="badge ${a.level || "advanced"}">${(a.level || "?").toUpperCase()}</span>
    <span class="topic-tag">${escapeHtml(topicLabel(a.topic))}</span>
    <span>${escapeHtml(a.source || "")}</span>
    <span>${date}</span>
    ${a.url ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">原文 ↗</a>` : ""}`;
  renderSegmented($("articleTitle"), a.title || "");
  const body = $("articleBody");
  body.innerHTML = "";
  const paragraphs = (a.content || "").split(/\n+/).filter((p) => p.trim());
  for (const p of paragraphs) {
    const el = document.createElement("p");
    renderSegmented(el, p.trim());
    body.appendChild(el);
  }
  window.scrollTo(0, 0);
}

function showList() {
  closePopup();
  $("readerView").classList.add("hidden");
  $("vocabView").classList.add("hidden");
  $("flashView").classList.add("hidden");
  $("listView").classList.remove("hidden");
  renderList();
}

// ---------------------------------------------------------------------------
// Word popup
// ---------------------------------------------------------------------------
let activeSpan = null;

function closePopup() {
  $("popup").classList.add("hidden");
  if (activeSpan) { activeSpan.classList.remove("active"); activeSpan = null; }
}

function showPopup(span) {
  const word = span.textContent;
  const entries = state.dict.get(word) || [];
  const popup = $("popup");
  if (activeSpan) activeSpan.classList.remove("active");
  activeSpan = span;
  span.classList.add("active");

  const hskLevel = state.hsk[word];
  const first = entries[0];
  let html = "";
  html += `<div><span class="headword">${escapeHtml(word)}</span>`;
  if (first && first.trad !== first.simp) html += `<span class="trad">〔${escapeHtml(first.trad)}〕</span>`;
  if (hskLevel) html += ` <span class="hsk-badge">HSK ${hskLevel}</span>`;
  html += `</div>`;

  if (entries.length) {
    for (const e of entries.slice(0, 3)) {
      html += `<div class="entry">
        <div class="pinyin">${escapeHtml(prettyPinyin(e.pinyin))}</div>
        <ol>${e.defs.slice(0, 6).map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ol>
      </div>`;
    }
  } else {
    html += `<p class="nodef">No dictionary entry found.</p>`;
  }

  // Per-character breakdown for multi-character words
  if (word.length > 1) {
    let rows = "";
    for (const ch of word) {
      const ce = (state.dict.get(ch) || [])[0];
      if (!ce) continue;
      rows += `<div class="char-row">
        <span class="c">${escapeHtml(ch)}</span>
        <span class="p">${escapeHtml(prettyPinyin(ce.pinyin))}</span>
        <span class="d">${escapeHtml(ce.defs[0] || "")}</span>
      </div>`;
    }
    if (rows) html += `<div class="chars">${rows}</div>`;
  }

  const saved = isSaved(word);
  html += `<div class="popup-actions">
    <button class="btn" id="popupSave" ${saved ? "disabled" : ""}>${saved ? "✓ 已保存" : "★ 保存生词"}</button>
  </div>`;

  popup.innerHTML = html;
  popup.classList.remove("hidden");

  $("popupSave").onclick = async () => {
    const e = entries[0];
    await saveVocabWord({
      word,
      pinyin: e ? prettyPinyin(e.pinyin) : "",
      definition: e ? e.defs.slice(0, 3).join("; ") : "",
      context: state.current ? state.current.title : "",
    });
    span.classList.add("saved");
    $("popupSave").disabled = true;
    $("popupSave").textContent = "✓ 已保存";
  };

  // Position near the word
  const rect = span.getBoundingClientRect();
  const popW = 320;
  let left = window.scrollX + rect.left;
  left = Math.min(left, window.scrollX + document.documentElement.clientWidth - popW - 12);
  left = Math.max(left, window.scrollX + 8);
  popup.style.left = `${left}px`;
  popup.style.top = `${window.scrollY + rect.bottom + 8}px`;
}

document.addEventListener("click", (ev) => {
  const span = ev.target.closest("span.w");
  if (span) { showPopup(span); return; }
  if (!ev.target.closest("#popup")) closePopup();
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePopup(); });

// ---------------------------------------------------------------------------
// Vocab view
// ---------------------------------------------------------------------------
function showVocab() {
  closePopup();
  $("listView").classList.add("hidden");
  $("readerView").classList.add("hidden");
  $("flashView").classList.add("hidden");
  $("vocabView").classList.remove("hidden");
  const due = dueWords().length;
  $("dueCount").textContent = due;
  $("practiceBtn").disabled = !state.vocab.length;
  const list = $("vocabList");
  list.innerHTML = "";
  if (!state.vocab.length) {
    list.innerHTML = '<div class="empty">还没有生词。Click words while reading and press ★ to save them.</div>';
    return;
  }
  for (const v of state.vocab) {
    const item = document.createElement("div");
    item.className = "vocab-item";
    item.innerHTML = `
      <span class="word">${escapeHtml(v.word)}</span>
      <span class="pinyin">${escapeHtml(v.pinyin || "")}</span>
      <span class="def">${escapeHtml(v.definition || "")}</span>
      <button class="remove" title="Remove">✕</button>`;
    item.querySelector(".remove").onclick = async () => {
      await removeVocabWord(v.word);
      showVocab();
    };
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Flashcards — Leitner spaced repetition over saved vocab
// ---------------------------------------------------------------------------
const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30]; // box index → days until next review
let migrationWarned = false;

function dueWords() {
  const now = Date.now();
  return state.vocab.filter((v) => !v.due_at || new Date(v.due_at).getTime() <= now);
}

const flash = { queue: [], done: 0, total: 0, flipped: false };

function startPractice() {
  let cards = dueWords();
  if (!cards.length) cards = [...state.vocab]; // nothing due → free practice
  flash.queue = cards.sort(() => Math.random() - 0.5);
  flash.total = cards.length;
  flash.done = 0;
  closePopup();
  $("listView").classList.add("hidden");
  $("readerView").classList.add("hidden");
  $("vocabView").classList.add("hidden");
  $("flashView").classList.remove("hidden");
  renderFlashCard();
}

function renderFlashCard() {
  const doneEl = $("flashDone");
  const card = $("flashCard");
  if (!flash.queue.length) {
    card.classList.add("hidden");
    $("flashActions").classList.add("hidden");
    $("flashProgress").textContent = "";
    const next = state.vocab
      .map((v) => new Date(v.due_at || 0).getTime())
      .filter((t) => t > Date.now())
      .sort((a, b) => a - b)[0];
    doneEl.innerHTML = `🎉 全部完成！Reviewed ${flash.done} card${flash.done === 1 ? "" : "s"}.` +
      (next ? `<br>Next review: ${new Date(next).toLocaleDateString()}` : "");
    doneEl.classList.remove("hidden");
    return;
  }
  doneEl.classList.add("hidden");
  card.classList.remove("hidden");
  flash.flipped = false;
  const v = flash.queue[0];
  $("flashWord").textContent = v.word;
  $("flashBack").classList.add("hidden");
  $("flashHint").classList.remove("hidden");
  $("flashActions").classList.add("hidden");
  $("flashProgress").textContent = `${flash.done + 1} / ${flash.total}`;
  card.focus({ preventScroll: true });
}

function flipCard() {
  if (flash.flipped || !flash.queue.length) return;
  flash.flipped = true;
  const v = flash.queue[0];
  const box = v.box || 0;
  $("flashBack").innerHTML = `
    <div class="pinyin">${escapeHtml(v.pinyin || "")}</div>
    <div class="def">${escapeHtml(v.definition || "")}</div>
    ${v.context ? `<div class="ctx">出自 · from 《${escapeHtml(v.context)}》</div>` : ""}
    <div class="box-info">box ${box} · reviewed ${v.reviews || 0}×</div>`;
  $("flashBack").classList.remove("hidden");
  $("flashHint").classList.add("hidden");
  $("flashActions").classList.remove("hidden");
}

async function gradeCard(ok) {
  if (!flash.flipped || !flash.queue.length) return;
  const v = flash.queue.shift();
  const now = new Date();
  v.reviews = (v.reviews || 0) + 1;
  v.last_reviewed_at = now.toISOString();
  if (ok) {
    v.box = Math.min((v.box || 0) + 1, BOX_INTERVAL_DAYS.length - 1);
    v.due_at = new Date(now.getTime() + BOX_INTERVAL_DAYS[v.box] * 864e5).toISOString();
    flash.done++;
  } else {
    v.box = 0;
    v.due_at = now.toISOString();
    flash.queue.push(v); // ask again this session
  }
  persistCard(v);
  renderFlashCard();
}

async function persistCard(v) {
  if (hasSupabase) {
    try {
      await sbPatch("vocab", `word=eq.${encodeURIComponent(v.word)}`, {
        box: v.box, due_at: v.due_at, last_reviewed_at: v.last_reviewed_at, reviews: v.reviews,
      });
      return;
    } catch (err) {
      console.error(err);
      if (!migrationWarned && String(err).includes("column")) {
        migrationWarned = true;
        alert("Flashcard progress isn't saving yet: run supabase/migration-flashcards.sql " +
          "in the Supabase SQL Editor (adds the review-state columns).");
      }
      return;
    }
  }
  localStorage.setItem(VOCAB_KEY, JSON.stringify(state.vocab));
}

$("practiceBtn").onclick = startPractice;
$("flashBackBtn").onclick = showVocab;
$("flashCard").onclick = flipCard;
$("flashAgain").onclick = () => gradeCard(false);
$("flashGood").onclick = () => gradeCard(true);
document.addEventListener("keydown", (ev) => {
  if ($("flashView").classList.contains("hidden")) return;
  if (ev.key === " ") { ev.preventDefault(); flipCard(); }
  else if (ev.key === "1") gradeCard(false);
  else if (ev.key === "2") gradeCard(true);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
$("homeBtn").onclick = showList;
$("backBtn").onclick = showList;
$("vocabBackBtn").onclick = () => (state.current ? openArticle(state.current) : showList());
$("vocabBtn").onclick = showVocab;
$("searchBox").oninput = (e) => { state.filters.search = e.target.value; renderList(); };
$("levelFilter").onchange = (e) => { state.filters.level = e.target.value; renderList(); };
$("sourceFilter").onchange = (e) => { state.filters.source = e.target.value; renderList(); };

(async function init() {
  const status = $("dictStatus");
  loadVocab().then(updateVocabCount);
  loadArticles().then(renderList);
  try {
    await Promise.all([loadDictionary(), loadHsk()]);
    status.textContent = `词典 ${state.dict.size.toLocaleString()} 词`;
  } catch (err) {
    console.error(err);
    status.textContent = "⚠ dictionary failed to load";
  }
})();
