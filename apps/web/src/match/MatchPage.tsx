import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useMatch, useMe } from "../api/hooks";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { panelForState } from "./match-logic";
import { BriefingPanel } from "./BriefingPanel";
import { GenWaitPanel } from "./GenWaitPanel";
import { StageShell } from "./stage/StageShell";
import styles from "./MatchPage.module.css";

const STATE_LABELS: Record<string, string> = {
  BRIEFING: "경기 전 브리핑",
  GEN1: "전반 준비",
  GEN2: "후반 준비",
  FIRST_HALF: "전반 진행 중",
  HALFTIME: "감독시간",
  SECOND_HALF: "후반 진행 중",
  H1_BREAK: "하프타임", // 레거시(P4 이전 배포본)
  FINISHED: "경기 종료",
  FAILED: "오류",
};

/**
 * /match/:id — useMatch 폴링(GEN* 3s)이 주는 state로 패널 라우팅 (LLD-web §2).
 * 홈 = 내 팀(매치 생성자), 어웨이 = 봇. 상대 이름은 BRIEFING의 opponent에서 오며
 * 이후 상태에 없을 수 있어 fallback "상대".
 */
export function MatchPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  // 리그 next-match 진입 시 라운드를 navigation state 로 전달받는다(MatchDetail 은 round 미포함,
  // mode/leagueFixtureId 만 제공 — openapi-v2 MatchDetailPhase2Fields).
  const leagueRound = (location.state as { leagueRound?: number } | null)?.leagueRound ?? null;
  const { data: me } = useMe();
  const { data: match, isLoading, isError } = useMatch(id);

  const homeName = me?.user.nickname ?? "내 팀";
  const awayName = match?.opponent?.name ?? "상대";

  // FINISHED 최초 관측 시 전적/지갑 갱신(보상 반영) — 로비 헤더가 새 전적을 보이게
  const finishedHandled = useRef(false);
  useEffect(() => {
    if (match?.state === "FINISHED" && !finishedHandled.current) {
      finishedHandled.current = true;
      queryClient.invalidateQueries({ queryKey: ["me"] });
    }
  }, [match?.state, queryClient]);

  const panel = panelForState(match?.state);

  // 관전 상태(라이브 전/후반·감독시간·종료) = 경기장면 고정 셸(#169 S1, P4-D4).
  // 준비 상태(BRIEFING/GEN*)는 아직 경기장면이 없는 폼 화면이라 기존 페이지 레이아웃을 쓴다.
  // GEN2(후반 생성)는 보통 재사용이라 눈 깜짝할 사이지만, AI 를 태우면 대기 화면이 필요하다.
  if (match && (panel === "live" || panel === "halftime" || panel === "result")) {
    return (
      <StageShell match={match} homeName={homeName} awayName={awayName} leagueRound={leagueRound} />
    );
  }

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle} data-testid="match-state-title">
        {match ? (STATE_LABELS[match.state] ?? match.state) : "매치"}
      </h1>
      {(match?.mode === "league" || match?.leagueFixtureId) && (
        <span className={styles.leagueBadge} data-testid="match-league-badge">
          리그{leagueRound != null ? ` R${leagueRound}` : ""}
        </span>
      )}
      <span className={styles.stateTag} data-testid="match-state">
        {match?.state ?? "…"}
      </span>
    </div>
  );

  return (
    <Layout header={header}>
      {isLoading && <p>매치 불러오는 중…</p>}
      {(isError || (!isLoading && !match)) && (
        <ErrorToast message="매치를 불러오지 못했습니다" />
      )}

      {match && panel === "briefing" && <BriefingPanel match={match} />}

      {match && (panel === "genwait" || panel === "failed") && <GenWaitPanel match={match} />}

      {match && panel === "unknown" && (
        <p data-testid="unknown-state">알 수 없는 매치 상태: {match.state}</p>
      )}
    </Layout>
  );
}
