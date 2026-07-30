import { useNavigate } from "react-router-dom";
import { useMe } from "../api/hooks";
import { useToken } from "../auth/TokenContext";
import { providerMeta } from "../auth/login-flow";
import { Layout } from "../common/Layout";
import { LogsPage } from "../logs/LogsPage";
import { RecordPanel } from "./RecordPanel";
import { RankingBoard } from "../common/RankingBoard";
import { useAwayRankings, useLeagueRankings } from "../api/hooks-p286";
import { useTutorial } from "../common/tutorial-context";
import styles from "./MePage.module.css";

/**
 * 내 정보 (#286 W2 — **셸까지만**).
 *
 * hero 지시로 **로그가 이 탭으로 들어왔다**. 지금은 프로필 한 줄 + 통산 전적 + 기존 로그 탭을
 * 얹는 데까지다.
 *
 * **W5 에서 붙은 것**: 모드별 전적 · 승률 도넛 · 최근 폼(`RecordPanel`) + 순위 2카드.
 *
 * ⚠️ 그 셋은 전부 서버 신규 API(`/api/me/record`, `/api/{away,league}/rankings` — #319 = W4)에
 * 물려 있고 **아직 서버에 없다**. 없으면 각 구역이 **통째로 사라지고** 상단 통산 전적 한 줄은
 * 그대로 남는다 — 유저가 잃는 것이 없다. ⚠️ 여기서 모드별로 쪼개는 시늉을 하면(현행 `/api/me`
 * 의 `records` 는 **통합 한 줄**뿐이다) 클라가 없는 숫자를 지어내게 된다.
 */
export function MePage() {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { provider } = useToken();
  const { restart: restartTutorial } = useTutorial();
  const rec = me?.records;
  // 순위 2카드 (#286 W5, 설계 §3.7) — 서버가 없으면 각자 조용히 사라진다.
  const { data: awayRank } = useAwayRankings();
  const { data: leagueRank } = useLeagueRankings();

  const header = (
    <div className={styles.headerRow}>
      <h1 className={styles.pageTitle}>내 정보</h1>
    </div>
  );

  return (
    <Layout header={header} nav>
      <div className={styles.page} data-testid="me-page">
        <section className={styles.profile}>
          <div className={styles.pinfo}>
            <b className={styles.nick}>{me?.user?.nickname ?? "감독님"}</b>
            <div className={styles.badges}>
              {/* 디비전 이름은 서버 값 그대로 — 클라가 level 로 만들지 않는다(#262 BL-1). */}
              {me?.league?.divisionName && (
                <span className={styles.badge} data-testid="me-division">
                  {me.league.divisionName}
                </span>
              )}
              {me?.rating !== undefined && (
                <span className={styles.badge} data-testid="me-rating">
                  원정 레이팅 {me.rating}
                </span>
              )}
              {/* 로그인 수단 — 로비 헤더에 있던 것을 **계정 정보 자리**로 옮겼다(#286).
                  홈은 최대한 간결하게 가기로 했고(hero 3R), 이건 매 화면에 필요한 정보가 아니다. */}
              {provider && (
                <span className={styles.badge} data-testid="provider-badge">
                  {providerMeta(provider).badge}
                </span>
              )}
            </div>
          </div>
        </section>

        {rec && (
          <section className={styles.record} data-testid="me-record">
            <b className={styles.recordLine}>
              {rec.wins}승 {rec.draws}무 {rec.losses}패
            </b>
            <span className={styles.recordSub}>
              통산 {rec.wins + rec.draws + rec.losses}경기
            </span>
          </section>
        )}

        <RecordPanel />

        <RankingBoard kind="league" data={leagueRank} title="🏅 리그 순위" />
        <RankingBoard kind="away" data={awayRank} title="🏅 원정 순위" />

        <LogsPage embedded />

        <button
          type="button"
          className={styles.tutorialReplay}
          data-testid="tutorial-replay"
          onClick={() => {
            restartTutorial();
            // 코치마크는 홈 타일을 가리키므로 홈으로 데려간다(#286 tutorial-steps).
            navigate("/home");
          }}
        >
          튜토리얼 다시 보기
        </button>
      </div>
    </Layout>
  );
}
