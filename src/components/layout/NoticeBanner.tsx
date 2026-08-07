import { useLocation } from "react-router-dom";

/**
 * 사이트 최상단 띠 배너 (전 페이지 공통 공지)
 *
 * 페이지마다 자체 sticky 헤더가 있으므로 App 최상단에 두어 스크롤 시 헤더에 자리를 내준다.
 *
 * 공지를 바꾸려면 아래 NOTICE 만 수정하면 된다.
 * hideAfter 가 지나면 자동으로 사라지므로 내리는 작업이 따로 필요 없다.
 */
const NOTICE = {
  title: "【夏季休業のご案内】",
  lines: [
    "出荷休業期間：8/13～8/16",
    "8/12以降のご注文は8/17より順次発送いたします。",
  ],
  /**
   * 이 시각이 지나면 배너가 사라진다. JST 2026-08-18 00:00 = UTC 2026-08-17 15:00.
   * ⚠️ 반드시 UTC(Z) 로 적을 것 — 로컬 시간으로 적으면 방문자 시간대에 따라 사라지는 시점이 달라진다.
   */
  hideAfter: "2026-08-17T15:00:00Z",
};

export function NoticeBanner() {
  const { pathname } = useLocation();

  // 어드민 대시보드는 내부용이라 제외
  if (pathname.startsWith("/admin")) return null;

  if (Date.now() > new Date(NOTICE.hideAfter).getTime()) return null;

  return (
    <div
      role="status"
      className="w-full bg-accent text-accent-foreground border-b border-accent-foreground/15"
    >
      {/*
        모바일은 세로로 쌓고, sm 이상은 한 줄로 편다.
        ⚠️ inline + margin 으로 붙이면 "8/13～8/16" 과 "8/12以降" 이 붙어 읽혀
           날짜를 오독하게 된다. flex + gap 으로 간격을 확실히 확보한다.
      */}
      <div className="max-w-7xl mx-auto px-4 py-2 text-xs sm:text-sm leading-relaxed flex flex-col items-center text-center sm:flex-row sm:justify-center sm:gap-x-4">
        <span className="font-bold">{NOTICE.title}</span>
        {NOTICE.lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </div>
  );
}
