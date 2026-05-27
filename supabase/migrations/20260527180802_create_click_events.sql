create table if not exists public.events (
  id         bigserial primary key,
  event_type text        not null,
  session_id text        not null,
  user_id    text,
  properties jsonb       not null default '{}',
  page_path  text,
  referrer   text,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_type_created on public.events (event_type, created_at desc);
create index if not exists idx_events_session      on public.events (session_id, created_at);
create index if not exists idx_events_props        on public.events using gin (properties);

-- 서버 측(service_role)에서만 insert/select 허용
alter table public.events enable row level security;

grant all privileges on public.events to service_role;
grant usage, select on sequence public.events_id_seq to service_role;
