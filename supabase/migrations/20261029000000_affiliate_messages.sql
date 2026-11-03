-- ─────────────────────────────────────────────────────────────────────────────
-- 어필리에이트 — 파트너에게 메시지 (Issue #270)
--
-- aff_messages — 어드민에서 조건(클릭 0·판매 0·가입 N일 등)으로 고른 파트너에게 보낸 LINE 안내.
--   받는 사람은 보내기를 누른 순간 partner_ids 로 고정한다 — 미리 보기에서 본 명단 그대로 나간다.
--   야간(21~9시 JST)에 만들면 notify_status='pending' 으로 두고 다음 날 09:05 크론이 보낸다.
--
-- 🔴 머지 전에 Supabase SQL 에디터에서 실행. 이 파일은 여러 번 실행해도 안전하다(if not exists).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.aff_messages (
  id            bigserial primary key,
  memo          text        not null default '',         -- 어드민에서만 보이는 이름 (예: 10월 깨우기)
  body          text        not null,                    -- LINE 본문 (일본어) — 그대로 나간다
  filter        jsonb       not null default '{}'::jsonb, -- 대상 조건 (기록용)
  partner_ids   bigint[]    not null,                    -- 받는 사람 (보내기 누른 시점 고정)
  notify_status text        not null default 'pending' check (notify_status in ('pending', 'sent', 'failed')),
  sent_count    integer     not null default 0,
  failed_count  integer     not null default 0,
  notified_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_aff_messages_created on public.aff_messages (created_at);

alter table public.aff_messages enable row level security;

-- SQL 에디터에서 만든 표엔 service_role 권한이 안 붙는다 (2026-09-21 실측) — 서버만 접근
grant select, insert, update, delete on public.aff_messages to service_role;
grant usage, select on public.aff_messages_id_seq to service_role;
