import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MatchClock } from "@hmb/shared";
import { useHalfLog, usePlayers } from "../api/hooks";
import {
  eventDisplay,
  fallbackScore,
  formatClock,
  keyEvents,
  revealInterval,
  visibleTimelineEvents,
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
import { VisualPlayback, type ArenaPlayerInfo } from "./VisualPlayback";
import type { SelectedPlayer } from "./player-selection";
import { playerNameOf } from "../common/player-names";
import { liveGate } from "./live-clock";
import { tickOfIndex } from "./live-pace";
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
  /**
   * **리뷰 컨트롤 강제**(#244) — 감독시간의 `경기장면` 탭처럼 "지나간 하프를 돌려보는" 자리.
   * 시간바(스크럽)·키장면 핀·초/프레임 스텝을 **일반 유저에게도** 연다. 평소 관전(라이브)에서는
   * 이 값을 켜지 않는다 — 라이브는 "지금까지"만 볼 수 있어야 하고(서버 권위 시계), 풀컨트롤은
   * QA/admin 전용이다(`resolveControlMode`).
   *
   * ⚠️ **"관전·종료 화면에는 시크바가 없다"는 더 이상 사실이 아니다**(#406 W3, 요구 5-3).
   * 예전에 이 자리에 *"종료 후 결과 화면·기록 다시보기에도 같은 도구가 필요하다 — 별도 이슈"* 라고
   * 적혀 있던 그 이슈다. 지금은 **플레이 모드에 과거 전용 시크바**(`PlaybackControls.SeekBar`)가
   * 상시로 있고, 라이브에서는 서버 시계가 미래를 잠그고 **종료(clock === null)에서는 그 잠금이
   * 저절로 풀려** 전 구간이 열린다 = 결과 화면의 "전체 이동"이 같은 부품 하나로 성립한다.
   * `reviewControls` 는 그것과 **다른 축**으로 남는다 — 장면 리스트·초/프레임 스텝·mm:ss 같은
   * 돌려보기 전용 도구 묶음(감독시간 `경기장면` 탭)이라, 종료 화면에 켜면 결과 패널의 세로 예산
   * (#355)을 그대로 먹는다. 그래서 켜지 않는다.
   */
  reviewControls?: boolean;
  /**
   * 경기 스킵 버튼(#421) — 무대 컨트롤 층까지 그대로 관통시킨다. 이 화면은 매치 상태를 모르므로
   * 부품을 **셸이 만들어 넘긴다**(`StageShell`). 돌려보는 자리(`reviewControls`)에는 넘기지 않는다.
   */
  skipSlot?: ReactNode;
  /**
   * 내 팀이 선 사이드(#322) — 선수 하이라이트의 **내 선수 / 상대 선수** 구분에 쓴다(#406 W4).
   * 모르면 null: 카드가 뱃지를 아예 안 달고 링은 중립(상대) 스타일로 떨어진다. 거짓 표식 금지.
   */
  myTeamSide?: "home" | "away" | null;
  /**
   * **controlled 선수 선택**(#406 W9, 요구 5-2 후반) — 그대로 `VisualPlayback` 에 관통시킨다.
   * 주면 이 무대는 선택 상태를 소유하지 않고 부모(`StageShell`)를 따른다. 그래야 **지시 대상 칩**과
   * **피치 탭**이 같은 배열에 쓰고, 규칙(`player-selection.ts` 머리말의 동시 선택 표)이 한 곳에 산다.
   * 안 주면 종전대로 무대가 자기 상태를 갖는다(QA 콘솔처럼 셸이 없는 자리).
   */
  selection?: SelectedPlayer[];
  onSelectionChange?: (next: SelectedPlayer[]) => void;
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
  reviewControls = false,
  skipSlot,
  myTeamSide = null,
  selection,
  onSelectionChange,
}: MatchViewerProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half, logEnabled);
  /*
   * 아이콘 노출 정책(#285)은 **등급**으로 판정한다 → 카탈로그에서 playerId→등급 표를 만들어
   * 캔버스 부품에 넘긴다. `/api/players` 는 보유분이 아니라 **전 카탈로그**라 상대(봇) 선수
   * 등급도 여기서 나온다(봇 로스터가 같은 선수 카탈로그를 공유한다 — 루트 CLAUDE #231).
   * 조회 전/실패면 null → `buildViewerSkins` 의 공용 디폴트 백스톱이 받는다.
   */
  const { data: catalog } = usePlayers();
  const grades = useMemo(
    /*
     * ⚠️ **응답 형태를 믿지 않는다**(apps/web CLAUDE.md). 이 엔드포인트가 없는 구 서버나 목이
     * 200 `{}` 를 주면 `.map` 이 던져 **결과 화면이 통째로 흰 화면**이 된다(실제로 growth-mock 의
     * 성장 리포트 스펙이 이걸 잡았다). 아이콘 노출 정책은 부가 기능이다 — 화면을 죽이면 안 되고,
     * 형태가 이상하면 null 로 떨어져 공용 디폴트 백스톱이 정책을 지킨다.
     */
    () => (Array.isArray(catalog) ? Object.fromEntries(catalog.map((p) => [p.id, p.grade])) : null),
    [catalog],
  );
  /*
   * 선수 하이라이트(#406 W4)용 표시 정보 — 같은 카탈로그에서 뽑아 캔버스 부품에 **주입한다**
   * (`grades` 와 같은 이유: 그 부품은 API 를 모른다). 이름은 반드시 `playerNameOf` 초크포인트를
   * 거친다 — `p.name` 을 직접 읽으면 한글화 규칙이 이 화면만 옛것으로 남는다(#406 요구 6).
   * 형태를 믿지 않는 가드도 위와 같다(구 서버·목의 `{}` → null → 카드가 폴백 문구를 쓴다).
   */
  const playerInfo = useMemo<Record<string, ArenaPlayerInfo> | null>(() => {
    if (!Array.isArray(catalog)) return null;
    const out: Record<string, ArenaPlayerInfo> = {};
    for (const p of catalog) {
      if (!p?.id) continue;
      out[p.id] = {
        full: playerNameOf(p, "full"),
        short: playerNameOf(p, "short"),
        position: p.position ?? null,
      };
    }
    return out;
  }, [catalog]);
  const [mode, setMode] = useState<ViewMode>("visual");
  /*
   * 폴백 타임라인의 라이브 상한(#238) — 시각 재생과 **같은 출처**(`liveGate`)를 쓴다.
   * 초당 한 번 "지금"을 갱신해 상한이 실제로 흐르게 한다(안 하면 폴백이 마운트 시점에 얼어붙는다).
   * 시계가 없으면(지나간 하프·종료·구서버) 타이머를 돌리지 않는다 — 제한도 없다.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!clock) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [clock]);
  const snapTicks = useMemo(() => {
    const snaps = (log as { tickSnapshots?: { tick: number }[] } | null | undefined)?.tickSnapshots;
    return Array.isArray(snaps) ? snaps.map((s) => s.tick) : [];
  }, [log]);
  const gate = liveGate(clock, half, snapTicks.length, nowMs, clockOffsetMs);
  /*
   * 서버 시계는 **인덱스**로 말하고 이벤트는 **절대 틱**을 갖는다 — 섞으면 후반(틱 2700~)에서
   * 상한 비교가 늘 참이 된다(VisualPlayback 이 같은 함정을 주석으로 남겨 뒀다).
   * 스냅샷을 못 읽는 손상 로그면 "지금"을 틱으로 환산할 방법이 없다 → null(= 상한 미상).
   */
  const capTick =
    gate.isLive && snapTicks.length > 0 ? tickOfIndex(snapTicks, gate.liveTick) : null;
  // #148 컨트롤 모드: 계정/QA 플래그로 판정하되, admin/QA 가 토글하면 그 선택이 이긴다.
  const isAdmin = useAdminFlag();
  const [chosenMode, setChosenMode] = useState<ControlMode | null>(null);
  const modeInput = {
    isAdmin,
    search: typeof window === "undefined" ? "" : window.location.search,
    stored: readStoredControlMode(),
  };
  const controlMode = reviewControls ? "full" : (chosenMode ?? resolveControlMode(modeInput));
  // 리뷰 자리에서는 모드 토글을 보여주지 않는다 — 여긴 "돌려보는 화면"이 기본값이라 고를 게 없다.
  const canSwitch = reviewControls ? false : canSwitchControlMode(modeInput);

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
          review={reviewControls}
          grades={grades}
          skipSlot={skipSlot}
          playerInfo={playerInfo}
          myTeamSide={myTeamSide}
          teamNames={{ home: homeName, away: awayName }}
          selection={selection}
          onSelectionChange={onSelectionChange}
        />
      ) : (
        <div className={styles.timelineFill}>
          <TimelineView
            log={log}
            half={half}
            homeName={homeName}
            awayName={awayName}
            baseline={baseline}
            capTick={capTick}
            isLive={gate.isLive}
          />
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
  /**
   * **리뷰 컨트롤 강제**(#244) — 감독시간의 `경기장면` 탭처럼 "지나간 하프를 돌려보는" 자리.
   * 시간바(스크럽)·키장면 핀·초/프레임 스텝을 **일반 유저에게도** 연다. 평소 관전(라이브)에서는
   * 이 값을 켜지 않는다 — 라이브는 "지금까지"만 볼 수 있어야 하고(서버 권위 시계), 풀컨트롤은
   * QA/admin 전용이다(`resolveControlMode`).
   *
   * ⚠️ **"관전·종료 화면에는 시크바가 없다"는 더 이상 사실이 아니다**(#406 W3, 요구 5-3).
   * 예전에 이 자리에 *"종료 후 결과 화면·기록 다시보기에도 같은 도구가 필요하다 — 별도 이슈"* 라고
   * 적혀 있던 그 이슈다. 지금은 **플레이 모드에 과거 전용 시크바**(`PlaybackControls.SeekBar`)가
   * 상시로 있고, 라이브에서는 서버 시계가 미래를 잠그고 **종료(clock === null)에서는 그 잠금이
   * 저절로 풀려** 전 구간이 열린다 = 결과 화면의 "전체 이동"이 같은 부품 하나로 성립한다.
   * `reviewControls` 는 그것과 **다른 축**으로 남는다 — 장면 리스트·초/프레임 스텝·mm:ss 같은
   * 돌려보기 전용 도구 묶음(감독시간 `경기장면` 탭)이라, 종료 화면에 켜면 결과 패널의 세로 예산
   * (#355)을 그대로 먹는다. 그래서 켜지 않는다.
   */
  reviewControls?: boolean;
  /**
   * 라이브 하프에서 공개해도 되는 **상한 틱**(#238). `null` = 제한 없음(지나간 하프·종료·시계 없음).
   * 값은 시각 재생과 **같은 출처**(`liveGate` → `tickOfIndex`)에서 온다 — 폴백만의 두 번째 규칙을
   * 만들면 둘이 조용히 갈라진다.
   */
  capTick?: number | null;
  /** 이 하프가 라이브인가 — 문구("끝까지" vs "지금까지")와 최종 스코어 사용 여부를 가른다. */
  isLive?: boolean;
}

