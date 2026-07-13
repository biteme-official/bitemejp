-- 어필리에이트(Affiliate Collab) 모집 신청 접수 테이블
-- 접수순(created_at)으로 담당자가 순차 검토·초대하는 수동 초대 방식
create table if not exists public.affiliate_applications (
  id          bigserial   primary key,
  instagram   text        not null,
  email       text        not null,
  status      text        not null default 'pending', -- pending | invited | rejected
  note        text,
  user_agent  text,
  referrer    text,
  created_at  timestamptz not null default now(),
  invited_at  timestamptz
);

-- 동일 이메일 중복 신청 방지 (대소문자 무시)
create unique index if not exists uq_affiliate_email
  on public.affiliate_applications (lower(email));

-- 접수순 대기열 조회용 (status별 오래된 신청부터)
create index if not exists idx_affiliate_status_created
  on public.affiliate_applications (status, created_at);

-- 서버 측(service_role)에서만 insert/select 허용
alter table public.affiliate_applications enable row level security;
