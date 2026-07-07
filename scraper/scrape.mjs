/**
 * News scraper for the Mandarin Reader app. Zero npm dependencies.
 *
 * Fetches Chinese-language news RSS feeds, extracts article text, scores
 * difficulty against HSK word lists, and upserts into Supabase (or writes
 * to data/articles.local.json with --local).
 *
 * Usage:
 *   node scraper/scrape.mjs            # scrape into Supabase
 *   node scraper/scrape.mjs --local    # scrape into data/articles.local.json
 *   node scraper/scrape.mjs --limit 5  # max items per source
 *   node scraper/scrape.mjs --source bbc
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, "data");

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
const SOURCES = [
  {
    id: "bbc",
    name: "BBC中文",
    rss: "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml",
    defaultTopic: "world",
  },
  {
    id: "dw",
    name: "德国之声",
    rss: "https://rss.dw.com/rdf/rss-chi-all",
    defaultTopic: "world",
  },
  {
    id: "nyt",
    name: "纽约时报中文网",
    rss: "https://cn.nytimes.com/rss/",
    defaultTopic: "world",
  },
  {
    id: "36kr",
    name: "36氪",
    rss: "https://36kr.com/feed",
    defaultTopic: "tech",
    useRssContent: true, // article pages are JS-rendered; RSS carries full text
  },
  {
    id: "rfi",
    name: "法广RFI",
    rss: "https://www.rfi.fr/cn/rss",
    defaultTopic: "world",
  },
];

// Keyword → topic rules, checked against title + first paragraphs.
const TOPIC_RULES = [
  ["trade", ["贸易", "关税", "出口", "进口", "供应链", "制裁"]],
  ["economy", ["经济", "通胀", "通货膨胀", "GDP", "央行", "利率", "股市", "债券", "房地产", "金融", "汇率", "失业"]],
  ["tech", ["科技", "人工智能", "AI", "芯片", "半导体", "互联网", "软件", "手机", "机器人", "算法", "数据", "电动车", "自动驾驶"]],
  ["business", ["公司", "企业", "创业", "投资", "融资", "咨询", "市场", "并购", "上市", "商业"]],
  ["arts", ["艺术", "电影", "音乐", "画", "博物馆", "展览", "文学", "小说", "戏剧", "演出"]],
  ["culture", ["文化", "传统", "节日", "美食", "旅游", "历史", "教育", "语言", "时尚"]],
  ["science", ["科学", "研究", "气候", "太空", "航天", "医学", "疫苗", "健康", "环境"]],
];

// ---------------------------------------------------------------------------
// CLI + config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const LOCAL = args.includes("--local");
const LIMIT = parseInt(args[args.indexOf("--limit") + 1], 10) || 8;
const ONLY_SOURCE = args.includes("--source") ? args[args.indexOf("--source") + 1] : null;

function loadScraperConfig() {
  const p = path.join(ROOT, "scraper", "config.json");
  let cfg = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { /* fall through */ }
  }
  return {
    url: process.env.SUPABASE_URL || cfg.SUPABASE_URL || "",
    key: process.env.SUPABASE_SERVICE_KEY || cfg.SUPABASE_SERVICE_KEY || "",
  };
}

// ---------------------------------------------------------------------------
// Dictionary + HSK for segmentation & difficulty
// ---------------------------------------------------------------------------
function loadDict() {
  const words = new Set();
  const tradToSimp = new Map(); // char-level traditional → simplified
  let maxLen = 1;
  const raw = readFileSync(path.join(DATA, "cedict_ts.u8"), "utf8");
  for (const line of raw.split("\n")) {
    if (!line || line[0] === "#") continue;
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    const sp2 = line.indexOf(" ", sp + 1);
    if (sp2 === -1) continue;
    const trad = line.slice(0, sp);
    const simp = line.slice(sp + 1, sp2);
    words.add(simp);
    words.add(trad);
    if (trad.length === simp.length) {
      for (let i = 0; i < trad.length; i++) {
        if (trad[i] !== simp[i] && !tradToSimp.has(trad[i])) tradToSimp.set(trad[i], simp[i]);
      }
    }
    if (simp.length > maxLen) maxLen = Math.min(simp.length, 8);
  }
  return { words, maxLen, tradToSimp };
}

