import { useState } from "react";
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
import { useGuide } from "../common/guide-context";
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
  const { replay: replayGuides } = useGuide();
  const rec = me?.records;
  // 순위 2카드 (#286 W5, 설계 §3.7) — 서버가 없으면 각자 조용히 사라진다.
  const { data: awayRank } = useAwayRankings();
  const { data: leagueRank } = useLeagueRankings();
  // RecordPanel 이 **통산 전적을 대신 말하는지** — 그 답은 서버 응답에 달려 있어 자식만 안다.
  // ⚠️ "패널이 보이는지"가 아니다(minor-3): 부분 응답이면 패널은 뜨는데 통산은 없다.
  const [panelShowsOverall, setPanelShowsOverall] = useState(false);

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

        {/* ⚠️ **RecordPanel 이 통산을 말하면 이 줄은 숨는다** — 둘 다 통산 전적을 말해서
            "12승 3무 8패"가 화면에 두 번 나왔다(독립검증 MIN-4). 이 줄은 서버 신규 API 가 없을
            때의 **폴백**이다: `/api/me` 의 records 만으로도 최소한 통산은 보여준다.
            ⚠️ 조건을 "패널이 보이면"으로 되돌리지 마라 — 부분 응답(overall 없이 form 만)에서
            양쪽 다 사라진다(minor-3). 계약이 그 변이를 죽인다. */}
        {rec && !panelShowsOverall && (
          <section className={styles.record} data-testid="me-record">
            <b className={styles.recordLine}>
              {rec.wins}승 {rec.draws}무 {rec.losses}패
            </b>
            <span className={styles.recordSub}>
              통산 {rec.wins + rec.draws + rec.losses}경기
            </span>
          </section>
        )}

        <RecordPanel onShowsOverall={setPanelShowsOverall} />

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

        <button
          type="button"
          className={styles.tutorialReplay}
          data-testid="guide-replay"
          onClick={() => {
            // #493 W2: 이 계정의 화면별 가이드 seen 을 비운다 — 각 화면(게임·원정·선수·영입·
            // 리그·내 정보)에 다시 들어갈 때 안내가 한 번씩 다시 뜬다. 온보딩과 별개 축이라
            // 홈으로 이동하지 않는다(이 화면의 가이드는 지금 자리에서 다시 뜬다).
            replayGuides();
          }}
        >
          화면 안내 다시 보기
        </button>
      </div>
    </Layout>
  );
}
