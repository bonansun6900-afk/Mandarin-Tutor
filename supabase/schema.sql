-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  url text unique not null,
  title text not null,
  source text,
  topic text,
  published_at timestamptz,
  content text not null,
  difficulty real,          -- 0 (easiest) .. 100 (hardest), % of words above HSK 4
  level text,               -- easy | intermediate | advanced
  word_count int,
  created_at timestamptz default now()
);

create table if not exists vocab (
  id uuid primary key default gen_random_uuid(),
  word text unique not null,
  pinyin text,
  definition text,
  context text,             -- title of the article the word was saved from
  created_at timestamptz default now()
);

alter table articles enable row level security;
alter table vocab enable row level security;

-- The reader app uses the public anon key. This is a personal, single-user
-- app: anyone with your anon key can read articles and edit your vocab list.
-- The scraper writes articles with the service_role key, which bypasses RLS.
create policy "anon read articles" on articles for select using (true);
create policy "anon read vocab"    on vocab for select using (true);
create policy "anon add vocab"     on vocab for insert with check (true);
create policy "anon remove vocab"  on vocab for delete using (true);

create index if not exists articles_published_idx on articles (published_at desc);
create index if not exists articles_level_idx on articles (level);
