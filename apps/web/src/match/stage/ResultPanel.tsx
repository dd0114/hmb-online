import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useHalfLog, useMatchResult, type MatchDetail } from "../../api/hooks";
import { useStartNextLeagueMatch } from "../../api/hooks-v2";
import { ApiError } from "../../api/client";
import { matchInProgressIdOf } from "../../common/match-lock";
import { useDecklessGuard } from "../../common/useDecklessGuard";
import { deriveTeamStats, TEAM_STAT_LABELS, type MatchEventLike } from "../match-logic";
import { GrowthReportSection } from "../GrowthReportSection";
import { PlayerStatsTable, PlayerTeamSegments, useTeamSegment } from "../PlayerStatsTable";
import {
  DEFAULT_SORT,
  motmKeyFor,
  motmRowOf,
  ratingTier,
  rowsFor,
  sortRows,
  teamSegments,
  type PlayerRow,
} from "../player-stats-view";
import type { MatchPlayerStats } from "../usePlayerStats";
import { MissionRewardSection } from "../../mission/MissionRewardSection";
import { Amount } from "../../common/Amount";
import { CURRENCY_POINT } from "../../common/currency";
import type { MatchDailyReward } from "../../api/p3";
import styles from "../ResultPage.module.css";

/** 승패 라벨 — 결과 카드와 보상 시트 뱃지가 **같은 표**를 쓴다(두 곳이 갈리면 안 된다). */
export const RESULT_LABELS: Record<string, string> = {
  WIN: "승리",
  DRAW: "무승부",
  LOSS: "패배",
};

interface ResultPanelProps {
  match: MatchDetail;
  homeName: string;
  awayName: string;
  /** 보상 시트를 다시 여는 문(#405) — 미룬 3지선다가 남아 있을 때 성장 리포트가 부른다. */
  onOpenRewards?: (() => void) | undefined;
  /**
   * 이 매치에 보상 시트가 있나(= 봉투가 왔나).
   *
   * ⚠️ 미션 섹션(#408)의 **자리를 가르는 값**이다 — 아래 `MissionRewardSection` 주석이 SoT.
   */
  hasRewardSheet?: boolean;
  /**
   * **결과 카드의 보상 줄을 미룬다** (#456 S4-W2, W1 독립검증 major-2).
   *
   * 경기 흐름 오버레이(#424)가 떠 있는 동안은 이 패널이 그 **뒤에** 그려진다. 그런데 B3 순차
   * 보상은 같은 금액을 한 장씩 공개하는 연출이라, 뒤에 `경기 보상 +1,200 G` 와 `오늘의 보상
   * +30 Z` 가 그대로 남아 있으면 **정답이 배경에 미리 인쇄돼 있는 것**이다(실캡처: 골드 3회 ·
   * 잼 2회 노출, 백드롭 `rgba(0,0,0,0.72)` 라 그대로 읽힌다). 첫 카드에서 순차가 무효가 된다.
   *
   * ⚠️ **백드롭을 더 어둡게 하는 것으로는 못 고친다** — 불투명도는 DOM 이 말하지 않아서(모듈
   * CLAUDE.md "DOM 계약이 초록인데 어포던스가 안 보이는 축") 계약이 검사하는 척만 하게 된다.
   * 그래서 **줄 자체를 미룬다**: 오버레이가 닫히면 같은 줄이 같은 금액으로 돌아온다(지우는 것이
   * 아니다 — 계약이 그 복귀를 양성 대조로 같이 잰다).
   * ⚠️ 값·형식·`data-*` 는 하나도 안 바꾼다. 이 플래그는 **시점**만 정한다.
   */
  deferRewardLines?: boolean;
  /**
   * 선수 기록 집계 (#403 W4) — **셸이 한 번 돌린 같은 결과**를 받는다. 여기서 다시 집계하면
   * 선수 탭과 결과 탭이 같은 경기의 같은 선수에게 다른 평점을 줄 수 있다(집계는 창·로스터에
   * 의존한다). 안 주면 이 섹션을 그리지 않는다 — 결과 패널은 그 없이도 성립한다.
   */
  playerStats?: MatchPlayerStats;
  /** 내 팀 사이드(#322 — `home = 나` 금지). 모르면 null: 세그먼트에 거짓 표식을 안 단다. */
  myTeamSide?: "home" | "away" | null;
}

