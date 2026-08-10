import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useMe } from "../api/hooks";
import { useToken } from "../auth/TokenContext";
import { GuideContext } from "./guide-context";
import type { GuideControls } from "./guide-context";
import { TutorialOverlay } from "./TutorialOverlay";
import { guideForPath } from "./guide-steps";
import type { ScreenGuide } from "./guide-steps";
import { guidePending, markGuideSeen, readGuideSeen, resetGuides } from "./guide-storage";
import { useTutorial } from "./tutorial-context";

/**
 * #493 W2 — 화면별 첫 진입 가이드. **온보딩(TutorialProvider)과 분리된 프로바이더**다.
 *
 * 왜 분리인가: 온보딩 배열에 스텝을 더하면 "n / total" 과 완료 저장(= 서버 덱 지급 트리거)이
 * 깨진다(트레이드 코치마크 롤백 전례, hero Q7=A). 여기는 자기 데이터(`guide-steps`)와 자기
 * 진행 상태(`guide-storage`, 화면 단위)만 쓰고, 온보딩의 완료 저장 경로를 **절대 부르지 않는다**.
 *
 * 발화 조건(전부 곱):
 *  - 그 라우트에 가이드가 정의돼 있다(guideForPath)
 *  - userId 를 안다 + **pending 래치**가 서 있다(온보딩을 끝낸 계정 — `persistIfOwner` 가 심는다).
 *    래치 없이는 절대 발화하지 않는다: 기존 유저·e2e 목 유저(tutorialDone:true 목이 38개 스펙)에게
 *    가이드가 쏟아지면 안 된다. 기존 유저는 /me '화면 안내 다시 보기'로 옵트인한다.
 *  - 그 화면을 아직 안 봤다(seen)
 *  - 온보딩 코치마크가 돌고 있지 않다(useTutorial().active)
 *
 * 종료·저장 규칙(#386 규율의 화면판):
 *  - 유저 행동(다음 완주·건너뛰기·다른 화면으로 이탈)으로 끝나면 **그 화면 seen** — 단,
 *    실제로 그린 스텝이 1개 이상일 때만.
 *  - 대상 부재로 스텝이 전부 스킵돼 끝나면 저장하지 않는다(화면 사정) — 다음 진입에 다시 시도.
 *    (/league 처럼 상태별로 대상이 갈리는 화면이 이 규칙에 기댄다.)
 */
