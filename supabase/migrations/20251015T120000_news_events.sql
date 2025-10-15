-- news_events table: admin-posted news/notifications visible to players
create table if not exists public.news_events (
  id            bigint generated always as identity primary key,
  title         text not null,
  slug          text not null unique,
  summary       text,
  url           text not null,
  is_published  boolean not null default true,
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  created_by    uuid
);

comment on table public.news_events is 'Admin-created news/events shown to players; clickable external URL.';
comment on column public.news_events.slug is 'Unique slug derived from title to avoid duplicates.';

-- news_reads table: per-user read tracking of news_events
create table if not exists public.news_reads (
  event_id   bigint not null references public.news_events(id) on delete cascade,
  user_id    uuid not null,
  read_at    timestamptz not null default now(),
  primary key (event_id, user_id)
);

-- recommended RLS (enable if your project uses it)
-- alter table public.news_events enable row level security;
-- alter table public.news_reads enable row level security;
-- create policy "Public read published news" on public.news_events for select
--   using (is_published = true and published_at <= now());
-- create policy "Users read/write own reads" on public.news_reads for all
--   using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- helpful index for listing
create index if not exists news_events_published_at_idx on public.news_events (is_published, published_at desc);
create index if not exists news_reads_user_idx on public.news_reads (user_id, read_at desc);
