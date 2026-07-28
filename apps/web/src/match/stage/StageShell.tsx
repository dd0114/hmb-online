import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { scoreAt, type LogEvent } from "@hmb/viewer-core";
import { useHalfLog, type MatchDetail } from "../../api/hooks";
import { captureOffsetMs, logAvailableFor } from "../live-clock";
import { MatchViewer } from "../MatchViewer";
import { HalftimePanel } from "../HalftimePanel";
import { ScoreBar } from "./ScoreBar";
import { StatsPanel } from "./StatsPanel";
import { LogPanel } from "./LogPanel";
import { SecondHalfBriefPanel } from "./SecondHalfBriefPanel";
import { ResultPanel } from "./ResultPanel";
import {
  DEFAULT_TOGGLES,
  halfEndTickOf,
  halfForState,
  headerTick,
  parseToggles,
  playedBaseline,
  resolveActiveTab,
  serializeToggles,
  sheetHeight,
  statePanelFor,
  tabsFor,
  TAB_LABELS,
  TOGGLE_KEYS,
  TOGGLE_STORAGE_KEY,
  type TabKey,
  type ToggleKey,
  type Toggles,
} from "./stage-state";
import styles from "./StageShell.module.css";

interface StageShellProps {
  match: MatchDetail;
  homeName: string;
  awayName: string;
  /** 리그 라운드(MatchDetail 에 없어 navigation state 로만 온다) — 스코어바 뱃지용. */
  leagueRound?: number | null;
}

