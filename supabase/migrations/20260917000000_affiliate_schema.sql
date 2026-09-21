-- ─────────────────────────────────────────────────────────────────────────────
-- 어필리에이트 내재화 — 장부 스키마 (Issue #178, 설계안 개정 7 §6)
--
-- 7 테이블, 접두어 aff_. 요율은 파트너에 없고 캠페인에만 있다.
-- 주문 한 건의 커미션율은 주문 시점에 aff_conversions.rate 에 박아 두고 소급하지 않는다.
-- 귀속 기준액(eligible_amount) = Shopify order.current_subtotal_price
--   (2026-09-17 실측: taxesIncluded=false · 세액 0 · 배송 별도 → 할인 후 상품 소계가 그대로 옴)
-- 이용약관(2026-09-17 확정)이 요구하는 컬럼: terms_version · agreed_at · adult_confirmed_at ·
--   invoice_reg_no · carried_from · dispute_until
-- 계좌 정보는 1·2단계에서 담지 않는다(약관 §8-10).
-- 금액은 전부 엔 단위 integer — JPY 는 소수가 없고, 정산은 「한 엔이라도 어긋나면 열지 않는다」가 기준.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. 파트너 원장 ───────────────────────────────────────────────────────────────
create table if not exists public.aff_partners (
  id                 bigserial primary key,
  code               text        not null unique
                     check (code ~ '^[A-Z0-9]{4,12}$'),         -- 링크 코드 biteme.co.jp/a/{code}, 대문자·숫자만
  line_user_id       text        not null unique,          -- LINE 1계정 = 파트너 1명 (약관 第2条 3항)
  shopify_customer_id text,                                -- 자기구매 판정용, LINE 매핑에서 복사
  name               text        not null,
  instagram          text,
  email              text        check (email is null or email = lower(email)),  -- 자기구매 판정은 소문자 비교
  status             text        not null default 'active'
                     check (status in ('active', 'suspended', 'withdrawn')),
  terms_version      text        not null,                 -- 동의한 약관 버전 (초기 '2026-10')
  agreed_at          timestamptz not null,                 -- 약관 동의 시각 (第11条 4항)
  adult_confirmed_at timestamptz not null,                 -- 満18歳以上 확약 시각 (第2条 2항)
  invoice_reg_no     text,                                 -- 適格請求書発行事業者 등록번호 (第3条 3항, 선택)
  joined_at          timestamptz not null default now(),
  withdrawn_at       timestamptz,
  memo               text
);
create index if not exists idx_aff_partners_status on public.aff_partners (status);

-- 2. 캠페인 — 우대의 유일한 입구 ─────────────────────────────────────────────
create table if not exists public.aff_campaigns (
  id               bigserial primary key,
  name             text        not null,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  commission_rate  numeric(5,4) not null check (commission_rate > 0 and commission_rate < 1),
  discount_percent numeric(5,2)  check (discount_percent is null or (discount_percent > 0 and discount_percent <= 50)),
  scope            text        not null check (scope in ('all', 'partners', 'products')),
  target_ids       text[]      not null default '{}',      -- scope=partners → aff_partners.id / products → Shopify product gid
  active           boolean     not null default true,
  created_by       text,
  created_at       timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists idx_aff_campaigns_window on public.aff_campaigns (active, starts_at, ends_at);

-- 3. 캠페인 전용 코드 — discount_percent 가 있는 캠페인만 ───────────────────
create table if not exists public.aff_campaign_codes (
  id                   bigserial primary key,
  campaign_id          bigint not null references public.aff_campaigns (id) on delete cascade,
  partner_id           bigint not null references public.aff_partners (id)  on delete cascade,
  shopify_code         text   not null unique,
  shopify_discount_gid text   not null,
  status               text   not null default 'active' check (status in ('active', 'disabled')),
  created_at           timestamptz not null default now(),
  unique (campaign_id, partner_id)
);

-- 4. 클릭 — 개인 식별자 없음, IP 는 해시만 ───────────────────────────────────
create table if not exists public.aff_clicks (
  id           bigserial primary key,
  partner_id   bigint not null references public.aff_partners (id) on delete cascade,
  ts           timestamptz not null default now(),
  landing_path text,
  session_id   text,
  referrer     text,
  ua           text,
  ip_hash      text,
  is_bot       boolean not null default false
);
create index if not exists idx_aff_clicks_partner_ts on public.aff_clicks (partner_id, ts desc);

-- 5. 서버측 고객 터치 — 로그인 고객의 마지막 터치, 기기 넘는 귀속 (§5 셋째 갈래) ──
create table if not exists public.aff_touches (
  shopify_customer_id text   primary key,
  partner_id          bigint not null references public.aff_partners (id) on delete cascade,
  touched_at          timestamptz not null default now(),
  source              text   not null default 'link'  -- 'link'(로그인 상태 클릭) | 'login'(로그인 시 localStorage ref 승격)
);
create index if not exists idx_aff_touches_touched on public.aff_touches (touched_at);

-- 6. 전환 — 장부의 심장. order_id 유니크 + upsert 로 웹훅 재전송에도 두 번 안 쌓임 ──
create table if not exists public.aff_conversions (
  id              bigserial primary key,
  order_id        text   not null unique,                  -- Shopify order id (숫자 문자열)
  order_name      text,                                    -- #3687
  partner_id      bigint not null references public.aff_partners (id),
  attribution     text   not null check (attribution in ('code', 'ref', 'customer')),
  shopify_customer_id text,                                -- 주문 고객. 자기구매(self) 판정·customer 귀속 감사용
  click_id        bigint references public.aff_clicks (id) on delete set null,      -- ref 귀속의 근거 클릭
  campaign_id     bigint references public.aff_campaigns (id) on delete set null,   -- 캠페인 요율이 적용됐으면 (전후 성과 비교)
  eligible_amount integer not null check (eligible_amount >= 0), -- current_subtotal_price (엔 정수, 할인 후 상품 소계)
  rate            numeric(5,4)  not null,                  -- 주문 시점 요율 고정
  rate_source     text   not null,                         -- 'base' | 'campaign:{id}'
  commission      integer not null check (commission >= 0),      -- round(eligible_amount * rate), 内税, 엔 정수
  status          text   not null default 'pending'
                  -- nonmember: 비회원 주문(회원 한정, 2026-09-21). 파트너는 알지만 커미션 0 — 걸러진 규모 집계용
                  check (status in ('pending', 'confirmed', 'reversed', 'self', 'void', 'nonmember')),
  ordered_at      timestamptz not null,
  confirm_at      timestamptz not null,                    -- ordered_at + 30일 (확정 대기)
  confirmed_at    timestamptz,
  reversed_at     timestamptz,
  payout_id       bigint,                                  -- aff_payouts.id (정산 묶음에 들어가면 채움)
  raw             jsonb  not null default '{}',            -- 판정에 쓴 필드만 (note_attributes·discount_codes·금액)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_aff_conversions_partner_status on public.aff_conversions (partner_id, status);
create index if not exists idx_aff_conversions_confirm on public.aff_conversions (status, confirm_at);
create index if not exists idx_aff_conversions_payout on public.aff_conversions (payout_id);
create index if not exists idx_aff_conversions_ordered on public.aff_conversions (ordered_at);
create index if not exists idx_aff_conversions_customer on public.aff_conversions (shopify_customer_id);

-- 7. 월 정산 묶음 ─────────────────────────────────────────────────────────────
create table if not exists public.aff_payouts (
  id            bigserial primary key,
  partner_id    bigint not null references public.aff_partners (id),
  period        text   not null,                           -- 'YYYY-MM' (확정 기준 월)
  gross         integer not null default 0,
  withholding   integer not null default 0,                -- 세무사 답이 '대상'일 때만 채움 (第5条 3항)
  net           integer not null default 0,
  status        text   not null default 'draft'
                check (status in ('draft', 'carried', 'payable', 'paid', 'void')),
  carried_from  bigint[] not null default '{}',            -- ¥3,000 미만으로 이월된 이전 payout id (第5条 2항)
  dispute_until date,                                      -- paid_at + 30일 (第5条 5항)
  paid_at       timestamptz,
  memo          text,
  created_at    timestamptz not null default now(),
  unique (partner_id, period)
);

alter table public.aff_conversions
  add constraint fk_aff_conversions_payout
  foreign key (payout_id) references public.aff_payouts (id) on delete set null;

-- updated_at 자동 갱신 (aff_conversions) ────────────────────────────────────
create or replace function public.aff_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_aff_conversions_updated on public.aff_conversions;
create trigger trg_aff_conversions_updated
  before update on public.aff_conversions
  for each row execute function public.aff_set_updated_at();

-- RLS — 전부 서버(service_role)만. 파트너 화면·어드민은 Vercel 함수를 거친다 ──
alter table public.aff_partners       enable row level security;
alter table public.aff_campaigns      enable row level security;
alter table public.aff_campaign_codes enable row level security;
alter table public.aff_clicks         enable row level security;
alter table public.aff_touches        enable row level security;
alter table public.aff_conversions    enable row level security;
alter table public.aff_payouts        enable row level security;
