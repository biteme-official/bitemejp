-- 어필리에이트 Phase 1 — 서버측 터치를 Shopify 고객 id 가 아니라 LINE userId 로 키잉 (#178, 설계 개정 8 §5)
--
-- 왜: 클릭·로그인 시점에 서버가 확실히 아는 식별자는 서명 세션의 LINE userId 다. Shopify 고객 GID 는
--     동기화 실패 계정에 없을 수 있다. 주문 웹훅 쪽도 회원 판정에서 LINE userId 를 얻으므로 같은 키로 잇는다.
-- 실행: Supabase SQL 에디터 (Phase 0 스키마 적용 후). aff_touches 는 Phase 0 에서 쓰지 않아 행이 없다.

alter table public.aff_touches drop constraint if exists aff_touches_pkey;
alter table public.aff_touches alter column shopify_customer_id drop not null;
alter table public.aff_touches add column if not exists line_user_id text;
delete from public.aff_touches where line_user_id is null;   -- Phase 0 잔여 행 방어 (있을 리 없음)
alter table public.aff_touches alter column line_user_id set not null;
alter table public.aff_touches add primary key (line_user_id);
-- 터치를 만든 클릭 (ref 귀속과 같은 근거 추적)
alter table public.aff_touches add column if not exists click_id bigint references public.aff_clicks (id) on delete set null;
create index if not exists idx_aff_touches_customer on public.aff_touches (shopify_customer_id);

grant select, insert, update, delete on public.aff_touches to service_role;
