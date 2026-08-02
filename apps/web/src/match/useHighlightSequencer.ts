import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { MatchClock } from "@hmb/shared";
import type { ViewerController } from "@hmb/viewer-core";
import { liveGate } from "./live-clock";
import { driftAllowanceTicks, indexOfPlayhead, tickOfIndex } from "./live-pace";
import type { Scene } from "./highlight-reel";
import {
  CURSOR_START,
  SEQUENCER_POLL_MS,
  gateWouldRecover,
  highlightAvailable,
  highlightDefaultOn,
  highlightToggleView,
  nextSequencerAction,
  reelEventsOf,
  reelFor,
  type HighlightToggleView,
} from "./highlight-sequencer";

/**
 * 하이라이트 순서 재생 **구동** (#421 W4).
 *
 * 판정은 전부 순수 모듈(`highlight-sequencer.ts`)이 하고, 이 훅은 그 결정을 뷰어 컨트롤러에 옮기기만
 * 한다 — `jumpToTick` + `play` + `cur().tick` 폴링. **기존 컨트롤러 API 만 쓴다**(`viewer.impl.mjs`
 * 무접촉 — #406 W5 가 직렬 점유 중이고, 여기 필요한 것은 "장면 목록"이지 코어의 슬로우모션 창이 아니다).
 * `jumpEvent` 는 ±2틱 가드가 있어 장면 구동에 부적합하다.
 *
 * 🔴 **라이브 게이트 effect(`VisualPlayback` :206-244)는 한 줄도 건드리지 않는다.** 배타 규칙과 그
 * 근거는 `highlight-sequencer.ts` 머리말 ① — 요약하면 ⓐ 시퀀서 점프는 상한 이하라 게이트를 발화시킬
 * 수 없고 ⓑ 게이트가 일하는 폴에서는 시퀀서가 손을 뗀다. 그래서 **게이트가 항상 이긴다.**
 */
export interface HighlightSequencerOptions {
  /** 캔버스에 마운트된 코어. `viewerReady` 가 참일 때만 유효하다. */
  viewerRef: RefObject<ViewerController | null>;
  viewerReady: boolean;
  /** 하프 로그(형태를 믿지 않는다 — `reelEventsOf` 가 방어한다). */
  log: unknown;
  half: 1 | 2;
  /** 돌려보는 화면(#244)이면 시퀀서를 아예 붙이지 않는다. */
  review: boolean;
  clock: MatchClock | null;
  clockOffsetMs: number;
  /** 스냅샷 절대 틱 목록 — 서버 시계(인덱스) ↔ 뷰어(절대 틱) 환산에 쓴다. */
  snapTicks: readonly number[];
}

export interface HighlightSequencerState {
  /** 토글 버튼 화면 상태(`highlightToggleView`). */
  view: HighlightToggleView;
  enabled: boolean;
  toggle: () => void;
}