function readToggles(): Toggles {
  try {
    return parseToggles(window.localStorage?.getItem(TOGGLE_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_TOGGLES };
  }
}

/**
 * 관전 셸 — **경기장면 고정 메인 + 정보 토글** (P4-D4 / AC-W1-1, #169 S1).
 * 설계 SoT = docs/plan-v5/layout-game-screen.md §2·§3, 리서치 근거 = research-spectator-ux.md R1~R6.
 *
 * 구조: [A] 스코어바 / [B] 무대(경기장면, 절대 사라지지 않음) / [D] 정보 시트 / [C] 토글바.
 * 문서는 스크롤하지 않는다 — 스크롤은 패널 안에만 있다(R1).
 *
 * 패널은 두 종류다(stage-state.ts):
 *  · 토글 패널(통계/로그/후반지시) = 유저 소유, 기본 off, localStorage 기억.
 *  · 상태 패널(하프타임 감독/종료 결과) = 매치 상태 소유, 지금 해야 할 일이라 자동 표시.
 */
export function StageShell({ match, homeName, awayName, leagueRound = null }: StageShellProps) {
  const navigate = useNavigate();
  const [toggles, setToggles] = useState<Toggles>(readToggles);
  const [preferredTab, setPreferredTab] = useState<TabKey | null>(null);
  // 재생 플레이헤드(뷰어가 미러링). 통계·로그·시계가 "지금까지"를 계산하는 기준.
  const [tick, setTick] = useState<number | null>(null);

  const half = halfForState(match.state);
  const statePanel = statePanelFor(match.state);
  const tabs = tabsFor(toggles, statePanel);
  const activeTab = resolveActiveTab(tabs, preferredTab);
  const sheetKind = sheetHeight(activeTab);

  const logEnabled = logAvailableFor(match.state, half);
  const { data: log } = useHalfLog(match.id, half, logEnabled);

  // 서버 시계(P4-E2 #170). 오프셋은 **응답이 도착한 그 순간에 한 번** 잰다 — 프레임마다 다시 재면
  // serverNow 에 고정돼 시계가 멈춘다(live-clock.captureOffsetMs 주석).
  const clock = match.clock ?? null;
  const [offsetMs, setOffsetMs] = useState(0);
  useEffect(() => {
    if (clock) setOffsetMs(captureOffsetMs(clock, Date.now()));
  }, [clock?.serverNow]);
  // **하프 로컬 델타**만 계산한다 — 앞에 끝난 하프를 얹는 건 `headerScore`/`playedBaseline` 소관(#233).
  const liveScore = useMemo(() => {
    if (!log || tick == null) return null;
    return scoreAt(((log.events ?? []) as unknown as LogEvent[]) ?? [], tick);
  }, [log, tick]);

  // 이 하프 앞에 이미 확정된 스코어(후반이면 전반). 로그 라인·폴백 스코어보드가 경기 누적을
  // 말하려면 이게 필요하다 — 헤더만 고치면 헤더 `1:6` 옆 로그가 `0-2` 로 남아 또 어긋난다.
  const baseline = playedBaseline(match.state, match);

  // 이 하프가 끝난 지점(절대 틱). 감독시간 헤더 시계가 여기에 고정된다(#226).
  const halfEndTick = useMemo(() => halfEndTickOf(log), [log]);

  // half 가 바뀌면(하프타임 → 결과) 플레이헤드는 새 하프 기준으로 다시 센다.
  useEffect(() => setTick(null), [half]);

  const flip = useCallback((key: ToggleKey) => {
    setToggles((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        window.localStorage?.setItem(TOGGLE_STORAGE_KEY, serializeToggles(next));
      } catch {
        // 저장 실패(프라이빗 모드 등)는 이번 세션 선택만 적용 — 화면은 그대로 동작한다.
      }
      // 방금 켠 패널을 바로 보여준다(끌 때는 활성 탭 결정에 맡긴다).
      if (!prev[key]) setPreferredTab(key);
      return next;
    });
  }, []);

  return (
    <div className={styles.shell} data-testid="stage-shell">
      <ScoreBar
        match={match}
        homeName={homeName}
        awayName={awayName}
        liveScore={liveScore}
        tick={headerTick(match.state, tick, halfEndTick)}
        leagueRound={leagueRound}
        onBack={() => navigate("/lobby")}
      />

      <div className={`${styles.body} ${tabs.length === 0 ? styles.bodyNoSheet : ""}`}>
        <section className={styles.stage} data-testid="stage-canvas">
          <MatchViewer
            matchId={match.id}
            half={half}
            homeName={homeName}
            awayName={awayName}
            onTick={setTick}
            clock={clock}
            clockOffsetMs={offsetMs}
            logEnabled={logEnabled}
            baseline={baseline}
          />
        </section>

        {activeTab && (
          <aside
            className={`${styles.sheet} ${sheetKind === "state" ? styles.sheetState : styles.sheetInfo}`}
            data-testid="stage-sheet"
            data-sheet={sheetKind}
          >
            {tabs.length > 1 && (
              <div className={styles.tabs} role="tablist" aria-label="정보 패널">
                {tabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={t === activeTab}
                    className={`${styles.tab} ${t === activeTab ? styles.tabActive : ""}`}
                    data-testid={`stage-tab-${t}`}
                    onClick={() => setPreferredTab(t)}
                  >
                    {TAB_LABELS[t]}
                  </button>
                ))}
              </div>
            )}

            <div className={styles.panel}>
              {activeTab === "stats" && <StatsPanel matchId={match.id} half={half} tick={tick} />}
              {activeTab === "log" && (
                <LogPanel
                  matchId={match.id}
                  half={half}
                  homeName={homeName}
                  awayName={awayName}
                  tick={tick}
                  baseline={baseline}
                />
              )}
              {activeTab === "brief" && (
                <SecondHalfBriefPanel match={match} clockOffsetMs={offsetMs} />
              )}
              {activeTab === "halftime" && (
                <HalftimePanel match={match} clockOffsetMs={offsetMs} />
              )}
              {activeTab === "result" && (
                <ResultPanel match={match} homeName={homeName} awayName={awayName} />
              )}
            </div>
          </aside>
        )}
      </div>

      <nav className={styles.togglebar} aria-label="정보 토글">
        {TOGGLE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={toggles[key]}
            className={`${styles.toggle} ${toggles[key] ? styles.toggleOn : ""}`}
            data-testid={`stage-toggle-${key}`}
            onClick={() => flip(key)}
          >
            {TAB_LABELS[key]}
          </button>
        ))}
      </nav>
    </div>
  );
}
