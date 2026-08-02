import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { scoreAt, type LogEvent } from "@hmb/viewer-core";
import { useHalfLog, useMatchResult, type MatchDetail } from "../../api/hooks";
import { RewardSheet } from "../../rewards/RewardSheet";
import { rewardBundleOf, shouldShowRewardSheet } from "../../rewards/types";
import { captureOffsetMs, logAvailableFor } from "../live-clock";
import { MatchViewer } from "../MatchViewer";
import { HalftimePanel } from "../HalftimePanel";
import { useHalftimeDraft } from "../useHalftimeDraft";
import { AutoModeToggle } from "../AutoModeToggle";
import { ScoreBar } from "./ScoreBar";
import { StatsPanel } from "./StatsPanel";
import { PlayerStatsPanel } from "./PlayerStatsPanel";
import { useMatchPlayerStats } from "../usePlayerStats";
import { LogPanel } from "./LogPanel";
import { SecondHalfBriefPanel } from "./SecondHalfBriefPanel";
import { ResultPanel, RESULT_LABELS } from "./ResultPanel";
import {
  halfForState,
  headerMinute,
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
const SHEET_HEIGHT_CLASS: Record<"info" | "list" | "input" | "state" | "result", string> = {
  info: styles.sheetInfo!,
  list: styles.sheetList!,
  input: styles.sheetInput!,
  state: styles.sheetState!,
  result: styles.sheetResult!,
};

/**
 * **패널이 자기 스크롤을 갖는 탭** — 주 CTA 를 스크롤 **밖**에 두는 두 화면(#244 BL-1, #355).
 * 시트 패널이 스크롤을 소유하면 CTA 를 sticky 로밖에 못 띄우고, sticky 는 자기 아래로 콘텐츠가
 * 지나가므로 본문을 덮는다. 여기 든 탭은 `.panelFlush`(패딩 0 · overflow hidden · flex column)를
 * 받고, 패널 컴포넌트가 [스크롤 영역] + [고정 CTA] 두 층을 직접 만든다.
 */
const OWN_SCROLL_TABS: ReadonlySet<TabKey> = new Set<TabKey>(["halftime", "result"]);

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

  /**
   * 헤더 시계가 말할 **표기 분** (#388). 규칙은 `headerMinute` 한 곳이 소유한다 — 여기서 틱을
   * 분으로 바꾸지 마라(그 직독이 헤더만 0~44' 로 흐르게 한 결함이다). 감독시간이면 하프 끝 분.
   */
  const clockMinute = useMemo(() => headerMinute(match.state, log, tick), [match.state, log, tick]);

  // half 가 바뀌면(하프타임 → 결과) 플레이헤드는 새 하프 기준으로 다시 센다.
  useEffect(() => setTick(null), [half]);

  /**
   * 후반 지시 초안 (#284) — **전반의 `후반 지시` 탭과 감독시간의 `감독` 탭이 같은 초안을 본다.**
   * 셸이 소유하는 이유: 두 패널은 형제라 공통 조상이 여기뿐이고, 상태 전이(FIRST_HALF → HALFTIME)
   * 중에도 이 컴포넌트는 언마운트되지 않아 초안이 끊기지 않는다.
   */
  const draft = useHalftimeDraft(match.id);

  /**
   * **보상 시트** (#405 §2.9) — 경기 종료 → 보상 → `[확인]` → 결과 화면.
   *
   * ⚠️ 셸이 소유하는 이유: 시트는 무대 **위로** 올라오고(결과 탭 안이 아니다) 결과 패널의
   * "지금 선택하기"가 다시 열 수 있어야 한다. 결과 패널 안에 두면 다른 탭으로 넘어가는 순간
   * 확인 안 한 보상이 사라진다.
   *
   * ⚠️ **자동 노출은 상태 전이 한 번**이다(`sheetDismissed`). 봉투의 `acknowledgedAt` 은 ack 응답이
   * 돌아와야 바뀌는데, 그 사이 렌더에서 조건이 그대로 참이라 시트가 다시 뜬다. 로컬 래치가
   * 그 프레임을 막는다.
   */
  const { data: result } = useMatchResult(match.id, match.state === "FINISHED");
  const bundle = useMemo(() => rewardBundleOf(result), [result]);
  const [sheetDismissed, setSheetDismissed] = useState(false);
  const [sheetReopened, setSheetReopened] = useState(false);
  const resultKey = match.result ?? result?.result ?? undefined;
  const showRewardSheet =
    Boolean(bundle) && ((shouldShowRewardSheet(bundle) && !sheetDismissed) || sheetReopened);

  /**
   * 선수 기록 (#403). **탭과 피치 카드가 같은 결과를 본다**(집계 한 번) — 공통 조상이 여기뿐이다.
   *
   * 상한·캡션은 `statsWindow` 하나가 정한다(BL-1: 둘이 따로 놀아 감독시간이 "7분까지의 기록"
   * 위에 전 선수 0 을 그렸다). 여기서 분·상한을 조립하지 마라 — `clockMinute` 을 넘기기만 한다.
   *
   * ⚠️ **보고 있을 때만 켠다**(`enabled`). 이 집계는 O(스냅샷 × 선수)이고 플레이헤드마다 다시
   * 도는데, 항상 켜 두면 아무도 안 보는 동안에도 매 틱 수만 번이 돌아 관전 프레임 예산을 먹는다.
   */
  const playerStats = useMatchPlayerStats(
    match.id,
    match.state,
    tick,
    clockMinute,
    activeTab === "players",
  );

  return (
    <div className={styles.shell} data-testid="stage-shell">
      <ScoreBar
        match={match}
        homeName={homeName}
        awayName={awayName}
        myTeamSide={myTeamSide}
        liveScore={liveScore}
        minute={clockMinute}
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
              감독시간·결과는 **패널이 자기 스크롤을 갖는다**(#244 BL-1 · #355). 시트 패널이
              스크롤을 소유하면 주 CTA 를 sticky 로밖에 띄울 수 없고, sticky 는 자기 아래로 콘텐츠가
              지나가므로 본문을 덮는다(독립 검증: 360/390/412 전 폰에서 히트테스트 피격).
              여기서 스크롤을 넘겨주면 CTA 가 스크롤 **밖** 바닥에 앉아 어떤 위치에서도 안 덮는다.
              목록 = `OWN_SCROLL_TABS`(위) — 삼항으로 쓰면 두 번째 탭이 조용히 빠진다.
            */}
            {/*
              ⚠️ **`key={activeTab}` 가 필요하다 — 없으면 새 탭이 이미 스크롤된 채로 열린다.**
              이 `div` 가 시트의 유일한 스크롤러이고 탭이 바뀌어도 **같은 DOM 노드**라 앞 탭의
              `scrollTop` 을 그대로 물고 간다. 로그 패널은 마운트마다 마지막 줄을
              `scrollIntoView` 하므로(LogPanel), 로그를 보다 다른 탭으로 가면 그만큼 내려간 자리에서
              시작한다 — 실측 1280×800 에서 **235px**. 선수 탭에서는 그 235px 가 팀 세그먼트
              (우리↔상대)와 라이브 캡션을 통째로 덮어 "상대 기록을 볼 방법이 없는 화면"이 됐다.
              **문서 스크롤은 0 이라 기존 계약이 전부 green 이었고, 실화면 캡처로만 보였다**(루트 §2-2).
              key 를 주면 탭마다 새 노드라 항상 맨 위에서 시작하고, 로그의 자동 스크롤은 그 새 노드
              위에서 그대로 동작한다(자식 effect 가 마운트 뒤에 돈다).
            */}
            <div
              key={activeTab}
              className={`${styles.panel} ${OWN_SCROLL_TABS.has(activeTab) ? styles.panelFlush : ""}`}
            >
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
              {activeTab === "players" && (
                <PlayerStatsPanel
                  stats={playerStats}
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
                <ResultPanel
                  match={match}
                  homeName={homeName}
                  awayName={awayName}
                  /*
                   * ⚠️ **봉투가 있을 때만 문을 준다.** 없으면 눌러도 열 시트가 없어 죽은 버튼이
                   * 된다(W2b 이전 매치 · 봉투 생성이 삼켜진 경우). 만져도 아무 데도 안 가는
                   * 손잡이를 남기지 않는다.
                   */
                  onOpenRewards={bundle ? () => setSheetReopened(true) : undefined}
                  /*
                   * 미션 섹션(#408)은 **봉투가 있으면 시트가 소유한다**(보상 탭). 여기에도 그리면
                   * 같은 보상이 두 번 보이고, 그 중 하나는 이미 받은 뒤의 낡은 사본이 된다.
                   * 봉투가 없는 매치(구 정산 · 봉투 생성이 삼켜진 경우)에는 시트 자체가 없으므로
                   * 결과 화면이 **유일한 자리**다 — 그때만 결과 패널이 그린다.
                   */
                  hasRewardSheet={Boolean(bundle)}
                />
              )}
            </div>
          </aside>
        )}
      </div>

      {showRewardSheet && bundle && (
        <RewardSheet
          bundle={bundle}
          matchId={match.id}
          // 봉투 밖 additive 블록(미션 #408)을 읽는 섹션이 있다 — 셸은 안을 안 보고 그대로 넘긴다.
          result={result}
          badge={resultKey ? RESULT_LABELS[resultKey] ?? resultKey : null}
          badgeTone={(resultKey as "WIN" | "DRAW" | "LOSS" | undefined) ?? null}
          subtitle={`${match.scoreHome ?? "-"} : ${match.scoreAway ?? "-"}`}
          onClose={() => {
            setSheetDismissed(true);
            setSheetReopened(false);
          }}
        />
      )}
    </div>
  );
}