export function useHighlightSequencer(opts: HighlightSequencerOptions): HighlightSequencerState {
  const { viewerRef, viewerReady, log, half, review, clock, clockOffsetMs, snapTicks } = opts;

  const available = highlightAvailable({ half, review });
  /*
   * **이 하프가 라이브인가** — 시각이 아니라 `clock.phase ↔ half` 매칭이라 시간에 따라 흔들리지 않는다
   * (`liveClockForHalf`). 라이브면 디폴트가 꺼진다(이유 = `highlight-sequencer.DEFAULT_ON_WHILE_LIVE`).
   */
  const live = liveGate(clock, half, snapTicks.length, Date.now(), clockOffsetMs).isLive;
  const [enabled, setEnabled] = useState(() => highlightDefaultOn({ half, review, live }));
  /*
   * 하프가 바뀌거나(전반 → 후반) **라이브가 풀리면**(후반 종료·스킵 → FINISHED) 디폴트를 다시
   * 적용한다 — 후반이 끝나는 그 자리에서 하이라이트 리플레이로 바뀐다. 같은 상태 안에서 유저 선택은
   * 유지된다(이 effect 는 half/review/live 가 바뀔 때만 돈다).
   */
  useEffect(() => {
    setEnabled(highlightDefaultOn({ half, review, live }));
  }, [half, review, live]);

  const events = useMemo(() => reelEventsOf(log), [log]);
  // 시계는 프레임마다 바뀌는 값이라 effect 재실행 트리거로 쓰지 않는다(게이트 effect 와 같은 패턴).
  const gateInput = useRef({ clock, clockOffsetMs, half });
  gateInput.current = { clock, clockOffsetMs, half };

  const [status, setStatus] = useState<{ scene: Scene | null; index: number; total: number }>({
    scene: null,
    index: 0,
    total: 0,
  });

  useEffect(() => {
    if (!enabled || !available || !viewerReady) return;
    const v = viewerRef.current;
    if (!v || snapTicks.length === 0) return;

    // 커서·재생 중 장면은 **이 실행의 지역 상태**다 — state 로 두면 250ms 마다 리렌더가 난다.
    let cursor = CURSOR_START;
    let active: Scene | null = null;

    const step = () => {
      const view = viewerRef.current;
      // 코어 표면을 믿지 않는다 — 테스트 더블·구 코어면 조용히 아무것도 하지 않는다(화면은 성립한다).
      if (!view || typeof view.jumpToTick !== "function" || typeof view.hooks?.cur !== "function") return;
      const { clock: c, clockOffsetMs: off, half: h } = gateInput.current;
      const gate = liveGate(c, h, snapTicks.length, Date.now(), off);
      // 서버 시계는 **인덱스**로, 장면은 **절대 틱**으로 말한다 — 섞으면 후반(틱 1350~)에서 상한이
      // 무력해진다(`MatchViewer`·`VisualPlayback` 이 같은 함정을 주석으로 남겨 뒀다).
      const liveTick = gate.isLive ? tickOfIndex(snapTicks, gate.liveTick) : undefined;
      const curTick = Number(view.hooks.cur()?.tick ?? 0);
      const curIdx = indexOfPlayhead(snapTicks, curTick);
      const gateRecovering =
        gate.isLive && gateWouldRecover(curIdx, gate.clamp(curIdx), driftAllowanceTicks(snapTicks.length));

      const scenes = reelFor(events, liveTick);
      const action = nextSequencerAction({
        scenes,
        cursorTick: cursor,
        active,
        curTick,
        ...(liveTick !== undefined ? { liveTick } : {}),
        gateRecovering,
      });
      cursor = action.cursorTick;
      if (action.kind !== "jump") return;

      active = action.scene;
      view.jumpToTick(action.toTick);
      view.play();
      setStatus({ scene: action.scene, index: action.index, total: scenes.length });
    };

    // 첫 판단은 **즉시** — 라이브 게이트의 seek-to-now 직후 화면이 하이라이트 #1로 들어간다.
    step();
    const timer = window.setInterval(step, SEQUENCER_POLL_MS);
    return () => {
      window.clearInterval(timer);
      setStatus({ scene: null, index: 0, total: 0 });
    };
    // clock/offset 은 ref 로 본다(위) — 폴링마다 최신값을 읽으므로 deps 에 넣지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, available, viewerReady, events, snapTicks, half]);

  return {
    enabled,
    /*
     * 전체 재생 복귀 = 이 한 줄. 끄면 위 effect 가 정리되고 **그 지점부터 이어 재생**한다
     * (라이브면 게이트가 상한만 계속 지킨다). 다시 켜면 하이라이트 #1부터 다시 돈다.
     */
    toggle: () => setEnabled((on) => !on),
    view: highlightToggleView({
      available,
      enabled,
      scene: status.scene,
      index: status.index,
      total: status.total,
    }),
  };
}
