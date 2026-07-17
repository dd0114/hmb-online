import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useMatch, useMe } from "../api/hooks";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { panelForState } from "./match-logic";
import { BriefingPanel } from "./BriefingPanel";
import { GenWaitPanel } from "./GenWaitPanel";
import { HalftimePanel } from "./HalftimePanel";
import { MatchViewer } from "./MatchViewer";
import { ResultPage } from "./ResultPage";
import styles from "./MatchPage.module.css";

const STATE_LABELS: Record<string, string> = {
  BRIEFING: "경기 전 브리핑",
  GEN1: "전반 준비",
  GEN2: "후반 준비",
  H1_BREAK: "하프타임",
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
  const queryClient = useQueryClient();
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

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle} data-testid="match-state-title">
        {match ? (STATE_LABELS[match.state] ?? match.state) : "매치"}
      </h1>
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

      {match && panel === "halftime" && (
        <div className={styles.halftimeWrap}>
          <p className={styles.h1Score} data-testid="h1-score">
            전반 스코어 {match.scoreH1Home ?? "-"} : {match.scoreH1Away ?? "-"}
          </p>
          <MatchViewer matchId={match.id} half={1} homeName={homeName} awayName={awayName} />
          <HalftimePanel match={match} />
        </div>
      )}

      {match && panel === "result" && (
        <ResultPage match={match} homeName={homeName} awayName={awayName} />
      )}

      {match && panel === "unknown" && (
        <p data-testid="unknown-state">알 수 없는 매치 상태: {match.state}</p>
      )}
    </Layout>
  );
}