/**
 * 텍스트 하이라이트(폴백). 키 이벤트를 ~30초로 압축 순차 공개.
 *
 * ⚠️ **여기에도 라이브 게이트가 걸린다**(#238). 예전엔 `끝까지 보기` 가 그 하프 이벤트를 전부 열고
 * 스코어보드가 **경기 최종 스코어**를 그렸다 — 도달 경로가 좁을 뿐(캔버스 재생이 실패해야 이 화면이
 * 뜬다) "재생 위치를 넘는 점수를 보이지 않는다"(#233)를 정면으로 어겼다.
 */
function TimelineView({
  log,
  half,
  homeName,
  awayName,
  baseline = null,
  capTick = null,
  isLive = false,
}: TimelineViewProps) {
  // ⚠️ 상한 규칙은 `visibleTimelineEvents` 가 소유한다 — 여기서 slice/filter 를 다시 쓰지 마라(#238).
  const events = useMemo(
    () =>
      visibleTimelineEvents(
        keyEvents(((log?.events ?? []) as unknown as MatchEventLike[]) ?? []),
        capTick,
      ),
    [log, capTick],
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
  // 라이브 하프에서는 `finalScore`(= 그 하프의 **최종**)를 절대 쓰지 않는다 — 다 봤다고 그걸 그리면
  // 상한을 걸어 놓고 마지막 줄에서 스포일러를 내는 꼴이 된다(#238). 대신 공개분 누적으로 답한다.
  const score = fallbackScore(
    isLive ? null : (log.finalScore as { home?: number; away?: number } | null | undefined),
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
            {/*
              ⚠️ **상한을 모르는 라이브에서는 건너뛰기를 아예 주지 않는다**(#238). 손상 로그라
              스냅샷을 못 읽으면 "지금"을 틱으로 환산할 수 없어 `events` 가 안 잘린다 — 그 상태에서
              버튼을 남기면 고치기 전과 똑같이 하프 전체가 열린다. 시간 공개(자동)는 계속 돈다.
            */}
            {(!isLive || capTick != null) && (
              <button
                type="button"
                className={styles.control}
                data-testid={`viewer-skip-half${half}`}
                onClick={() => {
                  // 라이브면 "끝"이 아직 없다 — 공개 상한(`events` 가 이미 잘려 있다)까지만.
                  setRevealed(events.length);
                  setPlaying(false);
                }}
              >
                {isLive ? "지금까지 보기" : "끝까지 보기"}
              </button>
            )}
          </>
        ) : (
          <span className={styles.doneNote} data-testid={`viewer-done-half${half}`}>
            {isLive
              ? `지금까지 ${events.length}건`
              : `${half === 1 ? "전반 종료" : "경기 종료"} — 이벤트 ${events.length}건`}
          </span>
        )}
      </div>
    </>
  );
}
