import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useToken } from "../auth/TokenContext";
import { StageShell } from "../match/stage/StageShell";
import type { MatchDetail } from "../api/hooks";
import styles from "./StagePreview.module.css";

/**
 * `/design/stage` — S1 관전 화면(#169) **디자인 확인 전용 프리뷰**. dev 빌드에서만 라우팅된다
 * (App.tsx `import.meta.env.DEV` 가드) — 프로덕션 번들에는 이 화면으로 가는 길이 없다.
 *
 * 왜 필요한가: 지금 제품 라우팅은 하프타임/종료에서만 관전 셸로 들어간다. 그래서
 * **"기본 = 경기장면만"(패널 0개) 상태를 실제 화면으로 볼 수 없다** — W3(#170) 라이브 상태가
 * 생겨야 도달한다. 리뷰어가 그 화면을 눈으로 봐야 하므로 여기서 상태를 직접 주입한다.
 *
 * 데이터는 로컬 목 서버(`apps/web/scripts/design-mock-server.mjs`)가 준다. 매치 자체는 여기서
 * 만들어 StageShell 에 그대로 넘긴다(제품 경로와 같은 컴포넌트 — 프리뷰용 UI 복제 없음).
 */

type PreviewState = "FIRST_HALF" | "H1_BREAK" | "FINISHED";

const STATES: { key: PreviewState; label: string; hint: string }[] = [
  {
    key: "FIRST_HALF",
    label: "관전(무대만)",
    hint: "기본 상태 — 패널 0개, 3토글로 직접 열어보세요",
  },
  {
    key: "H1_BREAK",
    label: "감독시간",
    hint: "하프타임 — 교체·프롬프트 패널이 상태 소유로 자동 표시",
  },
  { key: "FINISHED", label: "종료", hint: "결과 패널이 무대 아래 탭으로 열림" },
];

/** 목 서버가 이 id 로 상태를 판단한다(같은 화면을 제품 경로 `/match/<id>` 로도 볼 수 있게). */
const MATCH_ID: Record<PreviewState, string> = {
  FIRST_HALF: "live",
  H1_BREAK: "h1break",
  FINISHED: "finished",
};

function parseState(raw: string | null): PreviewState {
  const up = (raw ?? "").toUpperCase();
  return up === "FINISHED" || up === "H1_BREAK" || up === "FIRST_HALF"
    ? (up as PreviewState)
    : "FIRST_HALF";
}

export function StagePreview() {
  const [params, setParams] = useSearchParams();
  const { token, login } = useToken();
  const state = parseState(params.get("state"));
  const framed = params.get("frame") === "phone";
  // 폰 프레임 안쪽에서는 전환기를 숨긴다 — 바깥 헤더에 이미 있어서 두 벌로 보인다.
  const embedded = typeof window !== "undefined" && window.self !== window.top;

  // 목 서버는 인증을 보지 않지만, 앱의 쿼리들이 토큰 유무로 enabled 를 판단한다 → 프리뷰용 토큰.
  useEffect(() => {
    if (!token) login("design-preview", "guest");
  }, [token, login]);

  const match = {
    id: MATCH_ID[state],
    state,
    // 스코어는 목 서버가 실제 로그에서 파생한 값과 맞춘다(전반 5:5 · 최종 10:10).
    scoreH1Home: 5,
    scoreH1Away: 5,
    scoreHome: state === "FINISHED" ? 10 : null,
    scoreAway: state === "FINISHED" ? 10 : null,
    result: state === "FINISHED" ? "DRAW" : null,
    createdAt: "2026-07-22T09:00:00Z",
    opponent: { name: "뮌헨봇" },
  } as unknown as MatchDetail;

  const go = (next: PreviewState) => {
    const p = new URLSearchParams(params);
    p.set("state", next);
    setParams(p, { replace: true });
  };

  const current = STATES.find((s) => s.key === state)!;

  // 폰 프레임: 같은 프리뷰를 390×844 iframe 안에 넣어 데스크탑 브라우저에서 모바일 레이아웃을 본다
  // (devtools 없이 나란히 비교하려는 용도 — 안쪽 URL 에서는 frame 을 뺀다).
  if (framed) {
    const inner = new URLSearchParams(params);
    inner.delete("frame");
    return (
      <div className={styles.frameWrap}>
        <div className={styles.frameHead}>
          <span className={styles.frameTitle}>📱 390 × 844 (모바일)</span>
          <div className={styles.switcher}>
            {STATES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`${styles.chip} ${s.key === state ? styles.chipOn : ""}`}
                onClick={() => go(s.key)}
              >
                {s.label}
              </button>
            ))}
            <a className={styles.chip} href={`/design/stage?state=${state}`}>
              🖥 전체화면(데스크탑)
            </a>
          </div>
        </div>
        <iframe
          className={styles.phone}
          title="모바일 프리뷰"
          src={`/design/stage?${inner.toString()}`}
        />
        <p className={styles.frameHint}>{current.hint}</p>
      </div>
    );
  }

  return (
    <>
      <StageShell match={match} homeName="내 팀" awayName="뮌헨봇" />

      {/* 리뷰용 상태 전환기 — 무대·시트를 가리지 않게 토글바 위 모서리에 작게 띄운다. */}
      {!embedded && (
        <div className={styles.switcher} data-testid="design-state-switcher">
          {STATES.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`${styles.chip} ${s.key === state ? styles.chipOn : ""}`}
              onClick={() => go(s.key)}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
          <a
            className={styles.chip}
            href={`/design/stage?state=${state}&frame=phone`}
          >
            📱 폰
          </a>
        </div>
      )}
    </>
  );
}
