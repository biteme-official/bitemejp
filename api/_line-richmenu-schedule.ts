/**
 * LINE 기본 리치메뉴 예약 전환.
 *
 * 행사용 리치메뉴는 정해진 시각에 바꿔야 하는데, 사무실 PC 작업 스케줄러에 걸면
 * PC 가 꺼져 있는 밤·주말에 안 돈다. 그래서 매시 정각에 도는 `/api/line-journey` 크론이
 * 이 표를 보고 바꾼다.
 *
 * - 각 줄은 「`at` 부터 기본 메뉴는 `richMenuId`」 라는 뜻이다.
 * - 지금 시각이 `at` ~ `at + APPLY_WINDOW_MS` 안이고 현재 기본 메뉴가 다르면 바꾼다.
 *   창을 두는 이유: 기한 없이 강제하면 나중에 사람이 수동으로 바꾼 메뉴를 매시간 되돌린다.
 * - 리치메뉴는 API 로만 관리된다(매니저 화면에 안 보임). 메뉴 자체는 미리 만들어 둬야 한다.
 */

export interface RichMenuScheduleEntry {
  /** 이 시각(ISO, +09:00 로 적을 것)부터 */
  at: string;
  richMenuId: string;
  label: string;
}

export const RICH_MENU_SCHEDULE: RichMenuScheduleEntry[] = [
  {
    // 블프(11/9~11/22) 끝 → 원래 「LINEでログイン」 메뉴로 복구
    at: '2026-11-23T00:00:00+09:00',
    richMenuId: 'richmenu-0aef69d300eef2fd527af4d379678f6f',
    label: 'ログイン導線 v2 (블프 종료 복구)',
  },
];

/** 예약 시각 뒤 이 시간 동안만 강제한다 */
const APPLY_WINDOW_MS = 48 * 3600_000;

export interface RichMenuScheduleResult {
  due: RichMenuScheduleEntry | null;
  current: string | null;
  action: 'none' | 'switched' | 'would_switch' | 'failed';
  detail?: string;
}

export function dueEntry(now: number, schedule = RICH_MENU_SCHEDULE): RichMenuScheduleEntry | null {
  let best: RichMenuScheduleEntry | null = null;
  for (const e of schedule) {
    const t = new Date(e.at).getTime();
    if (t <= now && now < t + APPLY_WINDOW_MS && (!best || t > new Date(best.at).getTime())) best = e;
  }
  return best;
}

/**
 * 크론 본업(저니 발송)을 절대 막지 않는다 — 실패는 결과로만 돌려준다.
 * dryRun 이면 바꾸지 않고 현재 기본 메뉴와 할 일만 알려 준다(토큰·채널 확인용).
 */
export async function applyRichMenuSchedule(token: string, now: number, dryRun: boolean): Promise<RichMenuScheduleResult> {
  const due = dueEntry(now);
  const headers = { Authorization: `Bearer ${token}` };
  let current: string | null = null;
  try {
    const r = await fetch('https://api.line.me/v2/bot/user/all/richmenu', { headers });
    if (r.ok) current = ((await r.json()) as { richMenuId?: string }).richMenuId ?? null;
  } catch {
    /* 조회 실패면 current=null 로 두고 아래에서 그냥 시도 */
  }
  if (!due || current === due.richMenuId) return { due, current, action: 'none' };
  if (dryRun) return { due, current, action: 'would_switch' };
  try {
    const r = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${due.richMenuId}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': '0' },
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      console.error(`[LINE RichMenu] 🔴 전환 실패 ${r.status}: ${body}`);
      return { due, current, action: 'failed', detail: `${r.status} ${body}` };
    }
    console.log(`[LINE RichMenu] 기본 메뉴 전환 ${current} → ${due.richMenuId} (${due.label})`);
    return { due, current, action: 'switched' };
  } catch (e) {
    return { due, current, action: 'failed', detail: String(e) };
  }
}
