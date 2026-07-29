import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAwayCandidates, useMe, useStartAwayMatch } from "../api/hooks";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { matchInProgressIdOf } from "../common/match-lock";
import { awayStartError } from "./away-page-logic";
import styles from "./AwayPage.module.css";

/**
 * 원정 페이지 (#286 W2 — **셸까지만**).
 *
 * 지금까지 원정은 로비 모달 안의 버튼 하나였다. 설명·내 점수·랭킹보드·피침공 기록·복수가
 * 살 자리가 아예 없었던 것이 #286 발제의 절반이다. 이 화면이 그 자리를 만든다.
 *
 * ⚠️ **W2 는 여기까지다**: 설명 + 내 레이팅 + [원정 떠나기](기존 2택 흐름 이관).
 * **랭킹보드 · 피침공 5건 · 복수 큐**는 서버 신규 API(#286 W4: `GET /api/away/rankings`,
 * `GET /api/away/revenge`, `POST /api/away/revenge/{reportId}/matches`)가 있어야 하므로 W5 에서 붙는다.
 * 없는 데이터를 클라가 지어내지 않으려고 자리만 비워 둔다 — 빈 섹션을 미리 그리면
 * "데이터가 없는 건지 기능이 없는 건지" 구분이 안 된다.
 */
export function AwayPage() {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startAway = useStartAwayMatch();

  // 후보는 **누른 뒤에** 받아온다 — 미리 받아두면 화면을 열기만 해도 서버의 제시가 갱신돼
  // 앞서 받은 목록이 조용히 무효가 된다(제시는 유저당 1개다, #245 hero E2).
  const { data: offer, isLoading, error: offerError } = useAwayCandidates(picking);

  function start(defenderId?: string) {
    setError(null);
    startAway.mutate(defenderId, {
      onSuccess: (match) => navigate(`/match/${match.id}`),
      onError: (err) => {
        const resumeId = matchInProgressIdOf(err);
        if (resumeId) {
          navigate(`/match/${resumeId}`);
          return;
        }
        setError(awayStartError(err as ApiError | Error));
      },
    });
  }

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/game")}>
        ‹ 게임
      </button>
      <h1 className={styles.pageTitle}>원정</h1>
      <span className={styles.spacer} />
    </div>
  );

  return (
    <Layout header={header} nav>
      <div className={styles.page} data-testid="away-page">
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>⚔️ 원정이란?</h2>
          <p className={styles.body}>
            다른 감독이 저장해 둔 <b>실제 팀</b>에 쳐들어갑니다. 상대는 접속해 있지 않아도 되고,
            <b> 내가 없는 사이 남이 나를 침공</b>하기도 합니다. 승패로 <b>레이팅</b>이 오르내립니다.
          </p>
          <ol className={styles.steps}>
            <li>[원정 떠나기]를 누르면 서버가 <b>비슷한 레이팅 2팀</b>을 제시합니다 — 한 팀을 고릅니다.</li>
            <li>이기면 레이팅이 오르고, 지면 내려갑니다.</li>
            <li>나를 친 상대는 <b>복수 목록</b>에 남습니다.</li>
          </ol>
        </section>

        {/* 레이팅은 서버가 줄 때만 그린다 — 구 서버 응답엔 없다(optional). */}
        {me?.rating !== undefined && (
          <section className={styles.scoreCard} data-testid="away-rating-card">
            <div className={styles.score}>{me.rating}</div>
            <div className={styles.scoreLabel}>내 원정 레이팅</div>
          </section>
        )}

        {!picking && (
          <button
            type="button"
            className={styles.cta}
            data-testid="away-start"
            onClick={() => setPicking(true)}
          >
            원정 떠나기
          </button>
        )}

        {picking && (
          <section className={styles.card} data-testid="away-pick">
            <h2 className={styles.cardTitle}>원정 상대</h2>
            <p className={styles.pickHint}>
              레이팅이 비슷한 두 팀입니다. 한 팀을 고르세요.
              {offer && offer.streak > 0 && (
                <strong data-testid="away-streak"> · {offer.streak}연승 중</strong>
              )}
              {/* 남은 횟수는 **누르기 전에** 말한다. -1 은 무제한이라 표시하지 않는다. */}
              {offer && offer.remainingToday >= 0 && (
                <span data-testid="away-remaining"> · 오늘 {offer.remainingToday}회 남음</span>
              )}
            </p>
            {isLoading && <p className={styles.body}>상대를 찾는 중…</p>}
            {offerError instanceof ApiError && offerError.code === "NO_OPPONENT" && (
              <p className={styles.body} data-testid="away-no-opponent">
                아직 원정 갈 상대가 없습니다 — 다른 감독이 팀을 꾸리면 열립니다
              </p>
            )}
            <ul className={styles.candidates}>
              {offer?.candidates.map((c) => (
                <li key={c.userId}>
                  <button
                    type="button"
                    className={styles.candidate}
                    data-testid="away-candidate"
                    disabled={startAway.isPending}
                    onClick={() => start(c.userId)}
                  >
                    <span>{c.nickname}</span>
                    <span className={styles.candidateHint}>레이팅 {c.rating}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className={styles.cancel} onClick={() => setPicking(false)}>
              뒤로
            </button>
          </section>
        )}

        <ErrorToast message={error} onDismiss={() => setError(null)} />
      </div>
    </Layout>
  );
}
