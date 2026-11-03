-- ─────────────────────────────────────────────────────────────────────────────
-- 어필리에이트 — 상황별 메시지 (Issue #272)
--
-- 1. aff_messages 에 상황(kind)·사람별 문구(rendered) 칸.
--    rendered = [{ partner_id, text }] — 보내기를 누른 순간의 문구를 사람마다 고정한다(미리 보기 = 실제 발송).
--    params   = 상황별 값(월간 리포트의 대상 월, 정산 안내의 정산 월 등). 기존 filter 칸을 그대로 쓴다.
-- 2. aff_message_templates — 상황별로 저장한 문구. 없으면 코드의 기본 문구를 쓴다.
--
-- 🔴 머지 전에 Supabase SQL 에디터에서 실행. 이 파일은 여러 번 실행해도 안전하다(if not exists).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.aff_messages
  add column if not exists kind     text  not null default 'custom',
  add column if not exists rendered jsonb not null default '[]'::jsonb;
create index if not exists idx_aff_messages_kind on public.aff_messages (kind, created_at);

create table if not exists public.aff_message_templates (
  kind       text        primary key,
  body       text        not null,
  updated_at timestamptz not null default now()
);

alter table public.aff_message_templates enable row level security;

-- SQL 에디터에서 만든 표엔 service_role 권한이 안 붙는다 (2026-09-21 실측) — 서버만 접근
grant select, insert, update, delete on public.aff_message_templates to service_role;
