import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { useMe } from "../api/hooks";
import type { MeResponseP3 } from "../api/p3";
import { useToken } from "../auth/TokenContext";
import { TutorialContext } from "./tutorial-context";
import type { TutorialControls } from "./tutorial-context";
import { TutorialOverlay } from "./TutorialOverlay";
import { enabledSteps, shouldStartTutorial, stepOnRoute } from "./tutorial-logic";
import { DECK_SETUP_STEPS, TUTORIAL_STEPS } from "./tutorial-steps";
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

/** 스텝 대상이 실재하는 화면들(TUTORIAL_STEPS 의 route 집합과 일치시켜 둔다). */
// #286: 온보딩 시작 지점이 로비 → **홈**으로 옮겨왔다(코치마크 대상도 홈 타일이다).
// ⚠️ 이 배열과 `tutorial-steps.ts` 의 `route` 는 **짝**이다 — 스텝은 /home 을 가리키는데 여기가
// /lobby 로 남아 있으면 신규 유저에게 코치마크가 **아예 안 뜬다**(p248b 가 그걸 잡았다).
const DEFAULT_AUTO_START_PATHS = ["/home", "/deck"] as const;

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
  autoStartPaths = DEFAULT_AUTO_START_PATHS,
}: {
  children?: ReactNode;
  /** 테스트에서 스텝을 주입하기 위한 훅. 운영은 기본값. */
  steps?: readonly TutorialStep[];
  /** 대상 부재를 스킵으로 확정하기까지의 유예(ms). 테스트에서 0 으로 낮춘다. */
  missingGraceMs?: number;
  /**
   * 자동 시작(=재개)을 허용하는 경로들. 스텝 대상이 존재하는 화면만 넣는다 —
   * 로그인 화면(스타터팩 모달 단계)에서 떠서 대상을 못 찾고 그대로 ‘완료’ 처리돼 버리는
   * 것을 막는 게이트다. 수동 다시보기는 이 게이트를 거치지 않는다.
   *
   * `/deck` 이 들어 있는 이유: 덱 스텝(전술보드·저장)은 그 화면에서만 보여줄 수 있어서,
   * 유저가 로비에서 '다음'으로 지나갔다면 **처음 덱 화면에 들어갔을 때** 이어서 떠야 한다.
   * 안 그러면 못 본 스텝이 영구히 남아 완료 저장이 절대 일어나지 않는다.
   */
  autoStartPaths?: readonly string[];
}) {
  const { token } = useToken();
  const location = useLocation();
  const queryClient = useQueryClient();
  const me = useMe();
  const meData = me.data as MeResponseP3 | undefined;
  // `user` 까지 옵셔널로 읽는다 — /api/me 가 (목킹·부분 실패로) user 없이 오면
  // 여기서 throw 해 화면 전체가 죽는다(실제로 route-mock 스펙에서 흰 화면을 만들었다).
  const userId = meData?.user?.id ?? null;
  const serverDone = meData?.user?.tutorialDone;

  /**
   * 지금 돌고 있는 시퀀스가 온보딩이 아니라 **덱 셋업 워크스루**인가 (#286 W3.5).
   *
   * 둘은 길이도 목적도 다르다 — 한 배열에 합쳤더니 온보딩 진행 표시("1 / 7")부터 깨졌다.
   * 그래서 시퀀스를 통째로 갈아끼운다. 온보딩 쪽 코드는 이 값을 몰라도 되게 `runSteps` 한
   * 곳에서만 갈린다.
   */
  const [setupMode, setSetupMode] = useState(false);
  const runSteps = useMemo(
    () => enabledSteps(setupMode ? DECK_SETUP_STEPS : steps),
    [steps, setupMode],
  );
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
    // 셋업 워크스루도 여기서 걷힌다 — 남겨 두면 다음 자동시작이 온보딩 대신 셋업 3스텝을 연다.
    setSetupMode(false);
    autoStartedFor.current = null;
    ownerUserId.current = null;
    attempts.current = new Map();
    setSeen(new Set());
  }, []);

  /**
   * 다음으로 데려갈 스텝 = **아직 못 봤고, 지금 화면에서 보여줄 수 있고, 시도 여력이 남은**
   * 첫 스텝. 없으면 -1.
   *
   * 순서상 뒤가 아니라 **앞쪽일 수도 있다** — 잠깐 대상이 없어 건너뛴 스텝을 회수하는 경로다.
   *
   * 라우트 힌트(`step.route`)로 후보를 좁히는 것은 **줄이기만 하는** 필터다. 다른 화면의
   * 스텝을 여기서 억지로 골라봐야 어차피 '대상 부재 → 스킵'인데, 그 과정에서 시도 횟수만
   * 태우고(그 스텝은 정작 제 화면에 도착했을 때 기회를 잃는다) 유저에게는 아무것도 안 보이는
   * 공백만 남는다. 완료 판정은 계속 `seen` 이 쥐고 있으므로 이 필터로 저장이 앞당겨지는 일은 없다.
   */
  const nextCandidate = useCallback(
    (excludeId?: string) =>
      runSteps.findIndex(
        (s) =>
          s.id !== excludeId &&
          !seen.has(s.id) &&
          stepOnRoute(s, location.pathname) &&
          (attempts.current.get(s.id) ?? 0) < MAX_ATTEMPTS,
      ),
    [runSteps, seen, location.pathname],
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

  /**
   * 화면이 바뀌면 자동시작 잠금을 푼다 — 중단된 튜토리얼이 (같은 화면이든 다른 화면이든)
   * 다시 들어왔을 때 재개될 수 있게 한다. 같은 화면에 머무는 동안에는 잠금이 유지되므로
   * 재시작 루프는 생기지 않는다.
   *
   * ⚠️ 이 effect 는 **자동 시작 effect 보다 먼저 선언돼 있어야 한다**. 같은 커밋에서
   * effect 는 선언 순서로 실행되므로, 뒤에 두면 경로가 바뀐 그 렌더에서는 잠금이 아직
   * 걸린 채 시작 판정이 돌고(=재개 실패), 다음 리렌더가 올 때까지 튜토리얼이 멈춰 있게 된다.
   */
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    autoStartedFor.current = null;
  }, [location.pathname]);

  useEffect(() => {
    if (!token) return;
    if (!userId || autoStartedFor.current === userId) return;
    // 이미 진행 중이면 손대지 않는다 — 잠깐 다른 화면에 다녀오는 사이(유예 만료 전)
    // 재시작이 걸리면 진행하던 스텝이 0 으로 되감긴다.
    if (active) return;
    // 대상이 있는 화면(로비·덱)에 실제로 도착한 다음에만 시작한다.
    if (!autoStartPaths.includes(location.pathname)) return;
    const start = shouldStartTutorial({
      serverDone,
      localDone: readLocalDone(userId),
      pending: readTutorialPending(),
    });
    if (!start || runSteps.length === 0) return;
    // 재개 지점은 저장해 둔 인덱스가 아니라 **아직 안 봤고 이 화면에서 보여줄 수 있는** 첫 스텝이다.
    // 새 방문이므로 시도 횟수는 리셋한다(지난 방문에 대상이 없던 스텝도 다시 기회를 준다).
    attempts.current = new Map();
    const resumeAt = runSteps.findIndex(
      (s) => !seen.has(s.id) && stepOnRoute(s, location.pathname),
    );
    // 이 화면에서 보여줄 게 없다 = 전부 봤거나, 남은 게 다른 화면 스텝이다.
    // 후자는 그 화면에 들어갔을 때 여기서 다시 걸린다(그때까지 유저를 방해하지 않는다).
    if (resumeAt < 0) return;
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
    autoStartPaths,
    active,
    seen,
    goTo,
  ]);

  /**
   * 완료 저장 — **시작한 계정과 지금 계정이 같을 때만** 쓴다.
   * 계정 전환 직후에는 쿼리 캐시가 아직 이전 계정을 돌려주는 창이 있어서, 그때 저장하면
   * 엉뚱한 계정에 '완료'가 박힌다(그 계정은 한 스텝도 안 봤을 수 있다).
   */
  const persistIfOwner = useCallback(() => {
    if (ownerUserId.current !== null && ownerUserId.current === userId) {
      // #209: 이 저장이 서버에서 **덱 지급**을 트리거한다(멱등). 지급이 실제로 일어났으면
      // 덱 캐시를 무효화해야 유저가 덱 화면에서 빈 상태를 보지 않는다. tutorialDone 이
      // 바뀌었으므로 me 도 함께 갱신한다(재진입 시 튜토리얼 재노출 방지의 서버 축).
      void persistTutorialDone(userId).then((res) => {
        queryClient.invalidateQueries({ queryKey: ["me"] });
        if (res?.deckGranted) {
          queryClient.invalidateQueries({ queryKey: ["deck"] });
        }
      });
    }
    resetSession();
  }, [userId, resetSession, queryClient]);

  /**
   * **유저가 스스로 그만둠**(건너뛰기·ESC) — 본인이 온보딩 전체를 거절한 것이므로
   * 안 본 스텝이 남아 있어도 저장한다(AC-B1: 재노출 0).
   */
  const optOut = useCallback(() => {
    persistIfOwner();
  }, [persistIfOwner]);

  const currentId = runSteps[index]?.id;

  /** enabled 스텝을 하나도 빠짐없이 보여줬는가. */
  const allSeen = runSteps.every((s) => seen.has(s.id));

  /**
   * 다음 스텝으로 이동하거나 끝낸다. 갈 곳이 없을 때 **저장하느냐**가 이 함수의 전부다.
   *
   * 규칙은 둘이다.
   *  ① **전부 보여줬으면** 저장한다(원래 규칙).
   *  ② **유저가 [다음]을 눌러 끝냈으면** 아직 못 본 스텝이 남았어도 저장한다 (#386, hero 확정
   *     2026-08-01). 근거: 이건 **'건너뛰기'(optOut)와 같은 성질의 종료**다 — 유저가 안내를 끝까지
   *     읽고 마지막 [다음]을 누른 것이고, optOut 은 예전부터 `allSeen` 없이 저장해 왔다.
   *
   * ⚠️ **대상 부재 스킵(`onMissingTarget`)은 ②에 해당하지 않는다.** 그건 유저의 종료가 아니라
   * 화면 사정이므로 예전처럼 저장 없이 내려간다 — 안 그러면 "본 적 없는 스텝이 조용히 완료
   * 처리되는" 사고(이 파일이 세 라운드 걸쳐 막은 것)가 되살아난다.
   *
   * ② 가 없으면 어떻게 되나(#386 W1 실측): 홈 마지막 스텝에서 [덱 구성] 타일 대신 [다음]을 누른
   * 신규 유저는 덱 스텝 2개를 영영 못 채워 **완료가 저장되지 않는다** → 접속할 때마다 코치마크가
   * 처음부터 다시 돌고, 서버의 **덱 지급**(#209) 트리거도 안 걸리며, 공지는 매번 미뤄진다.
   * 남은 덱 화면 안내는 덱 셋업 워크스루(`startDeckSetup`, `/deck?setup=1`)가 따로 맡는다.
   */
  const advanceOrEnd = useCallback(
    (userDriven: boolean) => {
      const next = nextCandidate(currentId);
      if (next >= 0) {
        goTo(next);
        return;
      }
      if (allSeen || userDriven) {
        persistIfOwner();
        return;
      }
      setActive(false);
      setSetupMode(false);
    },
    [nextCandidate, currentId, goTo, allSeen, persistIfOwner],
  );

  const restart = useCallback(() => {
    resetTutorialDone(userId);
    setSeen(new Set());
    attempts.current = new Map();
    autoStartedFor.current = userId;
    ownerUserId.current = userId;
    // 다시보기 진입점이 어느 화면에 붙든 **그 화면에서 보여줄 수 있는** 첫 스텝부터 연다
    // (0 으로 고정하면 다른 화면에서는 첫 스텝이 대상 부재 스킵으로 낭비된다).
    const first = runSteps.findIndex((s) => stepOnRoute(s, location.pathname));
    setIndex(first < 0 ? 0 : first);
    setActive(true);
  }, [userId, runSteps, location.pathname]);

  /**
   * 덱 화면 스텝만 여는 targeted 시작 (#286 W3.5).
   *
   * ⚠️ **`ownerUserId` 를 비우는 것이 이 함수의 핵심이다.** `persistIfOwner` 는 소유자가
   * 현재 계정과 같을 때만 저장하므로, 비워 두면 이 흐름에서는 완료 저장 경로가 **구조적으로**
   * 닫힌다. `allSeen` 이 어차피 거짓일 것이라는 추론에 기대지 않는다 — 스텝 구성이 바뀌면
   * 그 추론은 조용히 무너지고, 그때 잃는 것은 서버의 **덱 지급**이다.
   */
  const startDeckSetup = useCallback(() => {
    ownerUserId.current = null;
    attempts.current = new Map();
    setSeen(new Set());
    setSetupMode(true);
    setIndex(0); // 셋업 시퀀스는 전부 /deck 이라 첫 스텝이 곧 시작점이다.
    setActive(true);
  }, []);

  const value = useMemo<TutorialControls>(
    () => ({ active, restart, startDeckSetup }),
    [active, restart, startDeckSetup],
  );
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
          onNext={() => advanceOrEnd(true)}
          onSkip={optOut}
          // 대상이 사라져 건너뛰는 것은 **유저의 종료가 아니다** — 저장 경로를 타지 않는다.
          onMissingTarget={() => advanceOrEnd(false)}
          onShown={markSeen}
          /**
           * '시작하기' 라벨은 **이번 클릭으로 튜토리얼이 진짜 끝날 때만** 단다.
           *
           * #386 이후 그 조건은 "이 화면에 다음 후보가 없다"와 같아졌다 — 유저가 누른 종료는
           * 다른 화면에 못 본 스텝이 남아 있어도 그대로 완료로 저장되기 때문이다(`advanceOrEnd`).
           * 라벨과 실제 동작이 갈리면 '다음'을 눌렀는데 온보딩이 끝나 버린 것처럼 읽힌다.
           */
          isLast={nextCandidate(step.id) < 0}
          missingGraceMs={missingGraceMs}
        />
      )}
    </TutorialContext.Provider>
  );
}
