import { useEffect, useRef, useState } from "react";
import { AD_TOTAL_SEC, createAdShow } from "./ad-show";
import { SHOW_GAP_SEC, STAGE_H, STAGE_W } from "./ad-player";
import styles from "./SplashScreen.module.css";

/**
 * #479 — 첫 진입 스플래시. adboost #475 동결본 연출을 재생하고 `[게임 시작]` 으로 로그인 폼에 넘긴다.
 *
 * ⚠️ **원본의 `page()` 를 쓰지 않는다**(`ad-player.ts` 머리말) — 그 함수는 `file://` 단독 재생용
 * 페이지 크롬이라 `document.body` 를 덮어쓰고 전역을 심는다. rAF 루프·fit·라이프사이클이 여기 있다.
 *
 * ⚠️ **무대는 contain(레터박스)이다, cover 가 아니다.** 폰(390×844)에서 화면을 꽉 채우려면
 * 무대 폭이 844×0.5625 = 474.75px 이어야 하고 좌우로 **각 96 무대단위**가 잘린다 — 그런데 이
 * 광고의 인과 배지(`pill`)는 `w:1000` 이라 여백이 좌우 **40단위**뿐이다. 즉 cover 로 깔면
 * hero 가 리뷰한 배지의 양끝이 잘린다. 그래서 9:16 을 지키고, 남는 검정 띠는 `[게임 시작]` 이 쓴다.
 */
export function SplashScreen({ onStart }: { onStart: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const show = createAdShow();
    host.appendChild(show.stage);

    /** 9:16 을 세로/가로 중 작은 쪽에 맞춘다(잘라내지 않는다 — 머리말 참조). */
    const fit = () => {
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      show.resize(Math.max(120, Math.floor(Math.min(vw, (vh * STAGE_W) / STAGE_H))));
    };
    fit();
    window.addEventListener("resize", fit);

    // 모션 최소화: 연출을 **지우지 않는다**(그러면 스플래시가 검은 화면이 된다). 흐르는 재생만
    // 멈추고 CTA 가 완성된 시점을 정지 포스터로 보여준다 — 브랜딩과 문구가 그대로 읽힌다.
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const POSTER_T = AD_TOTAL_SEC - 1.0;

    let raf = 0;
    let alive = true;
    let t0 = 0;

    const loop = (now: number) => {
      if (!alive) return;
      if (!t0) t0 = now;
      const t = ((now - t0) / 1000) % (show.total + SHOW_GAP_SEC);
      show.draw(Math.min(t, show.total - 1e-3));
      raf = window.requestAnimationFrame(loop);
    };

    setProgress(0);
    show.load(
      () => {
        if (!alive) return;
        setProgress(null);
        fit();
        if (reduced) show.draw(POSTER_T);
        else raf = window.requestAnimationFrame(loop);
      },
      (done, total) => {
        if (alive) setProgress(total ? Math.round((done / total) * 100) : 100);
      },
    );

    return () => {
      alive = false;
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
      show.stage.remove();
    };
  }, []);

  return (
    <section className={styles.screen} aria-label="HMB 온라인 소개" data-testid="splash">
      <div className={styles.host} ref={hostRef} data-testid="splash-stage" />
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.cta}>
        <p className={styles.progress} data-testid="splash-progress">
          {progress === null ? "" : `연출을 불러오는 중 ${progress}%`}
        </p>
        {/*
         * ⚠️ `autoFocus` 를 **쓰지 않는다**. 처음엔 "화면의 유일한 조작점이니 키보드 진입점을 준다"는
         * 이유로 넣었는데, 실화면 캡처에서 크롬이 autofocus 에도 `:focus-visible` 을 적용해 **모든
         * 유저에게 포커스 링이 상주**했다(폰·데스크탑 전 컷). 이 화면에 포커스 가능한 요소는 이
         * 버튼 하나라 키보드 유저는 Tab 한 번으로 닿는다 — 100% 의 유저가 지불하는 시각 비용보다
         * 그쪽이 싸다. (DOM 단언으로는 안 보이는 부류라 캡처로만 잡혔다 — 루트 §2-2.)
         */}
        <button type="button" className={styles.start} data-testid="splash-start" onClick={onStart}>
          게임 시작
        </button>
      </div>
    </section>
  );
}
