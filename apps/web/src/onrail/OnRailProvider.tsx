import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDeck, useMe } from "../api/hooks";
import { useToken } from "../auth/TokenContext";
import { OnRailContext } from "./onrail-context";
import type { OnRailControls } from "./onrail-context";
import { OnRailOverlay } from "./OnRailOverlay";
import { ONRAIL_ACTION_EVENT, onRailActionIdOf } from "./onrail-actions";
import { useStartTutorialMatch, useTutorialCard } from "./onrail-api";
import {
  freezesMatch,
  nextStepId,
  onScreen,
  resolveStepId,
  resolveTarget,
  stepById,
  stepPosition,
} from "./onrail-logic";
import { ONRAIL_FIRST_STEP, ONRAIL_SCRIPT } from "./onrail-script";
import type { OnRailCta, OnRailStep } from "./onrail-script";
import { readOnRail, writeOnRail } from "./onrail-storage";
import type { OnRailState } from "./onrail-storage";

/**
 * #493 W7-v3 — **온레일 튜토리얼** 프로바이더.
 *
 * hero(리플랜 v3): *"게임 시작하면 셋팅부터 알려줘야하는데 지금 너무 자유도가 높아 거의 정해진
 * 화면에서 유저가 선택할 여유가 없이 강제해야돼."*
 *
 * ## 왜 또 하나의 프로바이더인가 (`TutorialProvider`·`GuideProvider` 가 이미 있는데)
 *
 * 셋은 **성질이 다르고 그 차이가 곧 각자의 저장 단위**다:
 *  · `TutorialProvider`(온보딩) — 계정 1회, 완료가 **서버 덱 지급**을 태운다. 저장 = 스텝 seen 집합.
 *  · `GuideProvider`(화면별 첫 진입) — 화면마다 1회, **비-모달**. 저장 = 화면 단위 seen.
 *  · **여기(온레일)** — 화면을 넘나드는 **한 줄기 시나리오**, 입력을 실제로 **막는다**.
 *    저장 = **스텝 단위**(엣지 표: *"진행 스텝 저장 → 재진입 시 그 스텝부터 재개"*).
 *
 * 합치면 한쪽의 규율이 다른 쪽을 깬다 — 온보딩 배열에 스텝을 더했다가 "n / total"과 완료 저장이
 * 같이 깨진 전례(hero Q7=A)가 그 값비싼 증거다.
 *
 * ## 발화 조건
 *
 * 온레일은 **스스로 뜨지 않는다.** 유일한 진입은 홈 [게임 시작] → 제안 모달의 [시작하기]
 * (`start()`)다. 그래서 기존 유저·목 유저에게 쏟아질 길이 구조적으로 없다 — `GuideProvider` 가
 * pending 래치로 지키는 것과 같은 목적을, 여기서는 **명시적 시작**이라는 더 강한 문으로 지킨다.
 *
 * ## 진행 규칙
 *
 *  · 스텝의 화면이 아니면 **아무것도 안 그린다**(유저는 자유). 그 화면에 도착하면 그 자리에서 잡는다.
 *  · `action` 스텝은 그 행동이 와야 넘어간다. **이번 run 에서 이미 한 행동은 도착 즉시 통과**시킨다
 *    (안내를 앞질러 간 유저를 "이미 한 일" 앞에 세우면 그건 갇힌 것이다 — 구 W6 부분작업의 판단을
 *    그대로 가져왔다). 이 성질이 **순서 경합**도 없앤다: [저장] 클릭은 입력칸 blur(=한마디 확정)를
 *    먼저 내므로 두 신호가 한 태스크에 몰려도 각각 자기 스텝에서 소비된다.
 *  · 마지막 스텝을 넘기면 `done` — 다시 뜨지 않는다.
 */
