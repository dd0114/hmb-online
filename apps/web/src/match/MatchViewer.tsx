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
  loadMatchLogMessage,
  shouldPostLog,
  VIEWER_EMBED_SRC,
} from "./viewer-bridge";
import styles from "./MatchViewer.module.css";

interface MatchViewerProps {
  matchId: string;
  half: 1 | 2;
  homeName: string;
  awayName: string;
}

type ViewMode = "visual" | "timeline";

/**
 * 경기 재생 뷰어 (LLD-web §3, AC-W5). 두 모드:
 *  - [시각 재생](기본): QA dev-viewer 번들(viewer-embed.html)을 iframe 임베드 →
 *    viewerReady 수신 후 해당 half MatchLog 를 postMessage 로 주입해 피치/선수/공 재생.
 *    (QA 뷰어 소비만 — 캔버스 렌더러 자체 구현 금지, #57.)
 *  - [타임라인]: MatchLog 키 이벤트를 ~30초로 압축해 순차 공개하는 텍스트 하이라이트(폴백).
 * 로딩/에러 시 자동으로 타임라인 폴백.
 */
export function MatchViewer({ matchId, half, homeName, awayName }: MatchViewerProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half);
  const [mode, setMode] = useState<ViewMode>("visual");

  if (isLoading) {
    return <p className={styles.note}>경기 기록 불러오는 중…</p>;
  }
  if (isError || !log) {
    return <p className={styles.note}>경기 기록을 불러오지 못했습니다</p>;
  }

  return (
    <section className={styles.viewer} data-testid={`match-viewer-half${half}`}>
      <div className={styles.modeTabs} role="tablist" aria-label="재생 모드">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "visual"}
          className={[styles.tab, mode === "visual" ? styles.tabActive : ""].join(" ")}
          data-testid={`viewer-tab-visual-half${half}`}
          onClick={() => setMode("visual")}
        >
          🎬 시각 재생
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "timeline"}
          className={[styles.tab, mode === "timeline" ? styles.tabActive : ""].join(" ")}
          data-testid={`viewer-tab-timeline-half${half}`}
          onClick={() => setMode("timeline")}
        >
          📝 타임라인
        </button>
      </div>

      {mode === "visual" ? (
        <VisualPlayback log={log} half={half} onFallback={() => setMode("timeline")} />
      ) : (
        <TimelineView log={log} half={half} homeName={homeName} awayName={awayName} />
      )}
    </section>
  );
}

interface VisualPlaybackProps {
  log: unknown;
  half: 1 | 2;
  onFallback: () => void;
}

/**
 * QA 뷰어 iframe 임베드 + 브리지 주입. 순수 시퀀스 로직은 viewer-bridge.ts(검증됨).
 * viewerReady(iframe→) 와 log(useHalfLog) 는 어느 쪽이 먼저든, 둘 다 준비되면 1회 주입.
 */
function VisualPlayback({ log, half, onFallback }: VisualPlaybackProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [state, dispatch] = useReducer(bridgeReducer, initialBridgeState);
  const [failed, setFailed] = useState(false);

  // half 전환/재마운트 시 시퀀스 초기화 + 로그 준비 반영.
  useEffect(() => {
    dispatch({ kind: "reset" });
  }, [half]);
  useEffect(() => {
    if (log) dispatch({ kind: "logLoaded" });
  }, [log]);

  // iframe 이 보내는 viewerReady 수신(우리 iframe 것만).
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (iframeRef.current && ev.source !== iframeRef.current.contentWindow) return;
      if (isViewerReadyMessage(ev.data)) dispatch({ kind: "viewerReady" });
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // 준비 완료 시 1회 주입.
  useEffect(() => {
    if (shouldPostLog(state) && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(loadMatchLogMessage(log), "*");
      dispatch({ kind: "posted" });
    }
  }, [state, log]);

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
    <div className={styles.stageWrap} data-testid={`viewer-visual-half${half}`}>
      <iframe
        ref={iframeRef}
        // key: half 별로 새 iframe → 새 viewerReady → 해당 half 재주입.
        key={`viewer-half${half}`}
        className={styles.stage}
        src={VIEWER_EMBED_SRC}
        title={`${half === 1 ? "전반" : "후반"} 경기 재생`}
        // 1st-party 생성물(build:viewer). 스크립트 실행 허용 + same-origin(vite public 서빙)로
        // postMessage 통신. 외부 리소스/네트워크 없음(fetch 는 브리지가 가로챔).
        sandbox="allow-scripts allow-same-origin"
        loading="lazy"
        onError={() => setFailed(true)}
        data-posted={state.posted ? "1" : "0"}
      />
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
