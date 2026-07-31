import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { scoreAt, type LogEvent } from "@hmb/viewer-core";
import { useHalfLog, type MatchDetail } from "../../api/hooks";
import { captureOffsetMs, logAvailableFor } from "../live-clock";
import { MatchViewer } from "../MatchViewer";
import { HalftimePanel } from "../HalftimePanel";
import { useHalftimeDraft } from "../useHalftimeDraft";
import { AutoModeToggle } from "../AutoModeToggle";
import { ScoreBar } from "./ScoreBar";
import { StatsPanel } from "./StatsPanel";
import { LogPanel } from "./LogPanel";
import { SecondHalfBriefPanel } from "./SecondHalfBriefPanel";
import { ResultPanel } from "./ResultPanel";
import {
  halfEndTickOf,
  halfForState,
  headerTick,
  playedBaseline,
  resolveActiveTab,
  sheetHeight,
  statePanelFor,
  tabsFor,
  TAB_LABELS,
  type TabKey,
} from "./stage-state";
import styles from "./StageShell.module.css";

/**
 * 시트 높이 등급 → 클래스. 등급 축은 `stage-state.sheetHeight` 가 소유하고 여기선 이름만 붙인다 —
 * 삼항으로 쓰면 등급이 셋이 된 순간(#348 `input`) 새 등급이 조용히 `info` 로 떨어진다(실제로 그 모양이었다).
 */
const SHEET_HEIGHT_CLASS: Record<"info" | "input" | "state", string> = {
  info: styles.sheetInfo!,
  input: styles.sheetInput!,
  state: styles.sheetState!,
};

interface StageShellProps {
  match: MatchDetail;
  homeName: string;
  awayName: string;
  /**
   * 내 팀이 선 사이드(#322 안 C). 어웨이 라운드엔 내 팀이 오른쪽에 서므로 표식이 없으면 유저가
   * 매 라운드 자기 자리를 다시 찾아야 한다. 모르면 null — 거짓 표식을 달지 않는다.
   */
  myTeamSide?: "home" | "away" | null;
  /** 리그 라운드(MatchDetail 에 없어 navigation state 로만 온다) — 스코어바 뱃지용. */
  leagueRound?: number | null;
}

/**
 * 관전 셸 — **경기장면 고정 메인 + 정보 시트** (P4-D4 / AC-W1-1, #169 S1 → #284 재편).
 * 설계 SoT = docs/plan-v5/layout-game-screen.md §2·§3, 리서치 근거 = research-spectator-ux.md R1~R6.
 *
 * 구조: [A] 스코어바 / [B] 무대(경기장면, 절대 사라지지 않음) / [D] 정보 시트.
 * 문서는 스크롤하지 않는다 — 스크롤은 패널 안에만 있다(R1).
 *
 * ⚠️ **[C] 토글바는 #284 에서 없앴다.** 정보 패널을 껐다 켜는 하단 줄이 있었고, 두 개 이상 켜면
 * 시트 위에 탭바가 또 생겨 **똑같이 생긴 줄이 두 개**였다(hero 캡처). 이제 시트는 상시이고 무엇이
 * 탭으로 뜨는지는 `tabsFor(state, …)` 가 정한다. 되살리지 마라 — 탭 안에서 고르면 되는 것을
 * 화면 밖에서 한 번 더 고르게 하는 구조였다.
 *
 * 패널은 두 종류다(stage-state.ts):
 *  · 정보 탭(통계/로그/후반지시) = 항상 표시. `brief` 만 상태 제한(전반).
 *  · 상태 패널(하프타임 감독/종료 결과) = 매치 상태 소유, 지금 해야 할 일이라 맨 앞·기본 선택.
 */
