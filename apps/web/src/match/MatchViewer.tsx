import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useHalfLog } from "../api/hooks";
import {
  eventDisplay,
  formatClock,
  keyEvents,
  revealInterval,
  runningScore,
  type MatchEventLike,
} from "./match-logic";
import {
  bridgeReducer,
  initialBridgeState,
  isViewerReadyMessage,
  highlightMessage,
  isViewerStateMessage,
  loadMatchLogMessage,
  setChromeMessage,
  shouldFallbackAfterTimeout,
  shouldPostLog,
  VIEWER_EMBED_SRC,
  VIEWER_READY_TIMEOUT_MS,
} from "./viewer-bridge";
import { useAdminFlag } from "../admin/admin-flag";
import {
  canSwitchControlMode,
  CONTROL_MODE_STORAGE_KEY,
  isControlModeReset,
  resolveControlMode,
  type ControlMode,
} from "./playback-controls";
import { PlaybackControls } from "./PlaybackControls";
import { buildViewerSkins } from "./viewer-skins";
import { useCharAssets } from "../common/useCharAssets";
import styles from "./MatchViewer.module.css";

interface MatchViewerProps {
  matchId: string;
  half: 1 | 2;
  homeName: string;
  awayName: string;
  /** 재생 플레이헤드 미러링 — 호스트(스코어바·통계·로그)가 "지금까지"를 계산하는 기준. */
  onTick?: (tick: number) => void;
}

type ViewMode = "visual" | "timeline";

/**
 * 경기 재생 무대 (LLD-web §3, AC-W5 / #169 S1).
 * QA dev-viewer 번들(viewer-embed.html)을 iframe 임베드 → viewerReady 수신 후 해당 half MatchLog 를
 * postMessage 로 주입해 피치/선수/공을 재생한다(QA 뷰어 소비만 — 캔버스 렌더러 자체 구현 금지, #57.
 * 렌더 코어 수렴은 S2/S3 에서).
 *
 * 관전 셸의 고정 무대를 꽉 채우고, 시각 재생이 실패했을 때만 같은 자리에서 텍스트 타임라인으로
 * 폴백한다(모드 탭은 #169 S1 에서 제거 — 무대 위 상시 40px 를 먹었고, 관객이 고를 일이 아니다).
 */
export function MatchViewer({ matchId, half, homeName, awayName, onTick }: MatchViewerProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half);
  const [mode, setMode] = useState<ViewMode>("visual");
  // #148 컨트롤 모드: 계정/QA 플래그로 판정하되, admin/QA 가 토글하면 그 선택이 이긴다.
  // (useAdminFlag 는 /api/me 응답 뒤 true 로 바뀔 수 있어 매 렌더 재계산 — 초기값 고정 금지.)
  const isAdmin = useAdminFlag();
  const [chosenMode, setChosenMode] = useState<ControlMode | null>(null);
  const modeInput = {
    isAdmin,
    search: typeof window === "undefined" ? "" : window.location.search,
    stored: readStoredControlMode(),
  };
  const controlMode = chosenMode ?? resolveControlMode(modeInput);
  const canSwitch = canSwitchControlMode(modeInput);

  // `?viewerControls=reset` — 저장된 QA 오버라이드 고착 해제(일반 유저 브라우저에 디버그 UI 가
  // 영구히 남지 않게). 판정은 위에서 이미 저장값을 무시했고, 여기서 실제 저장도 지운다.
  useEffect(() => {
    if (!isControlModeReset(modeInput.search)) return;
    try {
      window.localStorage?.removeItem(CONTROL_MODE_STORAGE_KEY);
    } catch {
      // 저장소 접근 불가면 이번 세션 판정만 적용된다(이미 무시 처리됨).
    }
  }, [modeInput.search]);

  const chooseMode = (m: ControlMode) => {
    setChosenMode(m);
    try {
      window.localStorage?.setItem(CONTROL_MODE_STORAGE_KEY, m);
    } catch {
      // 저장 실패(프라이빗 모드 등)는 무시 — 이번 화면 선택은 그대로 적용된다.
    }
  };

  if (isLoading) {
    return <p className={styles.note}>경기 기록 불러오는 중…</p>;
  }
  if (isError || !log) {
    return <p className={styles.note}>경기 기록을 불러오지 못했습니다</p>;
  }

  return (
    <div className={styles.stageRoot} data-testid={`match-viewer-half${half}`}>
      {mode === "visual" ? (
        <VisualPlayback
          log={log}
          half={half}
          onFallback={() => setMode("timeline")}
          controlMode={controlMode}
          canSwitch={canSwitch}
          onControlMode={chooseMode}
          onTick={onTick}
        />
      ) : (
        <div className={styles.timelineFill}>
          <TimelineView log={log} half={half} homeName={homeName} awayName={awayName} />
        </div>
      )}
    </div>
  );
}

