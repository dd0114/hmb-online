package online.hmb.away;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import online.hmb.common.TxRunner;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 주간 시즌(#245 hero E5) — 레이팅은 계속 쌓이다가 <b>주마다 보상을 주고 0 으로 초기화</b>된다.
 *
 * <p><b>왜 시즌을 행으로 두나</b>: "지금이 몇 주차인가"를 시각에서 파생하면 서버가 꺼져 있던 주가
 * 통째로 건너뛰어 보상이 조용히 사라진다. 마감은 {@code ends_at} 을 지난 ACTIVE 행을 찾아 닫는
 * 방식이라, 며칠 뒤에 켜도 <b>밀린 시즌이 순서대로</b> 정산된다.
 *
 * <p>멱등: 마감 스냅샷 {@code away_season_results} 의 PK(season_no,user_id) + 보상 원장
 * (reason={@code season_reward}, ref={@code s<번호>})이 이중으로 막는다. 스윕이 겹쳐 돌아도
 * 두 번 지급되지 않는다.
 */
@Service
public class AwaySeasonService {

    private static final Logger log = LoggerFactory.getLogger(AwaySeasonService.class);

    static final String REASON_SEASON_REWARD = "season_reward";

    private final JdbcClient jdbcClient;
    private final WalletService walletService;
    private final TxRunner txRunner;
    private final Clock clock;
    private final int lengthDays;
    private final int participationReward;
    private final Map<Integer, Integer> rankRewards;

    public AwaySeasonService(JdbcClient jdbcClient,
                             WalletService walletService,
                             TxRunner txRunner,
                             Clock clock,
                             @Value("${hmb.away.season.length-days}") int lengthDays,
                             @Value("${hmb.away.season.participation-reward}") int participationReward,
                             SeasonRewards seasonRewards) {
        this.jdbcClient = jdbcClient;
        this.walletService = walletService;
        this.txRunner = txRunner;
        this.clock = clock;
        this.lengthDays = lengthDays;
        this.participationReward = participationReward;
        this.rankRewards = seasonRewards.getRewards();
    }

    /** {@code hmb.away.season.rewards} (순위→포인트) 바인딩 전용. @Value 로는 Map 을 못 받는다. */
    @ConfigurationProperties(prefix = "hmb.away.season")
    public static class SeasonRewards {
        private Map<Integer, Integer> rewards = Map.of();

        public Map<Integer, Integer> getRewards() {
            return rewards;
        }

        public void setRewards(Map<Integer, Integer> rewards) {
            this.rewards = rewards;
        }
    }

    public record Season(long id, int seasonNo, String state, String startedAt, String endsAt) {
    }

    /** 현재 열린 시즌(없으면 연다). 원정 정산·조회가 이걸 기준으로 삼는다. */
    public Season current() {
        Season active = findActive();
        return active != null ? active : openNext(0);
    }

    private Season findActive() {
        return jdbcClient.sql("""
                        SELECT id, season_no, state, started_at, ends_at
                        FROM away_seasons WHERE state = 'ACTIVE'
                        """)
                .query((rs, n) -> new Season(rs.getLong("id"), rs.getInt("season_no"),
                        rs.getString("state"), rs.getString("started_at"), rs.getString("ends_at")))
                .optional()
                .orElse(null);
    }

    private Season openNext(int prevNo) {
        Instant now = Instant.now(clock);
        int next = prevNo + 1;
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO away_seasons(season_no, state, started_at, ends_at)
                        VALUES (?, 'ACTIVE', ?, ?)
                        """)
                .params(next, now.toString(), now.plus(Duration.ofDays(lengthDays)).toString())
                .update();
        Season opened = findActive();
        if (opened == null) {
            throw new IllegalStateException("시즌을 열지 못했습니다 (season_no=" + next + ")");
        }
        return opened;
    }

    /**
     * 마감 스윕 — {@code ends_at} 을 지난 ACTIVE 시즌을 닫고 보상 지급 후 레이팅을 0 으로 되돌린다.
     * 밀린 시즌이 여러 개면 <b>순서대로</b> 처리한다(한 번에 하나씩, 다음 스윕이 이어받는다).
     *
     * @return 이번 호출에서 닫은 시즌 수
     */
    public int sweepDueSeasons() {
        int closed = 0;
        for (int guard = 0; guard < 8; guard++) {   // 폭주 방지(밀려도 8주 이상은 한 번에 안 민다)
            Season active = findActive();
            if (active == null) {
                openNext(lastSeasonNo());
                continue;
            }
            if (Instant.parse(active.endsAt()).isAfter(Instant.now(clock))) {
                break;   // 아직 진행 중
            }
            closeSeason(active);
            closed++;
        }
        return closed;
    }

    private int lastSeasonNo() {
        return jdbcClient.sql("SELECT COALESCE(MAX(season_no), 0) FROM away_seasons")
                .query(Integer.class).single();
    }

    /**
     * 한 시즌을 닫는다: 순위 스냅샷 → 보상 지급 → 레이팅·연승 초기화 → 다음 시즌 오픈.
     *
     * <p>⚠️ 전부 <b>한 트랜잭션</b>이다. 스냅샷만 남고 초기화가 안 되면 다음 시즌이 지난 점수 위에서
     * 시작하고, 반대로 초기화만 되면 그 시즌 결과가 통째로 사라진다.
     */
    private void closeSeason(Season season) {
        txRunner.run(() -> {
            record Standing(String userId, int rating, int bestStreak) {
            }
            // 원정을 한 번이라도 한 유저만 대상 — 가입만 하고 안 한 계정에 참가상을 뿌리지 않는다.
            List<Standing> standings = jdbcClient.sql("""
                            SELECT r.user_id AS user_id, r.rating AS rating,
                                   COALESCE(s.best_streak, 0) AS best_streak
                            FROM user_ratings r
                            LEFT JOIN away_streaks s ON s.user_id = r.user_id
                            WHERE EXISTS (SELECT 1 FROM rating_ledger l WHERE l.user_id = r.user_id)
                            ORDER BY r.rating DESC, r.user_id ASC
                            """)
                    .query((rs, n) -> new Standing(rs.getString("user_id"), rs.getInt("rating"),
                            rs.getInt("best_streak")))
                    .list();

            String now = Instant.now(clock).toString();
            for (int i = 0; i < standings.size(); i++) {
                Standing st = standings.get(i);
                int rank = i + 1;
                int reward = rankRewards.getOrDefault(rank, participationReward);
                int inserted = jdbcClient.sql("""
                                INSERT OR IGNORE INTO away_season_results(
                                    season_no, user_id, rating, rank, reward_points, best_streak, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                                """)
                        .params(season.seasonNo(), st.userId(), st.rating(), rank, reward,
                                st.bestStreak(), now)
                        .update();
                if (inserted == 1 && reward > 0) {
                    walletService.apply(st.userId(), reward, REASON_SEASON_REWARD,
                            "s" + season.seasonNo());
                }
            }

            // 초기화 — 레이팅과 연승이 함께 0 으로. 연승만 남기면 새 시즌 첫 판에 보너스가 붙는다.
            jdbcClient.sql("UPDATE user_ratings SET rating = 0, updated_at = ?").param(now).update();
            jdbcClient.sql("UPDATE away_streaks SET streak = 0, updated_at = ?").param(now).update();

            jdbcClient.sql("UPDATE away_seasons SET state = 'CLOSED', closed_at = ? WHERE id = ?")
                    .params(now, season.id())
                    .update();
            openNext(season.seasonNo());
            log.info("away season {} closed — {} standings settled", season.seasonNo(), standings.size());
        });
    }

    /** 내 지난 시즌 성적(최근 것부터). 화면이 "지난주 몇 등이었나"를 말할 수 있게. */
    public List<Map<String, Object>> myHistory(String userId, int limit) {
        return jdbcClient.sql("""
                        SELECT season_no, rating, rank, reward_points, best_streak
                        FROM away_season_results WHERE user_id = ?
                        ORDER BY season_no DESC LIMIT ?
                        """)
                .params(userId, limit)
                .query((rs, n) -> Map.<String, Object>of(
                        "seasonNo", rs.getInt("season_no"),
                        "rating", rs.getInt("rating"),
                        "rank", rs.getInt("rank"),
                        "rewardPoints", rs.getInt("reward_points"),
                        "bestStreak", rs.getInt("best_streak")))
                .list();
    }
}