export function StageShell({
  match,
  homeName,
  awayName,
  myTeamSide = null,
  leagueRound = null,
}: StageShellProps) {
  const navigate = useNavigate();
  const [preferredTab, setPreferredTab] = useState<TabKey | null>(null);
  // 재생 플레이헤드(뷰어가 미러링). 통계·로그·시계가 "지금까지"를 계산하는 기준.
  const [tick, setTick] = useState<number | null>(null);

  const half = halfForState(match.state);
  const statePanel = statePanelFor(match.state, match.auto);
  const tabs = tabsFor(match.state, statePanel);
  const activeTab = resolveActiveTab(tabs, preferredTab);
  const sheetKind = sheetHeight(activeTab);
  /** 감독시간 = **관리 모드**: 무대가 상시가 아니라 탭이다(#244). */
  const managing = statePanel === "halftime";

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

  /**
   * 후반 지시 초안 (#284) — **전반의 `후반 지시` 탭과 감독시간의 `감독` 탭이 같은 초안을 본다.**
   * 셸이 소유하는 이유: 두 패널은 형제라 공통 조상이 여기뿐이고, 상태 전이(FIRST_HALF → HALFTIME)
   * 중에도 이 컴포넌트는 언마운트되지 않아 초안이 끊기지 않는다.
   */
  const draft = useHalftimeDraft(match.id);

  return (
    <div className={styles.shell} data-testid="stage-shell">
      <ScoreBar
        match={match}
        homeName={homeName}
        awayName={awayName}
        myTeamSide={myTeamSide}
        liveScore={liveScore}
        tick={headerTick(match.state, tick, halfEndTick)}
        leagueRound={leagueRound}
        autoSlot={<AutoModeToggle match={match} variant="pill" />}
        onBack={() => navigate("/home")}
      />

      {/*
        감독시간에는 무대를 **상시 표시하지 않는다** — `stage` 탭으로 내린다(#244, hero 결정).
        그래야 이 화면이 덱 편성과 **같은 레이아웃**이 된다(무대가 세로를 먹으면 감독시간만 다른
        화면이 되고, 그러면 유저가 두 화면을 다르게 배워야 한다).
        관전(전·후반)에서는 그대로 상시다 — #169 AC-W1-1 은 그 상태의 계약이다.
      */}
      <div
        className={`${styles.body} ${tabs.length === 0 ? styles.bodyNoSheet : ""} ${
          managing ? styles.bodyManaging : ""
        } ${sheetKind === "input" ? styles.bodyInput : ""}`}
      >
        {!managing && (
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
        )}

        {activeTab && (
          <aside
            className={`${styles.sheet} ${SHEET_HEIGHT_CLASS[sheetKind ?? "info"]}`}
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

            {/*
              감독시간은 **패널이 자기 스크롤을 갖는다**(#244 BL-1). 시트 패널이 스크롤을 소유하면
              주 CTA 를 sticky 로밖에 띄울 수 없고, sticky 는 자기 아래로 콘텐츠가 지나가므로
              프롬프트를 덮는다(독립 검증: 360/390/412 전 폰에서 히트테스트 피격).
              여기서 스크롤을 넘겨주면 CTA 가 스크롤 **밖** 바닥에 앉아 어떤 위치에서도 안 덮는다.
            */}
            <div className={`${styles.panel} ${activeTab === "halftime" ? styles.panelFlush : ""}`}>
              {activeTab === "stats" && (
                <StatsPanel
                  matchId={match.id}
                  half={half}
                  tick={tick}
                  homeName={homeName}
                  awayName={awayName}
                  myTeamSide={myTeamSide}
                />
              )}
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
                <SecondHalfBriefPanel match={match} clockOffsetMs={offsetMs} draft={draft} />
              )}
              {activeTab === "halftime" && (
                <HalftimePanel match={match} clockOffsetMs={offsetMs} draft={draft} />
              )}
              {activeTab === "stage" && (
                /*
                 * 경기장면 탭(감독시간) = **돌려보는 화면**이다(#244, hero). 감독시간에 보는 하프는
                 * 이미 끝난 전반이라 자유 스크럽이 허용된다(라이브 상한은 지나간 하프엔 안 걸린다 —
                 * match-live-clock AC-W3-1 c). 그래서 시간바·키장면 핀·스텝을 **일반 유저에게도** 연다.
                 * 캔버스 아래 빈 자리를 그 컨트롤이 채운다.
                 */
                <section className={styles.stageInPanel} data-testid="stage-canvas">
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
                    reviewControls
                  />
                </section>
              )}
              {activeTab === "result" && (
                <ResultPanel match={match} homeName={homeName} awayName={awayName} />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