/** QA 오버라이드 저장값(없거나 읽기 실패면 null — 계정 기준으로 판정). */
function readStoredControlMode(): string | null {
  try {
    return window.localStorage?.getItem(CONTROL_MODE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

interface VisualPlaybackProps {
  log: unknown;
  half: 1 | 2;
  onFallback: () => void;
  controlMode: ControlMode;
  canSwitch: boolean;
  onControlMode: (m: ControlMode) => void;
  onTick?: (tick: number) => void;
}

/**
 * QA 뷰어 iframe 임베드 + 브리지 주입. 순수 시퀀스 로직은 viewer-bridge.ts(검증됨).
 * viewerReady(iframe→) 와 log(useHalfLog) 는 어느 쪽이 먼저든, 둘 다 준비되면 1회 주입.
 */
function VisualPlayback({
  log,
  half,
  onFallback,
  controlMode,
  canSwitch,
  onControlMode,
  onTick,
}: VisualPlaybackProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 경기장 캐릭터 스킨(#145). 에셋이 아직/영영 없으면 null → 뷰어는 현행 단색 원(무회귀).
  const charAssets = useCharAssets();
  const skins = useMemo(() => buildViewerSkins(charAssets, log), [charAssets, log]);
  const [state, dispatch] = useReducer(bridgeReducer, initialBridgeState);
  const [failed, setFailed] = useState(false);
  // 뷰어가 미러링해주는 실제 하이라이트 연출 상태(#148) — 토글 표시의 SoT.
  // 뷰어 기본은 Highlights on 이고, 경기는 로드 직후 자동 진행한다(재생 컨트롤 없음).
  const [highlight, setHighlight] = useState(true);

  // 로드 실패 통합 처리: in-place 폴백 표시 + 부모 모드를 타임라인으로 전환.
  const fail = () => {
    setFailed(true);
    onFallback();
  };

  // 메시지 리스너는 마운트 시 1회만 붙는다(재구독 X) → 최신 콜백은 ref 로 본다(stale closure 방지).
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);

  // half 전환/재마운트 시 시퀀스 초기화 + 로그 준비 반영.
  useEffect(() => {
    dispatch({ kind: "reset" });
  }, [half]);
  useEffect(() => {
    if (log) dispatch({ kind: "logLoaded" });
  }, [log]);

  // iframe 이 보내는 viewerReady / viewerState 수신(우리 iframe 것만).
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (iframeRef.current && ev.source !== iframeRef.current.contentWindow) return;
      if (isViewerReadyMessage(ev.data)) dispatch({ kind: "viewerReady" });
      else if (isViewerStateMessage(ev.data)) {
        setHighlight(ev.data.auto);
        // 플레이헤드 미러링(#169 S1). 구버전 아티팩트는 tick 을 안 보낸다 → 그대로 무시.
        if (typeof ev.data.tick === "number") onTickRef.current?.(ev.data.tick);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // viewerReady 타임아웃 폴백(onError 로 못 잡는 SPA-fallback 200 케이스 방어, viewer-bridge 참조).
  // readyRef 로 타임아웃 콜백 안에서 최신 viewerReady 를 본다(클로저 stale 방지).
  const readyRef = useRef(false);
  useEffect(() => {
    readyRef.current = state.viewerReady;
  }, [state.viewerReady]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (shouldFallbackAfterTimeout(readyRef.current)) fail();
    }, VIEWER_READY_TIMEOUT_MS);
    return () => window.clearTimeout(t);
    // half 별 재마운트마다 타이머 재시작.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [half]);

  // 준비 완료 시 1회 주입. 스킨은 같은 메시지에 실어 보낸다(뷰어가 로그 로드 전에 아틀라스 예열).
  useEffect(() => {
    if (shouldPostLog(state) && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(loadMatchLogMessage(log, skins ?? undefined), "*");
      dispatch({ kind: "posted" });
    }
  }, [state, log, skins]);

  // 컨트롤 크롬 지시(#148): 뷰어 준비 후 + 모드가 바뀔 때마다 재전송.
  // 브리지 기본값이 play 라 관객은 디버그 크롬을 볼 일이 없고, admin/QA 만 full 로 되살린다.
  useEffect(() => {
    if (!state.viewerReady) return;
    iframeRef.current?.contentWindow?.postMessage(setChromeMessage(controlMode), "*");
  }, [state.viewerReady, controlMode]);

  const sendHighlight = (on: boolean) => {
    iframeRef.current?.contentWindow?.postMessage(highlightMessage(on), "*");
  };

  if (failed) {
    // iframe 로드 실패 → 텍스트 타임라인으로 폴백 유도.
    return (
      <div className={styles.note} data-testid={`viewer-visual-error-half${half}`}>
        시각 재생을 불러오지 못했습니다.{" "}
        <button type="button" className={styles.control} onClick={onFallback}>
          타임라인으로 보기
        </button>
      </div>
    );
  }

  return (
    <div className={styles.stageWrapFill} data-testid={`viewer-visual-half${half}`}>
      <iframe
        ref={iframeRef}
        // key: half 별로 새 iframe → 새 viewerReady → 해당 half 재주입.
        key={`viewer-half${half}`}
        className={styles.stageFill}
        src={VIEWER_EMBED_SRC}
        title={`${half === 1 ? "전반" : "후반"} 경기 재생`}
        // 1st-party 생성물(build:viewer). 스크립트 실행 허용 + same-origin(vite public 서빙)로
        // postMessage 통신. 외부 리소스/네트워크 없음(fetch 는 브리지가 가로챔).
        sandbox="allow-scripts allow-same-origin"
        loading="lazy"
        onError={fail}
        data-posted={state.posted ? "1" : "0"}
      />
      {/* 무대 모드에선 컨트롤을 화면 모서리에 겹친다(리서치 R6 — 뷰 컨트롤은 무대 가장자리). */}
      <div className={styles.controlsOverlay}>
        <PlaybackControls
          half={half}
          mode={controlMode}
          canSwitch={canSwitch}
          highlight={highlight}
          onHighlight={sendHighlight}
          onMode={onControlMode}
        />
      </div>
    </div>
  );
}

interface TimelineViewProps {
  log: NonNullable<ReturnType<typeof useHalfLog>["data"]>;
  half: 1 | 2;
  homeName: string;
  awayName: string;
}

/**
 * 텍스트 하이라이트(R1 전 임시 뷰어의 로직 그대로). 키 이벤트를 ~30초로 압축 순차 공개.
 */
function TimelineView({ log, half, homeName, awayName }: TimelineViewProps) {
  const events = useMemo(
    () => keyEvents(((log?.events ?? []) as unknown as MatchEventLike[]) ?? []),
    [log],
  );
  const [revealed, setRevealed] = useState(0);
  const [playing, setPlaying] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);

  const done = revealed >= events.length;

  useEffect(() => {
    if (!playing || done || events.length === 0) return;
    const timer = window.setInterval(
      () => setRevealed((n) => Math.min(events.length, n + 1)),
      revealInterval(events.length),
    );
    return () => window.clearInterval(timer);
  }, [playing, done, events.length]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [revealed]);

  const score = done
    ? ((log.finalScore ?? runningScore(events, revealed)) as { home?: number; away?: number })
    : runningScore(events, revealed);

  return (
    <>
      <div className={styles.scoreboard}>
        <span className={styles.team}>{homeName}</span>
        <span className={styles.score} data-testid={`viewer-score-half${half}`}>
          {score.home ?? 0} : {score.away ?? 0}
        </span>
        <span className={styles.team}>{awayName}</span>
      </div>
      <p className={styles.halfLabel}>{half === 1 ? "전반" : "후반"} 텍스트 하이라이트</p>

      <ol className={styles.timeline} ref={listRef} data-testid={`viewer-timeline-half${half}`}>
        {events.slice(0, revealed).map((e, i) => {
          const d = eventDisplay(e);
          return (
            <li key={`${e.tick}-${i}`} className={e.type === "goal" ? styles.goalRow : styles.row}>
              <span className={styles.clock}>{formatClock(e.tick, half)}</span>
              <span className={styles.icon} aria-hidden="true">
                {d.icon}
              </span>
              <span className={styles.label}>
                {d.label}
                {e.team && <span className={styles.side}>{e.team === "home" ? homeName : awayName}</span>}
              </span>
            </li>
          );
        })}
        {revealed === 0 && <li className={styles.note}>재생 대기 중…</li>}
      </ol>

      <div className={styles.controls}>
        {!done ? (
          <>
            <button
              type="button"
              className={styles.control}
              data-testid={`viewer-playpause-half${half}`}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? "일시정지" : "재생"}
            </button>
            <button
              type="button"
              className={styles.control}
              data-testid={`viewer-skip-half${half}`}
              onClick={() => {
                setRevealed(events.length);
                setPlaying(false);
              }}
            >
              끝까지 보기
            </button>
          </>
        ) : (
          <span className={styles.doneNote} data-testid={`viewer-done-half${half}`}>
            {half === 1 ? "전반 종료" : "경기 종료"} — 이벤트 {events.length}건
          </span>
        )}
      </div>
    </>
  );
}