export function OnRailProvider({
  children,
  /** 테스트 주입용(각본 대신) — `GuideProvider.guides` 와 같은 관용구. */
  script,
  missingGraceMs,
}: {
  children?: ReactNode;
  script?: readonly OnRailStep[];
  missingGraceMs?: number;
}) {
  const { token } = useToken();
  const me = useMe();
  const userId = (me.data as { user?: { id?: string } } | undefined)?.user?.id ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const steps = script ?? ONRAIL_SCRIPT;

  /** React 밖(localStorage)이 SoT 라 화면용 사본을 하나 둔다 — 쓰기는 항상 둘 다 간다. */
  const [state, setState] = useState<OnRailState>({ status: "idle", stepId: null, matchId: null });
  /** 이번 run 에서 관측한 행동 id. run 이 시작될 때 비운다(지난 방문의 행동으로 넘어가지 않게). */
  const firedRef = useRef<Set<string>>(new Set());

  // 계정이 정해지면(또는 바뀌면) 그 계정의 진행도를 읽어 온다. **계정마다 격리**다.
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    if (loadedForRef.current === userId) return;
    loadedForRef.current = userId;
    firedRef.current = new Set();
    setState(readOnRail(userId));
  }, [userId]);

  const persist = useCallback(
    (next: OnRailState) => {
      setState(next);
      writeOnRail(userId, next);
    },
    [userId],
  );

  const running = Boolean(token) && state.status === "running";
  const stepId = running ? resolveStepId(state.stepId) : null;
  const step = useMemo(
    () => (stepId ? (script ? (script.find((s) => s.id === stepId) ?? null) : stepById(stepId)) : null),
    [stepId, script],
  );

  /** S5 대상 — 대기 중 선택권의 주인(= 스타터 고정 카드). 온레일이 돌 때만 조회한다. */
  const tutorialCardId = useTutorialCard(running);
  /** S2 대상 — 덱 첫 슬롯. 온레일 밖에서도 이미 도는 쿼리라 추가 요청이 아니다. */
  const deck = useDeck();
  const deckPlayerId =
    (deck.data as { slots?: { playerId?: string }[] } | null | undefined)?.slots?.[0]?.playerId ??
    null;

  const startMatch = useStartTutorialMatch();

  const advance = useCallback(() => {
    if (!stepId) return;
    const next = nextStepId(stepId);
    if (!next) {
      persist({ status: "done", stepId: null, matchId: state.matchId ?? null });
      return;
    }
    persist({ status: "running", stepId: next, matchId: state.matchId ?? null });
  }, [stepId, persist, state.matchId]);

  /** 말풍선 버튼이 하는 일 — **닫힌 목록**이라 데이터에 코드가 들어가지 않는다. */
  const runCta = useCallback(
    (cta: OnRailCta) => {
      switch (cta) {
        case "start-match":
          if (startMatch.isPending) return;
          startMatch.mutate(undefined, {
            onSuccess: (match) => {
              // 매치 id 를 먼저 굳히고 스텝을 넘긴다 — 순서가 바뀌면 투어 첫 스텝이 "내 매치인가"를
              // 아직 모르는 상태로 평가돼 한 프레임 동안 얼지 않는다.
              const next = nextStepId(stepId ?? ONRAIL_FIRST_STEP) ?? null;
              persist({ status: "running", stepId: next, matchId: match.id });
              navigate(`/match/${match.id}`);
            },
            // 실패해도 스텝은 그대로 둔다 — 유저는 [경기 시작]을 다시 누르거나 [그만두기]로 나간다.
            // (덱 없음·진행 중 매치는 각각 자기 안내가 있고, 자산 부재는 `useStartTutorialMatch`
            //  가 일반 연습경기로 흡수한다.)
          });
          return;
        case "go-growth":
          advance();
          navigate("/players");
          return;
        case "go-trade":
          advance();
          navigate("/recruit?tab=trade");
          return;
        case "finish":
          persist({ status: "done", stepId: null, matchId: state.matchId ?? null });
          navigate("/home");
          return;
      }
    },
    [startMatch, stepId, persist, navigate, advance, state.matchId],
  );

  // ── 행동 신호 ──────────────────────────────────────────────────────────
  //
  // **기다리는 것이 아니어도 전부 받아 적는다** — 그래야 유저가 안내를 앞질러 한 행동이 그 스텝에
  // 도착했을 때 통과된다(아래 effect). 지금 무엇을 기다리는지는 **ref 로 든다**: 리스너를 스텝마다
  // 떼었다 붙이면 그 재등록 사이에 도착한 행동이 사라진다([저장] 한 번이 blur → click 을 연달아 낸다).
  const waitingRef = useRef<string | undefined>(undefined);
  waitingRef.current = step?.advance.kind === "action" ? step.advance.action : undefined;

  useEffect(() => {
    if (!running) return;
    const onAction = (e: Event) => {
      const id = onRailActionIdOf(e);
      if (!id) return;
      firedRef.current.add(id);
      if (waitingRef.current === id) advance();
    };
    window.addEventListener(ONRAIL_ACTION_EVENT, onAction);
    return () => window.removeEventListener(ONRAIL_ACTION_EVENT, onAction);
  }, [running, advance]);

  // 이미 한 행동이면 그 스텝은 도착 즉시 통과.
  const waiting = step?.advance.kind === "action" ? step.advance.action : undefined;
  useEffect(() => {
    if (waiting && firedRef.current.has(waiting)) advance();
  }, [waiting, advance]);

  // ── 컨텍스트 ──────────────────────────────────────────────────────────
  const matchFrozen =
    running &&
    Boolean(state.matchId) &&
    location.pathname === `/match/${state.matchId}` &&
    freezesMatch(step, location.pathname);

  const value = useMemo<OnRailControls>(
    () => ({
      running,
      stepId,
      matchFrozen,
      start: () => {
        firedRef.current = new Set();
        persist({ status: "running", stepId: ONRAIL_FIRST_STEP, matchId: null });
        navigate("/deck");
      },
      skip: () => persist({ status: "skipped", stepId: null, matchId: null }),
    }),
    [running, stepId, matchFrozen, persist, navigate],
  );

  // ── 렌더 ─────────────────────────────────────────────────────────────
  const onThisScreen = Boolean(step && onScreen(step, location.pathname));
  const target = step ? resolveTarget(step, { deckPlayerId, tutorialCardId }) : null;
  const pos = stepId ? stepPosition(stepId) : { index: 0, total: steps.length };

  /**
   * 탈출구로 홈에 나와 있는 동안의 **되돌아가는 문**(엣지 표: *"홈으로 나가면 이탈로 취급,
   * 재진입 시 그 스텝부터"*). 이게 없으면 진행 중인 유저가 홈에서 [게임 시작]을 눌러도 제안
   * 모달은 이미 답한 상태라 안 뜨고, 온레일로 돌아갈 길이 사라진다.
   */
  const showResume = running && !onThisScreen && location.pathname === "/home";

  return (
    <OnRailContext.Provider value={value}>
      {children}
      {running && step && onThisScreen && (
        <OnRailOverlay
          key={step.id}
          step={step}
          targetTestId={target}
          index={pos.index}
          total={pos.total}
          missingGraceMs={missingGraceMs}
          onAdvance={() => {
            if (step.advance.kind === "cta") runCta(step.advance.cta);
            else advance();
          }}
          onMissingTarget={advance}
          onExit={() => navigate("/home")}
        />
      )}
      {showResume && (
        <OnRailOverlay
          key="onrail-resume"
          step={RESUME_STEP}
          targetTestId={null}
          index={pos.index}
          total={pos.total}
          missingGraceMs={missingGraceMs}
          onAdvance={() => navigate(resumePathFor(step))}
          onMissingTarget={() => {}}
          /* 이어하기 카드에서의 탈출은 **진짜 그만두기**다 — 여기서까지 진행도를 남기면 홈에
             올 때마다 같은 카드가 떠서 그 카드 자체가 빠져나갈 수 없는 벽이 된다. */
          exitLabel="그만두기"
          onExit={() => persist({ status: "skipped", stepId: null, matchId: null })}
        />
      )}
    </OnRailContext.Provider>
  );
}

/**
 * 홈에서 뜨는 이어하기 카드 — **각본에 없는 합성 스텝**이다.
 *
 * 각본에 넣지 않는 이유: 각본은 "유저가 밟는 길"이고 이건 **길 밖에서 길로 돌아오는 문**이다.
 * 넣으면 진행 표시(n / total)와 다음 스텝 계산이 이 문을 한 칸으로 세기 시작한다.
 */
const RESUME_STEP: OnRailStep = {
  id: "onrail-resume",
  screen: "*",
  title: "튜토리얼을 이어서 할까요?",
  body: "하던 곳부터 다시 시작합니다. 남은 보상도 그대로 기다리고 있어요.",
  advance: { kind: "cta", label: "이어서 하기", cta: "finish" }, // 라벨만 쓴다(동작은 호출부가 정한다)
};

/** 이어하기가 데려갈 곳. 매치 스텝은 그 매치로, 나머지는 그 화면으로. */
function resumePathFor(step: OnRailStep | null): string {
  if (!step) return "/home";
  if (step.screen === "/match") return "/home"; // 매치는 잠금 게이트(#217)가 알아서 되돌린다
  if (step.screen === "/recruit") return "/recruit?tab=trade";
  if (step.screen === "*") return "/home";
  return step.screen;
}
