import { useEffect, useMemo, useRef, useState } from "react";
import { createViewer, type ViewerChrome, type ViewerController } from "@hmb/viewer-core";
import type { MatchClock } from "@hmb/shared";
import { useHalfLog } from "../api/hooks";
import { liveGate } from "./live-clock";
import {
  eventDisplay,
  formatClock,
  keyEvents,
  revealInterval,
  runningScore,
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
  /** 서버 권위 시계(P4-E2 #170). 이 하프가 라이브면 재생이 "지금"까지로 제한된다. */
  clock?: MatchClock | null;
  /** 폴링 시점에 잡아둔 서버-클라 시각차(live-clock.captureOffsetMs). */
  clockOffsetMs?: number;
  /** 이 상태에서 로그를 요청해도 되는가(서버 허용표 미러 — 409 방지). */
  logEnabled?: boolean;
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
  clock: MatchClock | null;
  clockOffsetMs: number;
}

/**
 * viewer-core 직접 마운트(#169 S3). 캔버스에 createViewer 로 코어를 붙이고, 골/상황/배너 자막은
 * 캔버스 위 오버레이(호스트 DOM)로 그린다. 컨트롤(플레이=하이라이트 토글 / admin=풀컨트롤)은
 * 코어 컨트롤러를 직접 조작한다. 손상 로그는 load 가 throw → 텍스트 타임라인으로 폴백.
 */
