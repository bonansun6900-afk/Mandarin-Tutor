-- Flashcards migration: run once in Supabase SQL Editor.
-- Adds spaced-repetition state to saved vocab + lets the app update it.

alter table vocab add column if not exists box int not null default 0;
alter table vocab add column if not exists due_at timestamptz not null default now();
alter table vocab add column if not exists last_reviewed_at timestamptz;
alter table vocab add column if not exists reviews int not null default 0;

create policy "anon update vocab" on vocab for update using (true) with check (true);