/**
 * [D] 결과 패널 — 종료(FINISHED) 상태가 소유하는 시트 탭.
 *
 * 기존 `ResultPage`(무대 아래로 세로로 쌓이던 페이지)를 흡수한 것이다(#169, layout §2.6):
 * 무대는 계속 살아있는 채로 결과를 본다(리서치 R2). 스코어·승패·보상·팀스탯·[로비로]의
 * **testid 는 전부 보존**한다 — 기존 e2e(match-flow·league-season·w3-viewer-smoke)가 참조한다.
 *
 * ── 두 층: [스크롤 콘텐츠] + [바닥 CTA] (#355) ────────────────────────────────────────────
 * `[로비로]` 가 **모든** 데스크탑 비율에서 화면 밖이었다(1024×768 b1017 … 3440×1440 b1576).
 * 시트가 콘텐츠와 무관한 고정 높이인데 이 패널 내용이 그보다 컸기 때문인데, **높이를 키우는 것은
 * 해법이 아니다** — 이 패널의 내용에는 상한이 없다: `GrowthReportSection` 이 기용 선수 수만큼
 * 행을 붙이고(11명이면 수백 px), 결과 카드에도 보상 줄이 계속 늘어 왔다(#232 경기 보상 → #368
 * 오늘의 보상 칸). 어떤 고정값을 골라도 다음 줄에서 같은 결함이 이름만 바꿔 돌아온다.
 *
 * 그래서 감독시간(`HalftimePanel`)과 **같은 구조**로 간다: 스크롤은 안쪽 `.scroll` 이 갖고
 * CTA 는 그 **밖** 바닥에 앉는다. 어디까지 스크롤하든 나가는 문이 화면에 있다.
 * ⚠️ sticky 로 띄우지 마라 — 자기 아래로 콘텐츠가 지나가 팀 스탯 마지막 줄을 덮는다(#244 BL-1
 * 이 감독시간에서 실제로 당한 형태). 셸이 `panelFlush` 로 스크롤을 넘겨주는 것이 전제다
 * (`StageShell.OWN_SCROLL_TABS`).
 * 계약 = `e2e/p348-desktop-viewport.spec.ts` ⑥(전 비율 CTA 가시 · 성장 리포트 유 · **스크롤 불변**).
 */