/** Convert to simplified, but only when the text actually looks traditional
 *  (char-by-char conversion has rare ambiguities, so leave simp text alone). */
function toSimplified(text, tradToSimp) {
  let tradChars = 0, cjkChars = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      cjkChars++;
      if (tradToSimp.has(ch)) tradChars++;
    }
  }
  if (!cjkChars || tradChars / cjkChars < 0.05) return text;
  return [...text].map((ch) => tradToSimp.get(ch) || ch).join("");
}

const CJK_RE = /[㐀-鿿豈-﫿]/;

function segment(text, dict) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (!CJK_RE.test(text[i])) { i++; continue; }
    let matched = text[i];
    const max = Math.min(dict.maxLen, text.length - i);
    for (let len = max; len >= 2; len--) {
      if (dict.words.has(text.substr(i, len))) { matched = text.substr(i, len); break; }
    }
    tokens.push(matched);
    i += matched.length;
  }
  return tokens;
}

/** Characters that appear in any HSK ≤4 word — an intermediate learner can
 *  usually guess a compound built entirely from familiar characters. */
function buildKnownCharSet(hsk) {
  const chars = new Set();
  for (const [word, level] of Object.entries(hsk)) {
    if (level <= 4) for (const ch of word) chars.add(ch);
  }
  return chars;
}

function scoreDifficulty(text, dict, hsk, knownChars) {
  const tokens = segment(text, dict);
  if (!tokens.length) return { difficulty: 100, level: "advanced", wordCount: 0, coverage: 0 };
  let known = 0;
  for (const t of tokens) {
    const lvl = hsk[t];
    if ((lvl && lvl <= 4) || [...t].every((ch) => knownChars.has(ch))) known++;
  }
  const coverage = known / tokens.length;
  const difficulty = Math.round((1 - coverage) * 1000) / 10; // 0 = trivial, 100 = brutal
  const level = coverage >= LEVEL_EASY ? "easy" : coverage >= LEVEL_INTERMEDIATE ? "intermediate" : "advanced";
  return { difficulty, level, wordCount: tokens.length, coverage };
}

// Calibrated on real feed data: mainstream Chinese news clusters around
// 55–80% coverage by this metric.
const LEVEL_EASY = 0.78;
const LEVEL_INTERMEDIATE = 0.65;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", hellip: "…", mdash: "—" };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function chineseCharCount(s) {
  const m = s.match(/[㐀-鿿]/g);
  return m ? m.length : 0;
}

