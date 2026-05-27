create table if not exists public.click_events (
  id         bigserial primary key,
  event_type text        not null,
  event_label text,
  event_value text,
  page_path  text,
  session_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_click_events_type_created
  on public.click_events (event_type, created_at desc);

create index if not exists idx_click_events_created
  on public.click_events (created_at desc);

-- 서버 측(service_role)에서만 insert/select 허용
alter table public.click_events enable row level security;