export function ResultPanel({
  match,
  homeName,
  awayName,
  onOpenRewards,
  hasRewardSheet,
  deferRewardLines = false,
  playerStats,
  myTeamSide = null,
}: ResultPanelProps) {
  const navigate = useNavigate();
  const { data: result } = useMatchResult(match.id);
  const { data: log1 } = useHalfLog(match.id, 1);
  const { data: log2 } = useHalfLog(match.id, 2);

  const stats = useMemo(() => {
    const events = [
      ...(((log1?.events ?? []) as unknown as MatchEventLike[]) ?? []),
      ...(((log2?.events ?? []) as unknown as MatchEventLike[]) ?? []),
    ];
    return deriveTeamStats(events);
  }, [log1, log2]);

  const resultKey = result?.result ?? match.result ?? undefined;
  const scoreHome = result?.scoreHome ?? match.scoreHome;
  const scoreAway = result?.scoreAway ?? match.scoreAway;

  /*
   * ── 다음 행동 CTA (#456 B5) ────────────────────────────────────────────────
   * hero: *"경기 종료 후 각각 리그는 다음 경기 시작 버튼과 원정은 다음 원정 떠나기 버튼이 있어야 해"*.
   *
   * ⚠️ **`[로비로]` 를 대체하지 않고 그 위에 얹는다.** 이 CTA 에는 실패하는 갈래가 실재하고
   * (시즌 마지막 라운드 = `LEAGUE_INVALID`), 대체하면 그 순간 나갈 길이 없다. `to-lobby` 는
   * #348/#355 세로 예산 계약이 **좌표로 재는 앵커**이기도 하다.
   * ⚠️ **모드를 모르면 아무것도 안 그린다** — 구 서버·연습이 그 자리다. 리그로 추측하면 연습
   * 경기 뒤에 엉뚱한 리그 라운드를 여는 버튼이 생긴다.
   */
  const nextCtaLabel =
    match.mode === "league" ? "다음 경기 시작" : match.mode === "away" ? "다음 원정 떠나기" : null;
  const nextMatch = useStartNextLeagueMatch();
  // 새로 매치를 만드는 버튼이므로 덱 가드가 붙는다(apps/web CLAUDE.md L2 — URL 직접 진입과 같은 층).
  const deckless = useDecklessGuard();
  const [nextError, setNextError] = useState<string | null>(null);

  /**
   * ⚠️ **더블탭 한 번은 클릭 두 개다 — `disabled` 로는 못 막는다.**
   *
   * `disabled={nextMatch.isPending}` 은 React 가 리렌더한 **뒤**에야 걸리므로 같은 이벤트 버스트의
   * 두 번째 클릭이 그대로 통과한다(실측 `nextCalls 2`). 폰에서 유저가 실제로 하는 동작이다.
   *
   * ⚠️ **서버는 이미 안전하다** — `LeagueService.nextMatch` 가 트랜잭션 안에서 진행 중 매치를
   * 재사용하고, 아니면 409 → `matchInProgressIdOf` 가 같은 매치로 보낸다. **중복 매치는 안 생긴다.**
   * 그래도 막는 이유는 잃는 것이 없어서다(불필요한 왕복 + 409 경로를 평상시에 태우지 않는다).
   * 계약 = `p456-full-journey` A(같은 태스크에서 두 번 클릭 → `nextCalls === 1`).
   */
  const nextInFlight = useRef(false);

  function startNext() {
    if (nextInFlight.current) return;
    nextInFlight.current = true;
    setNextError(null);
    /*
     * ⚠️ **원정은 이동만 한다.** 서버의 상대 제시는 유저당 1개라 여기서 새로 받아 오면 유저가
     * 앞서 받아 둔 후보 목록이 조용히 무효가 된다(#245 hero E2). 고르는 화면으로 보내고,
     * 제시를 소모하는 결정은 거기서 유저가 한다.
     */
    if (match.mode === "away") {
      navigate("/away");
      nextInFlight.current = false;
      return;
    }
    // 덱이 없으면 안내만 뜨고 **화면에 남는다** — 래치를 안 풀면 덱을 만든 뒤 다시 눌러도 죽는다.
    if (!deckless.guard()) {
      nextInFlight.current = false;
      return;
    }
    nextMatch.mutate(undefined, {
      onSuccess: (res) =>
        navigate(`/match/${res.match.id}`, { state: { leagueRound: res.fixture.round } }),
      onError: (err) => {
        // 409 는 실패가 아니라 **이어가라는 안내**다(#217) — 리그 화면과 같은 처리.
        const resumeId = matchInProgressIdOf(err);
        if (resumeId) {
          navigate(`/match/${resumeId}`);
          return;
        }
        // 아래 두 갈래는 화면에 남는다 → 재시도할 수 있게 래치를 푼다(이동하는 갈래는 안 푼다).
        nextInFlight.current = false;
        if (deckless.catchReject(err)) return;
        setNextError(
          err instanceof ApiError && err.code === "LEAGUE_INVALID"
            ? `다음 경기를 시작할 수 없습니다 — ${err.message}`
            : err instanceof Error
              ? err.message
              : "다음 경기 시작 실패",
        );
      },
    });
  }

  return (
    <div className={styles.panel} data-testid="result-page">
      <div className={styles.scroll} data-testid="result-scroll">
        <section className={styles.resultCard}>
          {resultKey && (
            <span
              className={[styles.badge, styles[`badge${resultKey}` as keyof typeof styles] ?? ""].join(" ")}
              data-testid="result-badge"
            >
              {RESULT_LABELS[resultKey] ?? resultKey}
            </span>
          )}
          <p className={styles.finalScore} data-testid="final-score">
            {homeName} {scoreHome ?? "-"} : {scoreAway ?? "-"} {awayName}
          </p>
          {/* 순차 보상 카드가 같은 금액을 공개하는 동안은 이 두 줄을 미룬다(위 `deferRewardLines`). */}
          {!deferRewardLines && result?.pointsAwarded != null && (
            <p className={styles.reward} data-testid="reward-points">
              경기 보상 +<Amount code={CURRENCY_POINT} value={result.pointsAwarded} />
            </p>
          )}
          {!deferRewardLines && (
            <DailyRewardLine reward={(result as { dailyReward?: MatchDailyReward | null })?.dailyReward} />
          )}
        </section>

        {/*
          오늘의 미션 (#408) — **기본 자리는 여기가 아니라 보상 시트의 미션 탭**이다(#405 요구 2,
          설계 §2.9.1). #408 이 남긴 *"보상 탭이 랜딩하면 이 줄을 그쪽으로 옮기기만 하면 된다"* 를
          그대로 이행한 것이고, 등록 줄은 `rewards/registry.ts` 에 있다.

          ⚠️ **그런데 조건부다 — 이 매치에 봉투가 없을 때만 그린다.**
           · 봉투가 있으면 시트가 그린다. 여기서도 그리면 **같은 보상이 두 번** 보이고, 시트에서
             받고 내려온 유저는 결과 화면에서 이미 받은 줄을 다시 본다(이중 렌더 금지).
           · 봉투가 없는 매치(구 정산 · 봉투 생성이 삼켜진 경우)에는 **시트 자체가 열리지 않으므로**
             여기가 미션에 닿는 유일한 자리다. 지우면 그 유저는 결과 화면에서 미션을 못 본다.
          즉 "한 곳"은 유지되고, 그 한 곳이 봉투 유무에 따라 갈릴 뿐이다.
          (원정이 아니거나 구 서버면 컴포넌트가 스스로 null 을 돌려주므로 그 분기는 여기 없다.)
        */}
        {!hasRewardSheet && (
          <MissionRewardSection missions={(result as { missions?: unknown })?.missions} />
        )}

        <section className={styles.statsCard} data-testid="team-stats">
          <h3 className={styles.statsTitle}>팀 스탯</h3>
          <table className={styles.statsTable}>
            <thead>
              <tr>
                <th className={styles.homeCol}>{homeName}</th>
                <th />
                <th className={styles.awayCol}>{awayName}</th>
              </tr>
            </thead>
            <tbody>
              {TEAM_STAT_LABELS.map(([key, label]) => (
                <tr key={key}>
                  <td className={styles.homeCol} data-testid={`stat-home-${key}`}>
                    {stats.home[key]}
                  </td>
                  <td className={styles.statLabel}>{label}</td>
                  <td className={styles.awayCol} data-testid={`stat-away-${key}`}>
                    {stats.away[key]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/*
          개인 성적 (#403 W4, 목업 ⑤). **자리는 팀 스탯 뒤 · 성장 리포트 앞**이다 — 목업 본문이
          *"그 사이(팀 스탯 뒤)에 넣는다"* 라고 못 박았다(그림은 MOTM 을 스코어 밑에 그렸지만
          본문이 결정이다). 팀 → 개인 → 성장 순으로 좁혀 읽히고, #355 의 세로 예산 계약
          (`p348-desktop-viewport` ⑥: *"결과 카드 아래 팀 스탯의 **시작**이 보인다"*)이 재는
          것이 바로 위 두 섹션이라 그 아래에 붙는 이 섹션은 그 계약을 밀지 않는다.
        */}
        {playerStats && (
          <ResultPlayersSection
            stats={playerStats}
            homeName={homeName}
            awayName={awayName}
            myTeamSide={myTeamSide}
          />
        )}

        <GrowthReportSection matchId={match.id} onOpenRewards={onOpenRewards} />
      </div>

      {/*
        ⚠️ 스크롤 **밖**이다(위 헤더) — `.scroll` 안으로 되돌리면 #355 가 그대로 재발한다.

        실패 안내도 **이 층**이다(감독시간 `.ctaAlert` 와 같은 이유, #294 MAJOR): 스크롤 영역
        끝에 두면 고정 CTA 가 그 위에 앉아 유저는 그것을 볼 방법이 없고, 화면이 클릭 전과
        완전히 같아 "버튼 먹통"으로 읽힌다.
      */}
      {nextError && (
        <p className={styles.ctaAlert} role="alert" data-testid="result-next-error">
          {nextError}
        </p>
      )}
      {/*
        `data-cta-count` 가 배치를 가른다(CSS 머리말이 SoT) — 둘이면 데스크탑에서 **가로 한 줄**이
        되어 바닥 높이가 CTA 없을 때와 같아진다. 세로로 쌓으면 그 62px 를 `.scroll` 이 내고
        #355 의 "팀 스탯의 시작이 보인다"가 1024×768·1280×720 에서 깨진다(S3-R1 blocker-1).
        ⚠️ 개수는 **여기서 파생**한다 — CSS 에 버튼 목록을 다시 적으면 세 번째 버튼이 생기는 날
        조용히 어긋난다.
      */}
      <div
        className={styles.ctaRow}
        data-testid="result-cta-row"
        data-cta-count={nextCtaLabel ? 2 : 1}
      >
        {nextCtaLabel && (
          <button
            type="button"
            className={styles.nextCta}
            data-testid="result-next-cta"
            onClick={startNext}
            disabled={nextMatch.isPending}
          >
            {nextMatch.isPending ? "경기 준비 중…" : nextCtaLabel}
          </button>
        )}
        {/*
          ⚠️ **모드와 무관하게 항상 남는다.** 다음 경기 CTA 가 실패하는 갈래가 있으므로 이걸
          없애면 유저가 결과 화면에 갇힌다. testid 도 그대로다 — #348/#355 가 이 앵커로 잰다.
        */}
        <button
          type="button"
          className={`${styles.toLobby} ${nextCtaLabel ? styles.toLobbySecondary : ""}`}
          data-testid="to-lobby"
          onClick={() => navigate("/home")}
        >
          로비로
        </button>
      </div>
      {deckless.dialog}
    </div>
  );
}

/**
 * **MOTM + 양팀 개인 성적** (#403 W4 = 요구 C, 목업 ⑤).
 *
 * 새로 만든 것은 **자리와 문구뿐**이다 — 집계(`useMatchPlayerStats`)·창(`statsWindow`)·표
 * (`PlayerStatsTable`)·세그먼트는 전부 W1~W2 의 것을 그대로 쓴다. 선수 탭과 같은 컴포넌트라
 * 같은 selector(`players-*`)로 두 화면을 잴 수 있고, 그것이 "같은 것"이라는 증거다.
 *
 * ── 선수 탭과 **다른 점** 셋 ─────────────────────────────────────────────────────────────
 * ① **정렬 컨트롤이 없다** — 결과 탭은 요약 성격이고 세로 예산이 빡빡하다(#355). 항상
 *    `DEFAULT_SORT`(평점)이고, 축을 바꿔 보고 싶으면 `선수` 탭이 그 자리다.
 * ② **라이브 캡션이 없다** — `FINISHED` 전용이라 창이 항상 `settled` 다(캡션 자체가 null).
 * ③ **MOTM 한 줄이 붙는다** — 숫자 표만 있으면 "누가 잘했나"가 안 읽힌다(목업 ⑤ 근거문).
 *
 * ⚠️ **MOTM 게이트는 `motmKeyFor` 가 건다**(창이 `settled` 일 때만). 이 화면에서는 항상 참이라
 * 인라인으로 적으면 게이트 없는 형태로 조용히 굳는다 — 그래서 판정을 호출하지 재현하지 않는다.
 */
function ResultPlayersSection({
  stats,
  homeName,
  awayName,
  myTeamSide,
}: {
  stats: MatchPlayerStats;
  homeName: string;
  awayName: string;
  myTeamSide: "home" | "away" | null;
}) {
  /**
   * ⚠️ `myTeamSide` 는 `/api/me` 가 늦으면 **마운트 뒤에** 온다 — `useTeamSegment` 머리말이 SoT.
   * (`useState(() => defaultSegment(...))` 였을 때 어웨이 라운드가 `내 팀` 칩과 다른 표를 열었다.)
   */
  const [team, setTeam] = useTeamSegment(myTeamSide);
  const { result, roster, coverage, window: win, isLoading, isError, logMissing } = stats;

  const rows = useMemo(
    () => (result ? sortRows(rowsFor(result, team, roster), DEFAULT_SORT) : []),
    [result, team, roster],
  );

  /**
   * MOTM 은 **양 팀에서** 찾는다(`motmRowOf`) — 지금 고른 세그먼트가 상대 팀이면 그 줄이 사라져
   * 버린다. 판정을 여기서 재현하지 않는 이유는 그 함수 머리말에 있다(계약이 잴 수 있는 자리).
   */
  const motmKey = motmKeyFor(result, win);
  const motmRow = useMemo(() => motmRowOf(result, roster, motmKey), [result, roster, motmKey]);

  return (
    <section className={styles.playersCard} data-testid="result-players">
      <h3 className={styles.statsTitle}>개인 성적</h3>

      {/*
        ⚠️ **없는 것을 "불러오지 못했습니다"로 덮지 않는다.** 서버는 하프 로그가 없으면 404 를
        주고(`MatchService.halfLogJson`), 과거 경기 목록은 그런 매치를 `hasHalves:false` 로
        이미 구분해 그린다 — **정상적으로 존재하는 상태**다. 두 문구가 하나로 합쳐지면 유저는
        영영 안 될 것을 다시 시도하거나(전자), 있는 기록을 없다고 믿는다(후자).
      */}
      {isLoading ? (
        <p className={styles.playersNote} data-testid="result-players-loading">
          선수 기록 불러오는 중…
        </p>
      ) : logMissing ? (
        <p className={styles.playersNote} data-testid="result-players-missing">
          이 경기는 기록이 남아 있지 않습니다
        </p>
      ) : isError || !result ? (
        <p className={styles.playersNote} data-testid="result-players-error">
          선수 기록을 불러오지 못했습니다
        </p>
      ) : (
        <div className={styles.playersInner}>
          {motmRow && <MotmLine row={motmRow} homeName={homeName} awayName={awayName} />}
          <PlayerTeamSegments
            segments={teamSegments({ home: homeName, away: awayName }, myTeamSide)}
            team={team}
            onChange={setTeam}
          />
          {/*
            ⚠️ **핸들러를 주지 않는다** = 행이 버튼이 아니다. 상세 모달은 셸(`StageShell`)이
            소유하고 이 패널은 거기 닿지 않으므로, 핸들러를 억지로 넘기면 눌리는데 아무 일도
            안 일어나는 **죽은 손잡이**가 된다(위 `onOpenRewards` 의 *"만져도 아무 데도 안 가는
            손잡이를 남기지 않는다"* 와 같은 규율). 상세로 가는 문은 `선수` 탭이다 — 종료 후에도
            그 탭은 살아 있다(`tabsFor("FINISHED")` 에 `players` 가 있다, 목업 ⑤ 캡션).
          */}
          <PlayerStatsTable
            rows={rows}
            motmKey={motmKey}
            coverage={coverage}
            emptyLabel="이 경기에 출전 기록이 없습니다"
          />
        </div>
      )}
    </section>
  );
}

/** MOTM 한 줄 — 번호·이름·팀·평점. 팀을 같이 말하는 이유는 **상대가 MOTM 일 수 있어서**다(#322). */
function MotmLine({ row, homeName, awayName }: { row: PlayerRow; homeName: string; awayName: string }) {
  return (
    <div className={styles.motm} data-testid="result-motm" data-team={row.team} data-player={row.playerId}>
      <i
        className={`${styles.motmNum} ${row.team === "home" ? styles.motmNumHome : styles.motmNumAway}`}
        aria-hidden="true"
      >
        {row.num ?? "–"}
      </i>
      <div className={styles.motmBody}>
        <span className={styles.motmTitle}>MAN OF THE MATCH</span>
        <span className={styles.motmName}>
          <b data-testid="result-motm-name">{row.name}</b>
          <span className={styles.motmTeam} data-testid="result-motm-team">
            {row.team === "home" ? homeName : awayName}
          </span>
          <i className={styles.motmRating} data-tier={ratingTier(row.line.rating, true)} data-testid="result-motm-rating">
            {row.line.rating.toFixed(1)}
          </i>
        </span>
      </div>
    </div>
  );
}

/**
 * 그 판이 소비한 **오늘의 보상 칸** (#368). 리그 매치가 아니면 서버가 안 주므로 아무것도 안 그린다.
 *
 * <p>⚠️ **소멸도 보여준다.** 안 보여주면 유저는 칸이 소비된 줄 모르고, 다음 판에서 트랙이 한 칸
 * 앞서 있는 이유를 알 방법이 없다 — 대량 칸을 날린 경우가 특히 그렇다(얼마짜리였는지 말해 주는 것이
 * 규칙을 가르치는 유일한 순간이다).
 *
 * <p>⚠️ `pointsAwarded` 로 대신할 수 없다 — 그건 `reason LIKE 'reward_%'` 합계라 다이아 칸에서는 항상
 * 0이고 재화를 말하지 못한다. 금액과 재화는 항상 같이 온다(#232).
 */
function DailyRewardLine({ reward }: { reward?: MatchDailyReward | null }) {
  if (!reward || typeof reward !== "object" || !Number.isFinite(reward.slotNo)) return null;
  // 트랙을 다 쓴 뒤의 경기 — 칸은 세어지지만 값이 0이다. 줄을 지우면 "보상이 왜 안 들어왔지"가 된다.
  if (!reward.amount) {
    return (
      <p className={styles.reward} data-testid="reward-daily-none">
        오늘의 보상 <span data-testid="reward-daily-exhausted">오늘 칸을 모두 썼습니다</span>
      </p>
    );
  }
  return (
    <p
      className={styles.reward}
      data-testid="reward-daily"
      data-awarded={reward.awarded ? "1" : "0"}
      data-slot={reward.slotNo}
    >
      오늘의 보상 <span className={styles.rewardSlotHint}>{reward.slotNo}번째 칸</span>{" "}
      {reward.awarded ? (
        <>
          +<Amount code={reward.currency} value={reward.amount} />
        </>
      ) : (
        <span className={styles.rewardVanished} data-testid="reward-daily-vanished">
          <Amount code={reward.currency} value={reward.amount} /> 소멸
        </span>
      )}
    </p>
  );
}