/** Extract article paragraphs: harvest <p>-like blocks dense in Chinese text. */
function extractParagraphs(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const blocks = [];
  const re = /<(p|div class="article-paragraph"[^>]*|section class="article-paragraph"[^>]*)(?:\s[^>]*)?>([\s\S]*?)<\/(?:p|div|section)>/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const text = stripTags(m[2]);
    if (chineseCharCount(text) >= 10) blocks.push(text);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// RSS parsing (regex-based; handles RSS 2.0 and RDF)
// ---------------------------------------------------------------------------
function tagContent(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function parseRss(xml) {
  const items = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const chunk = m[0];
    const title = stripTags(tagContent(chunk, "title"));
    let link = tagContent(chunk, "link");
    if (!link) {
      const attr = chunk.match(/<link[^>]*href="([^"]+)"/i);
      if (attr) link = attr[1];
    }
    const pubDate = tagContent(chunk, "pubDate") || tagContent(chunk, "dc:date");
    const contentEncoded = tagContent(chunk, "content:encoded") || tagContent(chunk, "description");
    if (title && link) items.push({ title, link: link.trim(), pubDate, contentEncoded });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Topic classification
// ---------------------------------------------------------------------------
function classifyTopic(title, content, fallback) {
  const sample = title + " " + content.slice(0, 400);
  let best = fallback, bestHits = 0;
  for (const [topic, words] of TOPIC_RULES) {
    let hits = 0;
    for (const w of words) {
      if (sample.includes(w)) hits += title.includes(w) ? 3 : 1;
    }
    if (hits > bestHits) { bestHits = hits; best = topic; }
  }
  return bestHits >= 2 ? best : fallback;
}

// ---------------------------------------------------------------------------
// Output: Supabase or local JSON
// ---------------------------------------------------------------------------
async function upsertSupabase(cfg, rows) {
  const res = await fetch(`${cfg.url}/rest/v1/articles?on_conflict=url`, {
    method: "POST",
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
}

function writeLocal(rows) {
  const p = path.join(DATA, "articles.local.json");
  let existing = [];
  if (existsSync(p)) {
    try { existing = JSON.parse(readFileSync(p, "utf8")); } catch { /* start fresh */ }
  }
  const byUrl = new Map(existing.map((a) => [a.url, a]));
  for (const r of rows) byUrl.set(r.url, r);
  const merged = [...byUrl.values()].sort(
    (a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0)
  );
  writeFileSync(p, JSON.stringify(merged, null, 1), "utf8");
  return merged.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const sbCfg = loadScraperConfig();
  if (!LOCAL && (!sbCfg.url || !sbCfg.key)) {
    console.error(
      "No Supabase credentials. Either fill in scraper/config.json " +
      "(SUPABASE_URL + SUPABASE_SERVICE_KEY) or run with --local to write " +
      "data/articles.local.json instead."
    );
    process.exit(1);
  }

  console.log("Loading dictionary + HSK lists…");
  const dict = loadDict();
  const hsk = JSON.parse(readFileSync(path.join(DATA, "hsk.json"), "utf8"));
  const knownChars = buildKnownCharSet(hsk);

  const sources = ONLY_SOURCE ? SOURCES.filter((s) => s.id === ONLY_SOURCE) : SOURCES;
  const collected = [];

  for (const src of sources) {
    console.log(`\n── ${src.name} (${src.rss})`);
    let items;
    try {
      items = parseRss(await get(src.rss));
    } catch (err) {
      console.error(`  feed failed: ${err.message}`);
      continue;
    }
    console.log(`  ${items.length} items in feed`);

    let taken = 0;
    for (const item of items) {
      if (taken >= LIMIT) break;
      try {
        let paragraphs;
        if (src.useRssContent && item.contentEncoded) {
          paragraphs = extractParagraphs(`<p>${item.contentEncoded}</p>`);
          if (paragraphs.length <= 1) paragraphs = extractParagraphs(item.contentEncoded);
        } else {
          await sleep(600); // be polite
          paragraphs = extractParagraphs(await get(item.link));
        }
        let content = paragraphs.join("\n");
        if (chineseCharCount(content) < 250) {
          console.log(`  skip (too short): ${item.title.slice(0, 40)}`);
          continue;
        }
        content = toSimplified(content, dict.tradToSimp);
        const title = toSimplified(item.title, dict.tradToSimp);
        const { difficulty, level, wordCount, coverage } = scoreDifficulty(content, dict, hsk, knownChars);
        const topic = classifyTopic(title, content, src.defaultTopic);
        let published = null;
        if (item.pubDate) {
          const d = new Date(item.pubDate);
          if (!isNaN(d)) published = d.toISOString();
        }
        collected.push({
          url: item.link,
          title,
          source: src.name,
          topic,
          published_at: published,
          content: content.slice(0, 12000),
          difficulty,
          level,
          word_count: wordCount,
        });
        taken++;
        console.log(
          `  ✓ [${level} ${(coverage * 100).toFixed(0)}% HSK≤4] ${topic.padEnd(8)} ${item.title.slice(0, 48)}`
        );
      } catch (err) {
        console.log(`  skip (${err.message}): ${item.title.slice(0, 40)}`);
      }
    }
  }

  console.log(`\nCollected ${collected.length} articles.`);
  if (!collected.length) return;

  if (LOCAL) {
    const total = writeLocal(collected);
    console.log(`Wrote data/articles.local.json (${total} articles total).`);
  } else {
    await upsertSupabase(sbCfg, collected);
    console.log("Upserted into Supabase ✓");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
