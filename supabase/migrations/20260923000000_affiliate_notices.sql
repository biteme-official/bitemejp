-- ─────────────────────────────────────────────────────────────────────────────
-- 어필리에이트 Phase 3③ — 야간 보류 알림 · 규약 개정 통지 (Issue #178)
--
-- 1. aff_campaigns.notify_status — 캠페인 LINE 알림을 야간(21~9시 JST)에 저장하면 'pending' 으로 두고
--    다음 날 09:05 크론이 보낸다. 'none' = 알림 끔, 'sent' = 보냄.
-- 2. aff_notices — 규약 개정 통지(약관 第11条 2항: 시행 14일 전 LINE + 파트너 페이지 배너).
--
-- 🔴 머지 전에 Supabase SQL 에디터에서 실행. 이 파일은 여러 번 실행해도 안전하다(if not exists).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.aff_campaigns
  add column if not exists notify_status text not null default 'none'
    check (notify_status in ('none', 'pending', 'sent')),
  add column if not exists notified_at timestamptz;

create table if not exists public.aff_notices (
  id            bigserial primary key,
  kind          text        not null default 'terms' check (kind in ('terms')),
  title         text        not null,                 -- 파트너에게 보이는 제목 (일본어)
  body          text        not null,                 -- 개정 요지 (일본어)
  terms_version text,                                 -- 개정 후 약관 버전 (src/data/affiliate-terms.ts 와 같은 값)
  effective_at  timestamptz not null,                 -- 시행일 — 작성 시점 + 14일 이상 (第11条 2항)
  notify_status text        not null default 'pending' check (notify_status in ('none', 'pending', 'sent')),
  notified_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_aff_notices_effective on public.aff_notices (effective_at);

alter table public.aff_notices enable row level security;

-- SQL 에디터에서 만든 표엔 service_role 권한이 안 붙는다 (2026-09-21 실측) — 서버만 접근
grant select, insert, update, delete on public.aff_notices to service_role;
grant usage, select on public.aff_notices_id_seq to service_role;
