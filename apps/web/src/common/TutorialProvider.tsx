import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useMe } from "../api/hooks";
import type { MeResponseP3 } from "../api/p3";
import { useToken } from "../auth/TokenContext";
import { TutorialContext } from "./tutorial-context";
import type { TutorialControls } from "./tutorial-context";
import { TutorialOverlay } from "./TutorialOverlay";
import { enabledSteps, shouldStartTutorial } from "./tutorial-logic";
import { TUTORIAL_STEPS } from "./tutorial-steps";
import type { TutorialStep } from "./tutorial-steps";
import {
  clearTutorialPending,
  persistTutorialDone,
  readLocalDone,
  readTutorialPending,
  resetTutorialDone,
} from "./tutorial-storage";

/**
 * 한 세션에서 같은 스텝을 찾아가는 최대 횟수.
 * 1회: 정상 진행. 2회: 잠깐 대상이 없어 건너뛴 스텝 회수. 그 이상은 대상이 영영 없는
 * 스텝으로 보고 포기한다(안 그러면 완료가 영원히 막힌다).
 */
const MAX_ATTEMPTS = 2;

/**
 * 온보딩 튜토리얼 상태 (PRD-v4 §B, AC-B1).
 *
 * 시작 조건 = `shouldStartTutorial` — 신규 신호(로그인 응답 isNew → sessionStorage) 또는
 * 서버가 tutorialDone=false 를 준 경우. 완료/건너뛰기는 `persistTutorialDone` 한 곳에서
 * 저장하므로 재로그인해도 다시 뜨지 않는다.
 *
 * ⚠️ 서버 필드(`user.tutorialDone`)는 미발행 — `src/api/p3.ts` MeResponseP3 의 옵셔널로
 * 읽고 있고, 없으면 localStorage(userId 별)로 폴백한다. TODO(openapi-v3).
 */
