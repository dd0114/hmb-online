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
        return active != null ? active : openNext(lastSeasonNo(), null);
    }

    /**
     * 시각 파싱 — ISO-8601 이 정본이되 <b>SQLite 기본 포맷도 읽는다</b>.
     *
     * <p>왜 관대한가: 이 값을 못 읽으면 스윕이 예외로 죽고, 스위퍼가 그걸 삼켜서 <b>시즌이 조용히
     * 영원히 안 닫힌다</b>(보상·초기화가 통째로 사라지는데 에러도 안 뜬다 — 독립검증에서 실제로 잡힌
     * 형태다). 형식 하나 때문에 기능이 통째로 죽는 것보다, 읽어서 진행하고 로그를 남기는 게 낫다.
     * 쓰기는 항상 ISO 로 한다(관대함은 읽기에만).
     */
    static Instant parseTime(String raw) {
        try {
            return Instant.parse(raw);
        } catch (RuntimeException e) {
            // 'YYYY-MM-DD HH:MM:SS' (SQLite datetime()) — UTC 로 본다.
            return java.time.LocalDateTime
                    .parse(raw.trim().replace(' ', 'T'))
                    .toInstant(java.time.ZoneOffset.UTC);
        }
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

    /**
     * @param startFrom 새 시즌의 시작 시각. 직전 시즌을 닫고 여는 경우엔 <b>그 시즌의 종료 시각</b>을
     *     넘긴다 — "지금"으로 열면 서버가 4주 꺼져 있어도 시즌이 1개만 닫히고 나머지 3주가 사라진다
     *     (독립검증 MIN-4). 이어 붙여야 밀린 주가 순서대로 정산된다.
     */
    private Season openNext(int prevNo, Instant startFrom) {
        int next = prevNo + 1;
        Instant start = startFrom != null ? startFrom : Instant.now(clock);
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO away_seasons(season_no, state, started_at, ends_at)
                        VALUES (?, 'ACTIVE', ?, ?)
                        """)
                .params(next, start.toString(), start.plus(Duration.ofDays(lengthDays)).toString())
                .update();
        Season opened = findActive();
        if (opened == null) {
            // season_no 가 이미 쓰였는데 ACTIVE 가 없는 상태(수동 개입·부분 롤백). 번호를 밀어 연다 —
            // 여기서 던지면 트랜잭션이 롤백되고 스윕이 영구 재시도 루프에 빠진다(MIN-7).
            log.warn("season {} already exists but no ACTIVE — advancing", next);
            return openNext(next, start);
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
                openNext(lastSeasonNo(), null);
                continue;
            }
            if (parseTime(active.endsAt()).isAfter(Instant.now(clock))) {
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
            // 대상·점수의 정의는 standings() 가 소유한다 — 라이브 랭킹보드(#319)도 같은 함수를
            // 지나므로 "지금 보이는 표"와 "보상이 나가는 표"가 구조적으로 갈라지지 않는다.
            List<SeasonStanding> standings = standings(season.startedAt(), season.endsAt());

            String now = Instant.now(clock).toString();
            for (int i = 0; i < standings.size(); i++) {
                SeasonStanding st = standings.get(i);
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

            // 초기화 — ⚠️ **0 이 아니라 "다음 시즌 몫"으로** 되돌린다(독립검증 MAJ-1).
            // 스윕이 5분 주기라 `ends_at` 이후~마감 사이에 끝난 원정이 있고, 그 델타는 **다음 시즌**
            // 것이다. 통째로 0 으로 밀면 그 판이 라이브 레이팅(밴드 매칭·리더보드·화면)에서만 사라져
            // 시즌 축과 영구히 어긋난다(보상 금액은 맞는데 화면만 틀리는, 복구 경로 없는 상태).
            jdbcClient.sql("""
                            UPDATE user_ratings SET rating = COALESCE((
                                SELECT SUM(l.delta) FROM rating_ledger l
                                 WHERE l.user_id = user_ratings.user_id
                                   AND datetime(l.created_at) >= datetime(?)
                            ), 0), updated_at = ?
                            """)
                    .params(season.endsAt(), now)
                    .update();
            jdbcClient.sql("UPDATE away_streaks SET streak = 0, updated_at = ?").param(now).update();

            jdbcClient.sql("UPDATE away_seasons SET state = 'CLOSED', closed_at = ? WHERE id = ?")
                    .params(now, season.id())
                    .update();
            // 다음 시즌은 이 시즌이 **끝난 시각**부터 — 밀린 주를 건너뛰지 않게(MIN-4).
            openNext(season.seasonNo(), parseTime(season.endsAt()));
            log.info("away season {} closed — {} standings settled", season.seasonNo(), standings.size());
        });
    }

    /**
     * 한 시즌 창의 순위표. <b>시즌 마감(보상)과 라이브 랭킹보드(#319)가 같이 쓴다</b> — 두 곳에서
     * 각자 집계하면 "1등으로 보였는데 보상은 3등"이 되고, 그건 원장이 있어도 복구가 안 되는 종류의
     * 불일치다.
     *
     * <p>⚠️ <b>참가와 점수의 출처가 다르다</b>(둘 다 실패해 본 자리다):
     * <ul>
     *   <li>참가 = 창 안의 <b>비-몰수 {@code away_reports}</b>(공격자·수비자 양쪽, 정산마다 정확히 1행).
     *       예전엔 {@code rating_ledger} 존재로 물었는데 ① 상한이 없어 밀린 시즌을 닫을 때 그 뒤에
     *       생긴 원장까지 참가로 잡혀 <b>아무도 안 논 주에 1~3위 보상</b>이 나갔고(실측 1판 = 20만
     *       포인트 발행) ② 무승부는 원장 행이 없어 비기기만 한 유저가 시즌에서 통째로 사라졌다.</li>
     *   <li>점수 = 창 안의 <b>{@code rating_ledger} 합</b>. {@code user_ratings}(창 없는 누적)로 매기면
     *       참가 축과 어긋난다 — 실측에서 <b>3패한 유저가 1위, 3승한 유저가 2위</b>였다(앞 시즌
     *       리셋으로 전원 동점 → tie-break 인 ULID = 가입 순이 순위를 정했다).</li>
     * </ul>
     *
     * <p>시각 비교는 {@code datetime()} 으로 정규화한다 — ISO 문자열은 소수초가 붙으면
     * ({@code …00.123Z}) 안 붙은 값보다 작게 정렬된다('.' &lt; 'Z').
     *
     * @param nickname·streak 는 마감 경로에선 쓰이지 않는다(스냅샷은 id·rating·bestStreak 만 박제).
     *     라이브 보드가 필요로 해서 같은 쿼리에 실었다 — 조인을 따로 두면 두 표가 갈라질 자리가 생긴다.
     */
    public List<SeasonStanding> standings(String from, String to) {
        return jdbcClient.sql("""
                        SELECT p.user_id AS user_id,
                               COALESCE(u.nickname, '알 수 없음') AS nickname,
                               COALESCE((
                                   SELECT SUM(l.delta) FROM rating_ledger l
                                    WHERE l.user_id = p.user_id
                                      AND datetime(l.created_at) >= datetime(:from)
                                      AND datetime(l.created_at) <  datetime(:to)
                               ), 0) AS rating,
                               COALESCE(st.best_streak, 0) AS best_streak,
                               COALESCE(st.streak, 0) AS streak
                        FROM (
                            SELECT defender_id AS user_id FROM away_reports
                             WHERE datetime(created_at) >= datetime(:from)
                               AND datetime(created_at) <  datetime(:to)
                               AND forfeit = 0
                            UNION
                            SELECT attacker_id AS user_id FROM away_reports
                             WHERE datetime(created_at) >= datetime(:from)
                               AND datetime(created_at) <  datetime(:to)
                               AND forfeit = 0
                        ) p
                        LEFT JOIN away_streaks st ON st.user_id = p.user_id
                        LEFT JOIN users u ON u.id = p.user_id
                        ORDER BY rating DESC, p.user_id ASC
                        """)
                .param("from", from)
                .param("to", to)
                .query((rs, n) -> new SeasonStanding(rs.getString("user_id"), rs.getString("nickname"),
                        rs.getInt("rating"), rs.getInt("best_streak"), rs.getInt("streak")))
                .list();
    }

    /**
     * 이 시즌 창에서 <b>내 레이팅 변동 합</b>. 순위표에 없는 유저(=이번 주 원정 0판)의 표시값으로만 쓴다.
     *
     * <p>0 을 그냥 내보내지 않는 이유: 몰수만 있었던 유저는 참가로는 안 잡히지만 ±10 은 실제로
     * 움직였다(hero D1 — 몰수의 벌칙). 그 사람에게 0 을 보여주면 화면이 원장과 다른 말을 한다.
     */
    public int seasonRatingOf(String userId, String from, String to) {
        return jdbcClient.sql("""
                        SELECT COALESCE(SUM(delta), 0) FROM rating_ledger
                         WHERE user_id = ?
                           AND datetime(created_at) >= datetime(?)
                           AND datetime(created_at) <  datetime(?)
                        """)
                .params(userId, from, to)
                .query(Integer.class)
                .single();
    }

    /** @param streak 현재 연승(라이브 보드용) · @param bestStreak 시즌 최고(마감 스냅샷용). */
    public record SeasonStanding(String userId, String nickname, int rating, int bestStreak,
                                 int streak) {
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
