import { useCallback, useEffect, useRef, useState } from "react";
import type { MatchDetail } from "../../api/hooks";
import { FLOW_TIMING } from "./flow-copy";
import {
  beatForTransition,
  bridgeForTransition,
  enqueueBridge,
  isOverlayKind,
  type BeatKind,
  type OverlayBridgeKind,
  type QueuedBridge,
} from "./match-flow";

export interface MatchFlowHandle {
  /** 지금 열려 있는 종료형 브릿지(큐 맨 앞). 없으면 null. */
  bridge: QueuedBridge | null;
  /** 킥오프 비트(자동 소멸). 브릿지와 **별개 층**이다. */
  beat: BeatKind | null;
  /**
   * 무대(캔버스)를 내려야 하는가.
   *
   * ⚠️ **비트는 포함하지 않는다** — 비트는 백드롭 없이 경기 화면 위에 겹치는 카드라(설계 §4.3)
   * 뒤가 비쳐야 한다. 여기에 비트를 넣으면 킥오프 순간 화면이 통째로 사라진다.
   */
  overlayOpen: boolean;
  /** 스킵 성공 신호(`SkipButton.onSkipped`) — 리포트가 앞에 붙은 브릿지를 큐에 넣는다. */
  openReport: (half: 1 | 2) => void;
  /** 맨 앞 브릿지를 소비한다(닫기). 소비 이력이 남아 폴링이 다시 열지 않는다. */
  close: () => void;
  dismissBeat: () => void;
}

/**
 * 경기 흐름 브릿지의 **전이 관측 · 큐 · 소비 이력** (#424 W1).
 *
 * 소유자는 `MatchPage` 다(`StageShell` 아님) — 패널이 갈려도 오버레이가 살아 있어야 하기 때문이다.
 * 그게 #421 이 남긴 D6 갭의 해소다: 스킵 응답이 `GEN2` 면 `panelForState` 가 `GenWaitPanel` 로
 * 라우팅해 `StageShell` 이 언마운트되고, 거기 매달려 있던 리포트가 같이 사라졌다.
 *
 * ⚠️ **첫 관측(prev=null)에서는 아무것도 열지 않는다.** 규칙은 `bridgeForTransition` 이 소유하고
 * 여기서는 "매치가 바뀌면 prev 를 다시 잡는다"만 더한다 — 다른 매치로 갈아탄 첫 프레임을 전이로
 * 읽으면 (예: `FIRST_HALF` 매치 → `FINISHED` 매치) 있지도 않은 브릿지가 뜬다.
 */
export function useMatchFlow(match: MatchDetail | undefined): MatchFlowHandle {
  const matchId = match?.id ?? null;
  const state = match?.state ?? null;

  const [queue, setQueue] = useState<QueuedBridge[]>([]);
  const [beat, setBeat] = useState<BeatKind | null>(null);
  /** 닫은 종류 — 폴링이 같은 브릿지를 다시 열지 않게 한다(설계 §6.2). 매치별로 비운다. */
  const seenRef = useRef<OverlayBridgeKind[]>([]);
  const prevRef = useRef<{ id: string | null; state: string | null }>({ id: null, state: null });
  const queueRef = useRef<QueuedBridge[]>(queue);
  queueRef.current = queue;

  const push = useCallback((incoming: QueuedBridge) => {
    setQueue((q) => enqueueBridge(q, seenRef.current, incoming));
  }, []);

  useEffect(() => {
    const prev = prevRef.current;
    if (prev.id !== matchId) {
      // 다른 매치(또는 첫 도착) — **전이가 아니다**. 기준점만 잡고 나간다.
      prevRef.current = { id: matchId, state };
      seenRef.current = [];
      setQueue([]);
      setBeat(null);
      return;
    }
    if (prev.state === state) return;
    prevRef.current = { id: matchId, state };

    const bridge = bridgeForTransition(prev.state, state);
    // 대기형(`panel`)은 큐에 넣지 않는다 — 그 화면은 이미 패널로 존재하고, 오버레이로 덮으면
    // `GenWaitPanel` 의 경과 시계·[경기 포기](#217 AC3)가 가려진다(설계 §6.3).
    if (bridge && isOverlayKind(bridge.kind)) push({ kind: bridge.kind, report: null });

    const nextBeat = beatForTransition(prev.state, state);
    // `beatMs === 0` = 비트 없음(조정 포인트 §11-2). 켜지지 않은 연출의 타이머를 걸지 않는다.
    if (nextBeat && FLOW_TIMING.beatMs > 0) setBeat(nextBeat);
  }, [matchId, state, push]);

  useEffect(() => {
    if (!beat) return;
    const t = window.setTimeout(() => setBeat(null), FLOW_TIMING.beatMs);
    return () => window.clearTimeout(t);
  }, [beat]);

  const openReport = useCallback(
    (half: 1 | 2) => push({ kind: half === 1 ? "h1_end" : "match_end", report: half }),
    [push],
  );

  const close = useCallback(() => {
    const front = queueRef.current[0];
    if (front && !seenRef.current.includes(front.kind)) {
      seenRef.current = [...seenRef.current, front.kind];
    }
    setQueue((q) => q.slice(1));
  }, []);

  const dismissBeat = useCallback(() => setBeat(null), []);

  const bridge = queue[0] ?? null;
  /**
   * B2 자동 소멸 백스톱 — **기본은 꺼져 있다**(`h1EndAutoDismissMs === 0`, 설계 §4.2·조정 포인트 §11-4).
   *
   * 브릿지를 읽는 동안 감독시간(3분)이 흐르는데 서버 창을 늘릴 수단이 없다(`/skip` 은 단축 전용).
   * 지금은 **남은 시간 표시**로만 완화하고, 실사용에서 잠식이 문제가 되면 상수 하나로 켠다.
   * ⚠️ 배선을 미리 해 두는 이유 = 상수만 있고 소비자가 없으면 다음 사람이 값을 바꿔도 아무 일도
   * 일어나지 않는다(문서에만 있는 노브는 거짓말이다).
   */
  useEffect(() => {
    if (bridge?.kind !== "h1_end" || FLOW_TIMING.h1EndAutoDismissMs <= 0) return;
    const t = window.setTimeout(close, FLOW_TIMING.h1EndAutoDismissMs);
    return () => window.clearTimeout(t);
  }, [bridge?.kind, close]);

  return { bridge, beat, overlayOpen: bridge != null, openReport, close, dismissBeat };
}
