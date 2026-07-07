# 读报 · Mandarin Reader

Read real Chinese news articles at your level. Click any word or phrase to see
its pinyin and meaning — nothing is shown until you ask for it.

## Quick start

```powershell
npm start        # serve the app → http://localhost:8321
npm run scrape:local   # fetch fresh news into data/articles.local.json (no Supabase needed)
```

> If `node`/`npm` aren't found, open a **new** terminal (Node.js was installed
> and the PATH updates only apply to new shells).

## Connecting Supabase

1. In your Supabase project, open **SQL Editor**, paste the contents of
   [supabase/schema.sql](supabase/schema.sql), and run it once.
2. In **Project Settings → API**, copy your project URL and keys:
   - [config.js](config.js) — paste the URL and the **anon** key (used by the reader app).
   - [scraper/config.json](scraper/config.json) — paste the URL and the **service_role**
     key (used by the scraper to write articles). Keep this key private.
3. Fetch articles into the database:

```powershell
npm run scrape
```

The app automatically reads from Supabase when `config.js` is filled in, and
falls back to `data/articles.local.json` otherwise. Your saved vocab (生词本)
is stored in Supabase too — or in browser localStorage when offline.

## Using it on your iPhone

The app is a static site + Supabase, so host it anywhere. GitHub Pages setup:

1. Connect Supabase first (section above) — the phone reads articles from it.
2. Push this folder to a GitHub repository, then in the repo:
   **Settings → Pages → Source: Deploy from a branch → main / (root)**.
3. In **Settings → Secrets and variables → Actions**, add two repository
   secrets so the included workflow ([.github/workflows/scrape.yml](.github/workflows/scrape.yml))
   scrapes fresh articles twice a day in the cloud:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
4. Open `https://<you>.github.io/<repo>/` in Safari on the iPhone →
   **Share → Add to Home Screen**. It installs with its own icon and runs
   full-screen like a native app.

Notes: `config.js` (committed) contains only the **anon** key, which is safe to
publish — database access is limited by the RLS policies in the schema. The
service key lives only in `scraper/config.json` (gitignored) and GitHub secrets.

## Scraper

`scraper/scrape.mjs` has no npm dependencies. It pulls from these RSS feeds:

| Source | Focus |
|---|---|
| BBC中文 | world, business (converted from traditional to simplified) |
| 德国之声 DW | world, politics |
| 纽约时报中文网 | world, business, culture, tech |
| 36氪 | tech, startups, business |
| 法广 RFI | world, tech |

Options: `--limit N` (articles per source, default 8), `--source bbc`,
`--local` (write to the local JSON instead of Supabase).

To add a source, append an entry to `SOURCES` in
[scraper/scrape.mjs](scraper/scrape.mjs) with its RSS URL. If the site renders
articles with JavaScript, set `useRssContent: true` so the text is taken from
the feed itself.

### How difficulty levels work

Each article is segmented into words using CC-CEDICT (longest-match). A word
counts as "known" for an intermediate learner if it's in HSK 1–4 **or** is a
compound built entirely from HSK 1–4 characters. The share of known words maps
to a level: ≥78% → easy, ≥65% → intermediate, below → advanced. The numeric
`difficulty` (0–100) is the percentage of unknown words.

## Data files

- `data/cedict_ts.u8` — CC-CEDICT dictionary (CC BY-SA 4.0, mdbg.net), ~124k entries
- `data/hsk.json` — HSK 1–6 word→level map (built from clem109/hsk-vocabulary)
- `data/articles.local.json` — offline article store, written by `npm run scrape:local`

## Tips

- Refresh articles whenever you want new reading material — re-running the
  scraper skips duplicates (articles are keyed by URL).
- To schedule it (e.g. every morning), Windows Task Scheduler can run:
  `"C:\Program Files\nodejs\node.exe" "<this folder>\scraper\scrape.mjs"`