export function GuideProvider({
  children,
  guides,
  missingGraceMs,
}: {
  /** createElement 3번째 인자 경로(테스트)도 허용 — TutorialProvider 와 같은 시그니처. */
  children?: ReactNode;
  /** 테스트 주입용(TutorialProvider 의 `steps` 와 같은 관용구) — 생략하면 SCREEN_GUIDES. */
  guides?: ScreenGuide[];
  missingGraceMs?: number;
}) {
  const { token, userId: tokenUserId } = useTokenUserId();
  const location = useLocation();
  const tutorial = useTutorial();

  const [run, setRun] = useState<{ guide: ScreenGuide; index: number } | null>(null);
  /** 이 run 에서 실제로 그린 스텝 id — 종료 시 "봤다"의 근거. */
  const shownRef = useRef<Set<string>>(new Set());
  /**
   * 이번 **방문**에서 이미 시도한 화면 — 대상 부재로 끝난 가이드는 seen 을 안 찍으므로,
   * 이 가드가 없으면 같은 방문 안에서 [종료 → 조건 충족 → 재시작] 무한 루프가 된다(실측 OOM).
   * 화면을 떠나면 풀린다 = "다음 진입에 다시 시도"의 구현.
   */
  const attemptedRef = useRef<Set<string>>(new Set());
  /** replay 후 재평가 트리거(스토리지는 React 밖이라 신호가 필요하다). */
  const [storageEpoch, setStorageEpoch] = useState(0);

  const endRun = useCallback(
    (screen: string) => {
      if (shownRef.current.size > 0) markGuideSeen(tokenUserId, screen);
      shownRef.current = new Set();
      setRun(null);
    },
    [tokenUserId],
  );

  // 라우트 감시 — 시작과 이탈을 한 곳에서 정한다.
  useEffect(() => {
    // 돌던 가이드의 화면을 떠났다 → 유저 이탈로 종료(그린 게 있으면 seen).
    if (run && run.guide.screen !== location.pathname) {
      endRun(run.guide.screen);
      return;
    }
    // 떠난 화면의 시도 기록은 푼다 — 다음 진입에서 다시 시도할 수 있게.
    for (const s of [...attemptedRef.current]) {
      if (s !== location.pathname) attemptedRef.current.delete(s);
    }
    if (run || !token || !tokenUserId) return;
    if (tutorial.active) return;
    const guide = guides
      ? (guides.find((g) => g.screen === location.pathname) ?? null)
      : guideForPath(location.pathname);
    if (!guide) return;
    if (attemptedRef.current.has(guide.screen)) return;
    if (!guidePending(tokenUserId)) return;
    if (readGuideSeen(tokenUserId).has(guide.screen)) return;
    shownRef.current = new Set();
    attemptedRef.current.add(guide.screen);
    setRun({ guide, index: 0 });
  }, [location.pathname, token, tokenUserId, tutorial.active, run, endRun, storageEpoch, guides]);

  // 계정 전환 → 진행 중이던 run 은 그 자리에서 버린다(seen 도 안 찍는다 — 주인이 다르다).
  // ⚠️ 마운트에는 발화하면 안 된다 — 라우트 감시 effect 가 방금 세운 첫 run 을 지운다(전환 감지만).
  const prevUserRef = useRef(tokenUserId);
  useEffect(() => {
    if (prevUserRef.current === tokenUserId) return;
    const prev = prevUserRef.current;
    prevUserRef.current = tokenUserId;
    // null → uid 는 전환이 아니라 **최초 로드**다(/api/me 도착). 여기서 지우면 같은 렌더 배치에서
    // 라우트 감시가 방금 세운 첫 run 을 죽인다 — 실브라우저에서만 재현(jsdom 목은 동기 도착).
    if (prev === null) return;
    shownRef.current = new Set();
    setRun(null);
  }, [tokenUserId]);

  const advance = useCallback(() => {
    setRun((cur) => {
      if (!cur) return null;
      const next = cur.index + 1;
      if (next >= cur.guide.steps.length) {
        // setState 안에서 부수효과를 내지 않는다 — 종료는 아래 렌더 밖 경로로.
        return { ...cur, index: -1 };
      }
      return { ...cur, index: next };
    });
  }, []);

  // index -1 = 종료 신호(마지막 스텝에서 다음/부재 스킵) — effect 에서 정리한다.
  useEffect(() => {
    if (run && run.index === -1) endRun(run.guide.screen);
  }, [run, endRun]);

  const value = useMemo<GuideControls>(
    () => ({
      active: run !== null && run.index >= 0,
      replay: () => {
        resetGuides(tokenUserId);
        shownRef.current = new Set();
        attemptedRef.current = new Set();
        setRun(null);
        setStorageEpoch((n) => n + 1);
      },
    }),
    [run, tokenUserId],
  );

  const step = run && run.index >= 0 ? run.guide.steps[run.index] : undefined;

  return (
    <GuideContext.Provider value={value}>
      {children}
      {run && step && (
        <TutorialOverlay
          step={step}
          index={run.index}
          total={run.guide.steps.length}
          isLast={run.index === run.guide.steps.length - 1}
          lastLabel="확인"
          onNext={advance}
          onSkip={() => endRun(run.guide.screen)}
          onMissingTarget={advance}
          onShown={(id) => {
            shownRef.current.add(id);
          }}
          missingGraceMs={missingGraceMs}
        />
      )}
    </GuideContext.Provider>
  );
}

/** userId 소스는 온보딩과 같다(useMe) — 두 프로바이더가 다른 주인을 보면 격리가 어긋난다. */
function useTokenUserId(): { token: string | null; userId: string | null } {
  const { token } = useToken();
  const me = useMe();
  const userId = (me.data as { user?: { id?: string } } | undefined)?.user?.id ?? null;
  return { token, userId };
}
