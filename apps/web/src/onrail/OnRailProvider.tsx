import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useActiveMatch, useDeck, useMe } from "../api/hooks";
import { useToken } from "../auth/TokenContext";
import { matchInProgressIdOf } from "../common/match-lock";
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
  screenLockedFor,
  stageNotReadyFor,
  stepAfterSkip,
  stepById,
  stepPosition,
} from "./onrail-logic";
import type { OnRailSkipReason } from "./onrail-logic";
import { ONRAIL_FIRST_STEP, ONRAIL_SCRIPT } from "./onrail-script";
import type { OnRailCta, OnRailStep } from "./onrail-script";
import { appendSkip, readOnRail, writeOnRail } from "./onrail-storage";
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
  /** CTA 가 서버에 닿았다가 실패했을 때 말풍선이 대신 말해 주는 한 줄(딤 밖으로 못 나가는 화면이라). */
  const [ctaError, setCtaError] = useState<string | null>(null);

  /**
   * **복원 직후인가** — 이번 화면에서 스텝을 밟아 온 것이 아니라 저장된 진행도를 읽어 왔는가.
   * 아래 "한마디 되감기"가 **복원 창에서만** 도는 이유다(그 창 밖에서 돌면 방금 입력한 한마디를
   * 서버가 아직 모른다는 이유로 되감아 버린다).
   */
  const restoredRef = useRef(false);

  // 계정이 정해지면(또는 바뀌면) 그 계정의 진행도를 읽어 온다. **계정마다 격리**다.
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    if (loadedForRef.current === userId) return;
    loadedForRef.current = userId;
    firedRef.current = new Set();
    restoredRef.current = true;
    setState(readOnRail(userId));
  }, [userId]);

  /** 항상 최신 상태 — `persist` 가 **부수 축**(스킵 기록·일회성 지시)을 스스로 실어 나르기 위해. */
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * ⚠️ **부수 축은 호출부가 실어 나르지 않는다** (#493 W9). 스텝을 옮기는 자리가 이제 여섯 곳
   * (advance · 되감기 · CTA 3 · skipStep)인데, 각자 `skips` 를 손으로 복사하게 두면 하나만
   * 빠뜨려도 **기록이 조용히 사라진다** — 그리고 사라진 기록은 아무 화면도 빨갛게 만들지 않는다.
   * 명시적으로 준 값만 이기고, 안 준 축은 여기서 보존한다.
   */
  const persist = useCallback(
    (next: OnRailState) => {
      const merged: OnRailState = {
        ...next,
        skips: next.skips ?? stateRef.current.skips,
        deckDraftReset: next.deckDraftReset ?? stateRef.current.deckDraftReset,
      };
      setState(merged);
      writeOnRail(userId, merged);
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
    restoredRef.current = false; // 한 칸이라도 밟았으면 더는 "복원 직후"가 아니다
    const next = nextStepId(stepId);
    if (!next) {
      persist({ status: "done", stepId: null, matchId: state.matchId ?? null });
      return;
    }
    persist({ status: "running", stepId: next, matchId: state.matchId ?? null });
  }, [stepId, persist, state.matchId]);

  /**
   * **전제가 깨진 스텝을 건너뛴다** (#493 W9) — 온레일이 못 하는 일 앞에 유저를 세우지 않는다.
   *
   * 무엇이 전제인지·어디까지 건너뛰는지는 전부 `onrail-logic` 이 정한다(순수). 여기서 하는 일은
   * **사유를 남기고 옮기는 것**뿐이다.
   *
   * ⚠️ 앞으로만 간다(`stepAfterSkip` 은 인덱스를 단조 증가시킨다). 그래서 어떤 조합에서도
   * 각본 끝 = **완주 스텝에 닿는다** — 그것이 이 웨이브의 AC 이고, 완주 스텝은 화면도
   * (`ANY_SCREEN`) 대상도 없어 어떤 전제에도 걸리지 않는다.
   */
  const skipStep = useCallback(
    (reason: OnRailSkipReason) => {
      if (!stepId) return;
      restoredRef.current = false;
      const to = stepAfterSkip(stepId, reason);
      const skips = appendSkip(stateRef.current.skips, {
        stepId,
        reason,
        to,
        at: new Date().toISOString(),
      });
      persist({
        status: to ? "running" : "done",
        stepId: to,
        matchId: state.matchId ?? null,
        skips,
      });
    },
    [stepId, persist, state.matchId],
  );

  /**
   * **복원했는데 한마디가 저장돼 있지 않으면 그 스텝으로 되감는다** (독립 검증 2R B1).
   *
   * 저장 단위는 스텝인데 **화면 상태는 저장되지 않는다** — 새로고침·[나중에]로 나갔다 오면 덱
   * draft 는 서버 덱에서 다시 읽히므로 유저가 쳤던 "감독의 한마디"가 사라진다. 그런데 스텝은
   * `deck-save` 로 이미 넘어가 있어서, 그 자리에서 유일하게 열린 [저장]을 누르면 **한마디가 없는
   * 덱이 저장되고 첫 저장 보상까지 태워진다**(그러면 되돌릴 방법이 없다). 각본이 순서를 뒤집어
   * (AUTO → 프롬프트 → 저장) 막으려던 바로 그 사고를 재진입이 되살리는 자리다.
   *
   * ⚠️ **복원 창에서만** 판정한다(`restoredRef`). 그 창 밖에서 같은 조건을 보면, 방금 한마디를 치고
   * 아직 저장하지 않은 정상 상태(서버 덱에는 당연히 없다)를 되감아 무한 루프를 만든다.
   *
   * ⚠️ 되감는 자리는 `deck-prompt` 가 아니라 **`deck-player`** 다. 입력칸(`rail-prompt-input`)은
   * 선수를 고른 뒤에만 존재하고(폰은 선수 메뉴를 한 번 더 지난다, #455 A2), 그 앞에 세우면 대상이
   * 없어 오버레이가 **hold 로 사라진다** = 안내 없는 화면이 된다(실측으로 밟았다). 한 칸 앞의
   * "선수를 눌러 보세요"는 대상이 언제나 있으므로 그 자리에서 다시 잡힌다.
   */
  useEffect(() => {
    if (!restoredRef.current || !running || stepId !== "deck-save") return;
    const slots = (deck.data as { slots?: { promptText?: string | null }[] } | null | undefined)?.slots;
    if (!Array.isArray(slots)) return; // 아직 모른다 — 판정하지 않는다(없다고 단정하지 않는다)
    restoredRef.current = false;
    const saved = slots.some((s) => (s?.promptText ?? "").trim().length > 0);
    if (!saved) persist({ status: "running", stepId: "deck-player", matchId: state.matchId ?? null });
  }, [running, stepId, deck.data, persist, state.matchId]);

  /** 말풍선 버튼이 하는 일 — **닫힌 목록**이라 데이터에 코드가 들어가지 않는다. */
  const runCta = useCallback(
    (cta: OnRailCta) => {
      switch (cta) {
        case "start-match":
          if (startMatch.isPending) return;
          setCtaError(null);
          startMatch.mutate(undefined, {
            onSuccess: (match) => {
              // 매치 id 를 먼저 굳히고 스텝을 넘긴다 — 순서가 바뀌면 투어 첫 스텝이 "내 매치인가"를
              // 아직 모르는 상태로 평가돼 한 프레임 동안 얼지 않는다.
              const next = nextStepId(stepId ?? ONRAIL_FIRST_STEP) ?? null;
              persist({ status: "running", stepId: next, matchId: match.id });
              navigate(`/match/${match.id}`);
            },
            /*
             * ⚠️ **실패를 삼키지 않는다** (독립 검증 2R B4).
             *
             * 구 동작은 `onError` 자체가 없어서 폴백 2종(자산 부재·1회 제한, `onrail-api` 가 흡수)
             * **밖의** 실패 — 진행 중 매치(409)·덱 거부(400)·5xx·네트워크 — 가 전부 **눌러도 아무
             * 일 없는 버튼**이 됐다. 딤이 화면을 막고 있어 다른 화면의 안내는 도달하지 못하고
             * (`ErrorToast` 도 딤 아래로 깔린다), 유저에게는 튜토리얼이 죽은 것으로 보인다.
             *
             * 409 는 실패가 아니라 **이어가라는 안내**다(#217) — `usePracticeStart` 가 이미 그 규칙을
             * 소유하므로 판정 함수를 그대로 재사용한다(문구를 여기 다시 적으면 규칙이 두 벌이 된다).
             * 그 매치로 데려가면서 스텝도 같이 넘긴다: 투어는 "그 매치 화면"을 전제로 하지 그 매치가
             * 방금 만들어졌는지는 묻지 않는다.
             */
            onError: (err) => {
              const resumeId = matchInProgressIdOf(err);
              if (resumeId) {
                const next = nextStepId(stepId ?? ONRAIL_FIRST_STEP) ?? null;
                persist({ status: "running", stepId: next, matchId: resumeId });
                navigate(`/match/${resumeId}`);
                return;
              }
              // 나머지는 **말로 알린다**. 스텝은 그대로 두어 다시 누를 수 있게 남긴다.
              setCtaError(
                err instanceof ApiError && err.message
                  ? err.message
                  : "경기를 시작하지 못했습니다 — 잠시 후 다시 시도해 주세요",
              );
            },
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

  // ── 갈 수 없는 화면 (#493 W9) ────────────────────────────────────────
  //
  // 여기만 프로바이더가 판정한다 — 화면에 **도착조차 못 하므로** 오버레이가 뜨지 않고(hold),
  // 그래서 DOM 을 보는 쪽(`OnRailOverlay`)에는 이 상태를 볼 눈이 없다. 유저에게는 안내도 없이
  // 튜토리얼이 사라진 것으로 보인다(W8-v3 blocker B3).
  const activeMatch = useActiveMatch();
  const lockedOut = running && screenLockedFor(step, activeMatch.data);
  /*
   * 무대가 아직 안 열린 창(BRIEFING·GEN1·GEN2) — 투어 스텝의 부재 스킵을 유예한다(#493 W11).
   * 같은 `activeMatch` 를 읽지만 **문이 다르다**: `lockedOut` 은 "갈 수 없는 화면"이라 넘기고,
   * 이쪽은 "곧 열릴 화면"이라 **기다린다**.
   */
  const stageNotReady = running && stageNotReadyFor(step, activeMatch.data);
  const lockGraceMs = missingGraceMs ?? 1500;

  useEffect(() => {
    if (!lockedOut) return;
    /*
     * ⚠️ **유예를 둔다.** `activeMatch` 는 방금 끝난 경기의 `locked:true` 를 한 창 동안 들고 있을
     * 수 있고(그 쿼리가 `staleTime:0`·`refetchOnMount:"always"` 인 이유가 바로 그 창이다), 그
     * 프레임에 판정하면 **정상 유저의 S5·S6 가 통째로 날아간다**. 스킵은 되돌릴 수 없으므로
     * 늦게 판정하는 쪽이 항상 싸다.
     */
    const t = window.setTimeout(() => skipStep("screen-locked"), lockGraceMs);
    return () => window.clearTimeout(t);
  }, [lockedOut, stepId, skipStep, lockGraceMs]);

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
      deckDraftReset: running && state.deckDraftReset === true,
      consumeDeckDraftReset: () => {
        if (!stateRef.current.deckDraftReset) return;
        persist({ ...stateRef.current, deckDraftReset: false });
      },
      start: () => {
        firedRef.current = new Set();
        restoredRef.current = false;
        /*
         * ⚠️ **덱 드래프트를 비우고 출발한다** (#493 W9). S2 각본은 AUTO → 프롬프트 → 저장인데,
         * 온보딩 완료가 이미 11명짜리 덱을 지급하므로 이 동선의 유저는 **빈 자리가 없다** →
         * `hasEmptySlotGap` 이 거짓이면 버튼이 아예 없고, 보유를 다 배치했으면 있어도 비활성이다.
         * 어느 쪽이든 "오토버튼 누르게 하고"(hero)가 한 번도 성립하지 않는다.
         *
         * 비우는 것은 **클라 드래프트뿐**이다 — 서버 덱은 유저가 [저장]을 누를 때까지 그대로고,
         * 레일을 그만두면 다음 진입에서 서버 덱이 그대로 다시 그려진다(잃는 것이 없다).
         * 기록·스킵은 새 run 이니 비운다.
         */
        persist({
          status: "running",
          stepId: ONRAIL_FIRST_STEP,
          matchId: null,
          skips: [],
          deckDraftReset: true,
        });
        navigate("/deck");
      },
      skip: () =>
        persist({ status: "skipped", stepId: null, matchId: null, deckDraftReset: false }),
    }),
    [running, stepId, matchFrozen, persist, navigate, state.deckDraftReset],
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
          /* 무대가 아직 안 열렸으면 손잡이의 부재는 "아직"이지 "없음"이 아니다(#493 W11). */
          holdMissing={stageNotReady}
          note={ctaError}
          onAdvance={() => {
            if (step.advance.kind === "cta") runCta(step.advance.cta);
            else advance();
          }}
          /* 두 문 다 **사유를 남기고** 넘어간다 — 어느 전제가 이 유저에게 안 열렸는지가
             나중에 셀 수 있는 유일한 형태다(#493 W9). */
          onMissingTarget={() => skipStep("target-missing")}
          onTargetDisabled={() => skipStep("target-disabled")}
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
          onAdvance={() => navigate(resumePathFor(step, state.matchId ?? null))}
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

/**
 * 이어하기가 데려갈 곳. 매치 스텝은 **그 매치로**, 나머지는 그 화면으로.
 *
 * ⚠️ 구 동작은 매치 스텝을 `/home` 으로 돌려주고 *"잠금 게이트(#217)가 알아서 되돌린다"* 고 적었다.
 * 그 전제는 **경기가 아직 진행 중일 때만** 참이다 — 투어를 지나 결과(`result-view`)에 온 뒤에는
 * 매치가 FINISHED 라 되돌릴 잠금이 없고, [이어서 하기]가 홈에서 홈으로 가는 **무동작 루프**가 된다
 * (독립 검증 2R B5). 그 매치 id 는 이미 들고 있으므로(`state.matchId` — 투어를 얼릴 때 쓰는 값)
 * 그리로 보낸다. 없을 때만 홈이다.
 */
function resumePathFor(step: OnRailStep | null, matchId: string | null): string {
  if (!step) return "/home";
  if (step.screen === "/match") return matchId ? `/match/${matchId}` : "/home";
  if (step.screen === "/recruit") return "/recruit?tab=trade";
  if (step.screen === "*") return "/home";
  return step.screen;
}