export function TutorialProvider({
  children,
  steps = TUTORIAL_STEPS,
  missingGraceMs,
  autoStartPath = "/lobby",
}: {
  children?: ReactNode;
  /** 테스트에서 스텝을 주입하기 위한 훅. 운영은 기본값. */
  steps?: readonly TutorialStep[];
  /** 대상 부재를 스킵으로 확정하기까지의 유예(ms). 테스트에서 0 으로 낮춘다. */
  missingGraceMs?: number;
  /**
   * 자동 시작을 허용하는 경로. 기본 스텝이 전부 로비 요소를 대상으로 하므로 로비에서만
   * 시작한다 — 로그인 화면(스타터팩 모달 단계)에서 떠서 대상을 못 찾고 그대로
   * ‘완료’ 처리돼 버리는 것을 막는다. 수동 다시보기는 이 게이트를 거치지 않는다.
   */
  autoStartPath?: string;
}) {
  const { token } = useToken();
  const location = useLocation();
  const me = useMe();
  const meData = me.data as MeResponseP3 | undefined;
  // `user` 까지 옵셔널로 읽는다 — /api/me 가 (목킹·부분 실패로) user 없이 오면
  // 여기서 throw 해 화면 전체가 죽는다(실제로 route-mock 스펙에서 흰 화면을 만들었다).
  const userId = meData?.user?.id ?? null;
  const serverDone = meData?.user?.tutorialDone;

  const runSteps = useMemo(() => enabledSteps(steps), [steps]);
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  /** 자동 시작은 계정당 (그 화면 방문당) 1회 — me 가 리페치돼도 다시 켜지지 않는다. */
  const autoStartedFor = useRef<string | null>(null);
  /**
   * **실제로 화면에 보여준 스텝 id 집합 = 진행 상태의 SoT.**
   *
   * 인덱스 산수(재개 지점·연쇄 시작점)로 "못 본 스텝"을 추적하려던 이전 구조는 입구를
   * 막을 때마다 다른 경로로 뚫렸다(라우트 이탈·연쇄 중간 복귀·계정 전환). 지금은
   * 오버레이가 스텝을 **그린 순간**에만 여기 담기고, 완료 저장은 이 집합이 전부 찰 때만 한다.
   * → "본 적 없는 스텝이 완료 처리되는" 사고가 구조적으로 불가능해진다.
   */
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 스텝별 시도 횟수. 대상이 영영 없는 스텝(미머지 기능 등)이 완료를 영원히 막지 않도록
   * 한 세션에서 스텝당 최대 `MAX_ATTEMPTS` 번만 찾아간다(무한 왕복 차단).
   */
  const attempts = useRef<Map<string, number>>(new Map());
  /**
   * 튜토리얼을 **시작한 시점의 계정**. 저장 직전 현재 userId 와 비교해 다르면 저장하지 않는다
   * (계정 전환 직후 stale 캐시로 이전 계정 id 가 잡히는 창을 막는 최후 방어선).
   */
  const ownerUserId = useRef<string | null>(null);
  /** 직전에 튜토리얼 세션을 붙였던 계정 — 계정 경계 감지용. */
  const lastUserId = useRef<string | null>(null);

  /**
   * 튜토리얼 **세션 상태 전체**를 초기화한다(계정 경계 전용).
   *
   * ⚠️ 여기서 하나라도 빠뜨리면 이전 계정의 진행 상태가 다음 계정으로 샌다.
   * 로그아웃/세션만료(401)는 **리로드 없는 SPA 전환**이라 모듈 변수·ref 가 그대로 살아남는다.
   * 상태를 추가하면 반드시 여기에도 추가할 것.
   */
  const resetSession = useCallback(() => {
    setActive(false);
    setIndex(0);
    autoStartedFor.current = null;
    ownerUserId.current = null;
    attempts.current = new Map();
    setSeen(new Set());
  }, []);

  /**
   * 다음으로 데려갈 스텝 = **아직 못 봤고 시도 여력이 남은** 첫 스텝. 없으면 -1.
   * 순서상 뒤가 아니라 **앞쪽일 수도 있다** — 잠깐 대상이 없어 건너뛴 스텝을 회수하는 경로다.
   */
  const nextCandidate = useCallback(
    (excludeId?: string) =>
      runSteps.findIndex(
        (s) =>
          s.id !== excludeId &&
          !seen.has(s.id) &&
          (attempts.current.get(s.id) ?? 0) < MAX_ATTEMPTS,
      ),
    [runSteps, seen],
  );

  /** 해당 스텝으로 이동(시도 횟수 증가). */
  const goTo = useCallback(
    (i: number) => {
      const id = runSteps[i]!.id;
      attempts.current.set(id, (attempts.current.get(id) ?? 0) + 1);
      setIndex(i);
    },
    [runSteps],
  );

  /** 오버레이가 스텝을 실제로 그렸다고 알려올 때만 '봤다'로 친다. */
  const markSeen = useCallback((stepId: string) => {
    setSeen((prev) => (prev.has(stepId) ? prev : new Set(prev).add(stepId)));
  }, []);

  // 계정 경계(로그아웃·세션만료·계정 전환)에서 세션 상태를 버린다.
  useEffect(() => {
    if (!token) {
      resetSession();
      // isNew 신호(메모리)도 함께 버린다 — 다음 계정이 남의 신호를 물려받으면 안 된다.
      clearTutorialPending();
      lastUserId.current = null;
      return;
    }
    if (userId === null || userId === lastUserId.current) return;
    // 같은 탭에서 계정이 바뀌었다(로그아웃을 거치지 않은 전환 포함).
    if (lastUserId.current !== null) resetSession();
    lastUserId.current = userId;
  }, [token, userId, resetSession]);

  useEffect(() => {
    if (!token) return;
    if (!userId || autoStartedFor.current === userId) return;
    // 이미 진행 중이면 손대지 않는다 — 잠깐 다른 화면에 다녀오는 사이(유예 만료 전)
    // 재시작이 걸리면 진행하던 스텝이 0 으로 되감긴다.
    if (active) return;
    // 대상이 있는 화면(로비)에 실제로 도착한 다음에만 시작한다.
    if (location.pathname !== autoStartPath) return;
    const start = shouldStartTutorial({
      serverDone,
      localDone: readLocalDone(userId),
      pending: readTutorialPending(),
    });
    if (!start || runSteps.length === 0) return;
    // 재개 지점은 저장해 둔 인덱스가 아니라 **아직 안 본 첫 스텝**이다.
    // 새 방문이므로 시도 횟수는 리셋한다(지난 방문에 대상이 없던 스텝도 다시 기회를 준다).
    attempts.current = new Map();
    const resumeAt = runSteps.findIndex((s) => !seen.has(s.id));
    if (resumeAt < 0) return; // 전부 봤는데 명시적 종료를 안 한 상태 — 다시 띄우지 않는다.
    autoStartedFor.current = userId;
    ownerUserId.current = userId;
    goTo(resumeAt);
    setActive(true);
  }, [
    token,
    userId,
    serverDone,
    runSteps,
    location.pathname,
    autoStartPath,
    active,
    seen,
    goTo,
  ]);

  // 대상이 있는 화면을 떠나면 자동시작 잠금을 푼다 — 중단된 튜토리얼이 돌아왔을 때
  // 재개될 수 있게 한다(같은 화면에 머무는 동안 재시작 루프는 생기지 않는다).
  useEffect(() => {
    if (location.pathname !== autoStartPath) autoStartedFor.current = null;
  }, [location.pathname, autoStartPath]);

  /**
   * 완료 저장 — **시작한 계정과 지금 계정이 같을 때만** 쓴다.
   * 계정 전환 직후에는 쿼리 캐시가 아직 이전 계정을 돌려주는 창이 있어서, 그때 저장하면
   * 엉뚱한 계정에 '완료'가 박힌다(그 계정은 한 스텝도 안 봤을 수 있다).
   */
  const persistIfOwner = useCallback(() => {
    if (ownerUserId.current !== null && ownerUserId.current === userId) {
      persistTutorialDone(userId);
    }
    resetSession();
  }, [userId, resetSession]);

  /**
   * **유저가 스스로 그만둠**(건너뛰기·ESC) — 본인이 온보딩 전체를 거절한 것이므로
   * 안 본 스텝이 남아 있어도 저장한다(AC-B1: 재노출 0).
   */
  const optOut = useCallback(() => {
    persistIfOwner();
  }, [persistIfOwner]);

  const currentId = runSteps[index]?.id;

  /** enabled 스텝을 하나도 빠짐없이 보여줬는가 = 완료 저장의 유일한 조건. */
  const allSeen = runSteps.every((s) => seen.has(s.id));

  /**
   * 다음 스텝으로 이동하거나 끝낸다. **'다음' 클릭과 대상 부재 스킵이 같은 규칙을 쓴다** —
   * 진행 경로가 갈리면 한쪽에만 구멍이 나기 때문이다(그 구멍으로 3라운드 연속 뚫렸다).
   *
   * 규칙은 단 하나: **전부 보여줬을 때만 완료 저장**. 아직 못 본 스텝이 남았는데 지금은
   * 보여줄 수 없으면(대상 부재) 저장하지 않고 내려간다 — 다음 진입 때 거기서 재개된다.
   * 유저가 직접 끝내고 싶으면 언제든 '건너뛰기'(optOut)가 있고 그건 저장한다.
   */
  const advanceOrEnd = useCallback(() => {
    const next = nextCandidate(currentId);
    if (next >= 0) {
      goTo(next);
      return;
    }
    if (allSeen) {
      persistIfOwner();
      return;
    }
    setActive(false);
  }, [nextCandidate, currentId, goTo, allSeen, persistIfOwner]);

  const restart = useCallback(() => {
    resetTutorialDone(userId);
    setSeen(new Set());
    attempts.current = new Map();
    autoStartedFor.current = userId;
    ownerUserId.current = userId;
    setIndex(0);
    setActive(true);
  }, [userId]);

  const value = useMemo<TutorialControls>(() => ({ active, restart }), [active, restart]);
  const step = active ? runSteps[index] : undefined;

  return (
    <TutorialContext.Provider value={value}>
      {children}
      {step && (
        <TutorialOverlay
          key={step.id}
          step={step}
          index={index}
          total={runSteps.length}
          onNext={advanceOrEnd}
          onSkip={optOut}
          onMissingTarget={advanceOrEnd}
          onShown={markSeen}
          isLast={nextCandidate(runSteps[index]?.id) < 0}
          missingGraceMs={missingGraceMs}
        />
      )}
    </TutorialContext.Provider>
  );
}