function VisualPlayback({
  log,
  half,
  onFallback,
  controlMode,
  canSwitch,
  onControlMode,
  onTick,
  clock,
  clockOffsetMs,
}: VisualPlaybackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const situationRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerController | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  // 경기장 캐릭터 스킨(#145). 에셋이 아직/영영 없으면 null → 코어는 현행 단색 원(무회귀).
  const charAssets = useCharAssets();
  const skins = useMemo(() => buildViewerSkins(charAssets, log), [charAssets, log]);
  const [failed, setFailed] = useState(false);
  // 하이라이트 연출(autoPace) 표시 상태 — 코어 기본 on.
  const [highlight, setHighlight] = useState(true);

  // 콜백은 마운트 시 고정하되 최신 onTick 은 ref 로 본다(stale closure 방지).
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);

  // 스킨은 아틀라스 매핑 로드가 늦을 수 있어, 마운트 후 준비되면 반영한다.
  useEffect(() => {
    if (skins && viewerRef.current) viewerRef.current.setSkin(skins);
  }, [skins]);

  // 코어 마운트 — half/로그가 바뀌면 재마운트(캔버스 key 로 새 캔버스).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !log) return;

    const SHOW = styles.capShow as string;
    const showAnim = (el: HTMLElement | null, text: string, col: string) => {
      if (!el) return;
      el.textContent = text;
      el.style.color = col;
      el.classList.remove(SHOW);
      void el.offsetWidth; // reflow → 애니메이션 재발화
      el.classList.add(SHOW);
    };
    const chrome: ViewerChrome = {
      onTick: (t) => onTickRef.current?.(t),
      onBigCaption: (text, col) => showAnim(flashRef.current, text, col),
      onSituation: (text, col) => showAnim(situationRef.current, text, col),
      onBanner: (text, col) => {
        const el = bannerRef.current;
        if (!el) return;
        if (text != null) {
          el.textContent = text;
          el.style.color = col ?? "";
          el.classList.add(SHOW);
        } else {
          el.classList.remove(SHOW);
        }
      },
      onClearCaptions: () => {
        for (const el of [flashRef.current, situationRef.current, bannerRef.current]) el?.classList.remove(SHOW);
      },
    };

    let v: ViewerController;
    try {
      v = createViewer(canvas, chrome);
      if (skins) v.setSkin(skins);
      v.setSpeed(4); // 기본 배속(hero 지시) — 하이라이트 off 시 이 속도로 진행.
      v.load(log); // 손상 로그면 throw
      v.start();
    } catch {
      // 로드 실패 → 같은 자리에 실패 안내 표시(빈 피치 방지). 텍스트 타임라인 전환은 유저 버튼으로
      // (자동 전환하면 손상 로그의 빈 타임라인만 남아 "왜 안 나오지"가 된다).
      setFailed(true);
      return;
    }
    viewerRef.current = v;
    setViewerReady(true);
    setHighlight(true);
    // QA/e2e 훅 — dev-viewer 가 제공하던 window.__viewer 와 동형(읽기 표면 + 스킨/뷰모드).
    (window as unknown as { __viewer?: unknown }).__viewer = v.hooks;

    return () => {
      v.stop();
      viewerRef.current = null;
      setViewerReady(false);
      const w = window as unknown as { __viewer?: unknown };
      if (w.__viewer === v.hooks) delete w.__viewer;
    };
    // 스킨은 위 별도 effect 로 반영(마운트 재실행 트리거에서 제외).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, half]);

  // ── 라이브 게이트(P4-E2 #170 / AC-W3-1) ───────────────────────────────
  // 늦게 접속하면 **경과 시점부터** 재생하고, 그 뒤로는 "지금"을 앞질러 가지 못한다(되감기는 자유).
  // viewer-core 는 자체 프레임 루프를 도므로 코어를 고치지 않고 호스트가 주기적으로 플레이헤드를
  // 확인해 상한 밖이면 되돌린다(코어는 QA 뷰어와 공유하는 SoT — 여기서 건드리지 않는다).
  const gateInput = useRef({ clock, clockOffsetMs, half });
  gateInput.current = { clock, clockOffsetMs, half };
  const tickCount = useMemo(() => {
    const snaps = (log as { tickSnapshots?: unknown[] } | null)?.tickSnapshots;
    return Array.isArray(snaps) ? snaps.length : 0;
  }, [log]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!viewerReady || !v || tickCount <= 0) return;
    const gateNow = () => {
      const { clock: c, clockOffsetMs: off, half: h } = gateInput.current;
      return liveGate(c, h, tickCount, Date.now(), off);
    };

    const entry = gateNow();
    if (!entry.isLive) return; // 지나간 하프·종료·레거시 = 제한 없음(기존 동작 그대로)

    // 라이브에서는 하이라이트 연출(autoPace)을 끈다 — 줌·슬로우가 실시간을 따라가지 못한다.
    setHighlight(false);
    v.setAutoPace(false);
    if (entry.speed) v.setSpeed(entry.speed);
    v.jumpToTick(entry.liveTick); // seek-to-now
    v.play();

    const timer = window.setInterval(() => {
      const gate = gateNow();
      if (!gate.isLive) return;
      const cur = Number(v.hooks.cur()?.tick ?? 0);
      if (cur > gate.clamp(cur)) {
        v.jumpToTick(gate.liveTick); // 앞질러 갔으면(스크럽·배속) 지금으로 되돌린다
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [viewerReady, tickCount, clock?.phase, clock?.phaseStartAt]);

  const onHighlight = (on: boolean) => {
    setHighlight(on);
    viewerRef.current?.setAutoPace(on);
  };

  if (failed) {
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
      <canvas
        ref={canvasRef}
        key={`viewer-canvas-half${half}`}
        width={1050}
        height={680}
        className={styles.stageCanvas}
        data-testid={`viewer-canvas-half${half}`}
      />
      {/* 자막 오버레이(호스트 DOM) — 코어가 chrome 콜백으로 표시/숨김 토글. aria-live 로 골만 읽어줌. */}
      <div ref={flashRef} className={styles.capFlash} aria-live="polite" />
      <div ref={situationRef} className={styles.capSituation} aria-hidden="true" />
      <div ref={bannerRef} className={styles.capBanner} aria-hidden="true" />
      {/* 무대 모드에선 컨트롤을 화면 모서리에 겹친다(리서치 R6 — 뷰 컨트롤은 무대 가장자리). */}
      <div className={styles.controlsOverlay}>
        <PlaybackControls
          half={half}
          mode={controlMode}
          canSwitch={canSwitch}
          highlight={highlight}
          onHighlight={onHighlight}
          onMode={onControlMode}
          viewer={viewerReady ? viewerRef.current : null}
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
 * 텍스트 하이라이트(폴백). 키 이벤트를 ~30초로 압축 순차 공개.
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
