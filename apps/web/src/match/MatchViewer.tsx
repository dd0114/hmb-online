import { useEffect, useMemo, useRef, useState } from "react";
import type { MatchClock } from "@hmb/shared";
import { useHalfLog } from "../api/hooks";
import {
  eventDisplay,
  fallbackScore,
  formatClock,
  keyEvents,
  revealInterval,
  type MatchEventLike,
} from "./match-logic";
import { useAdminFlag } from "../admin/admin-flag";
import {
  canSwitchControlMode,
  CONTROL_MODE_STORAGE_KEY,
  isControlModeReset,
  resolveControlMode,
  type ControlMode,
} from "./playback-controls";
// 관전 캔버스는 별 파일로 분리했다(#191) — QA 콘솔과 **같은 부품**을 쓴다.
import { VisualPlayback } from "./VisualPlayback";
import styles from "./MatchViewer.module.css";

interface MatchViewerProps {
  matchId: string;
  half: 1 | 2;
  homeName: string;
  awayName: string;
  /** 재생 플레이헤드 미러링 — 호스트(스코어바·통계·로그)가 "지금까지"를 계산하는 기준. */
  onTick?: (tick: number) => void;
  /** 서버 권위 시계(P4-E2 #170). 이 하프가 라이브면 재생이 "지금"까지로 제한된다. */
  clock?: MatchClock | null;
  /** 폴링 시점에 잡아둔 서버-클라 시각차(live-clock.captureOffsetMs). */
  clockOffsetMs?: number;
  /** 이 상태에서 로그를 요청해도 되는가(서버 허용표 미러 — 409 방지). */
  logEnabled?: boolean;
  /**
   * 이 하프 앞에 이미 확정된 스코어(후반이면 전반) — 텍스트 폴백 스코어보드가 **경기 누적**을
   * 말하게 한다(#233). 값은 `playedBaseline` 이 정한다. 캔버스 재생은 이 값을 쓰지 않는다.
   */
  baseline?: { home: number; away: number } | null;
}

type ViewMode = "visual" | "timeline";

/**
 * 경기 재생 무대 (LLD-web §3, AC-W5 / #169 S3).
 * **viewer-core 를 직접 마운트**한다(iframe·브리지 제거, S3): React 가 캔버스를 소유하고
 * `createViewer(canvas, chrome)` 로 QA 뷰어와 **같은 렌더 코어**를 돌린다 → QA 화면 = 게임 화면.
 * 시각 재생이 실패했을 때만 같은 자리에서 텍스트 타임라인으로 폴백한다.
 */
export function MatchViewer({
  matchId,
  half,
  homeName,
  awayName,
  onTick,
  clock = null,
  clockOffsetMs = 0,
  logEnabled = true,
  baseline = null,
}: MatchViewerProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half, logEnabled);
  const [mode, setMode] = useState<ViewMode>("visual");
  // #148 컨트롤 모드: 계정/QA 플래그로 판정하되, admin/QA 가 토글하면 그 선택이 이긴다.
  const isAdmin = useAdminFlag();
  const [chosenMode, setChosenMode] = useState<ControlMode | null>(null);
  const modeInput = {
    isAdmin,
    search: typeof window === "undefined" ? "" : window.location.search,
    stored: readStoredControlMode(),
  };
  const controlMode = chosenMode ?? resolveControlMode(modeInput);
  const canSwitch = canSwitchControlMode(modeInput);

  // `?viewerControls=reset` — 저장된 QA 오버라이드 고착 해제.
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
          clock={clock}
          clockOffsetMs={clockOffsetMs}
        />
      ) : (
        <div className={styles.timelineFill}>
          <TimelineView log={log} half={half} homeName={homeName} awayName={awayName} baseline={baseline} />
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

interface TimelineViewProps {
  log: NonNullable<ReturnType<typeof useHalfLog>["data"]>;
  half: 1 | 2;
  homeName: string;
  awayName: string;
  /** 앞에 끝난 하프의 확정 스코어 — 폴백 스코어보드도 경기 누적을 말한다(#233). */
  baseline?: { home: number; away: number } | null;
}

/**
 * 텍스트 하이라이트(폴백). 키 이벤트를 ~30초로 압축 순차 공개.
 */
function TimelineView({ log, half, homeName, awayName, baseline = null }: TimelineViewProps) {
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

  // 규칙은 `fallbackScore` 가 소유한다 — 여기서 다시 계산하지 마라(#233 독립검증 minor-1: 인라인이던
  // 시절의 변이체가 전 게이트를 통과했다).
  const score = fallbackScore(
    log.finalScore as { home?: number; away?: number } | null | undefined,
    events,
    revealed,
    done,
    baseline,
  );

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
