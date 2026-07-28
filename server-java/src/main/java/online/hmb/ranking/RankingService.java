package online.hmb.ranking;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import online.hmb.common.ApiException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 랭킹 (AC-E2, LLD-p2-server §7). 유저 승수/승률 리더보드 + 내 순위 + 개인 기록.
 *
 * <p><b>파생 원칙</b>: 별도 랭킹 테이블 없음(ERD-v2 노트) — 전부 {@code matches}/{@code match_halves}
 * 이벤트에서 재계산한다. 승/승률은 {@code matches.result}(유저 관점) 집계. 개인 기록의 최다 득점 선수는
 * {@code match_halves.match_log_json} 의 goal 이벤트를 유저 사이드(어웨이 리그경기면 away)로 파싱해
 * playerId 별 집계(스키마 PersonalRecords 4필드: topScorer·topScorerGoals·longestWinStreak·totalMatches).
 */
@Service
public class RankingService {

    private static final int LEADERBOARD_DEFAULT = 20;
    private static final int LEADERBOARD_MAX = 100;

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public RankingService(JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    // ── DTO (openapi-v2) ─────────────────────────────────────────────────

    /**
     * rating(#245 D3 additive) = 원정 레이팅. <b>정렬 기준이 승수 → 레이팅으로 바뀌었다</b>(hero 확정).
     * wins·winRate 는 표시로 남는다(기존 화면 무회귀).
     */
    public record RankingEntry(String userId, String nickname, int wins, double winRate, int rank,
                               int rating) {
    }

    public record PlayerRef(String playerId, String name, String position, String grade) {
    }

    public record PersonalRecords(PlayerRef topScorer, Integer topScorerGoals, int longestWinStreak,
                                  int totalMatches) {
    }

    public record RankingsResponse(List<RankingEntry> leaderboard, RankingEntry me,
                                   PersonalRecords personalRecords) {
    }

    // ── GET /api/rankings ────────────────────────────────────────────────

    public RankingsResponse getRankings(String userId, int limit) {
        int effectiveLimit = clamp(limit);
        List<RankingEntry> ranked = rankedUsers();
        RankingEntry me = ranked.stream().filter(e -> e.userId().equals(userId)).findFirst()
                .orElseThrow(() -> ApiException.notFound("유저를 찾을 수 없습니다"));
        List<RankingEntry> leaderboard = ranked.size() > effectiveLimit
                ? new ArrayList<>(ranked.subList(0, effectiveLimit))
                : ranked;
        return new RankingsResponse(leaderboard, me, personalRecords(userId));
    }

    // ── 리더보드(전 유저) — 승수 desc → 승률 desc → 닉네임 asc, 순위=행번호 ──

    /**
     * 리더보드 정렬 = <b>레이팅</b>(#245 D3, hero 확정 — 구 기준은 승수였다).
     *
     * <p>⚠️ tie-break 가 중요하다: 원정을 아직 안 한 유저는 전원 0점이라, 레이팅만으로 정렬하면 표가
     * 통째로 평평해져 순위가 무의미해진다. 동점이면 <b>승수 → 승률 → 닉네임</b> 순으로 계속 가른다
     * (= 구 기준이 tie-break 로 살아 있다). 결정론적이라 같은 데이터면 같은 표다.
     */
    private List<RankingEntry> rankedUsers() {
        record Agg(String userId, String nickname, int wins, int total, int rating) {
        }
        List<Agg> aggs = jdbcClient.sql("""
                        SELECT u.id AS user_id, u.nickname AS nickname,
                               SUM(CASE WHEN m.result = 'WIN' THEN 1 ELSE 0 END) AS wins,
                               SUM(CASE WHEN m.result IS NOT NULL THEN 1 ELSE 0 END) AS total,
                               COALESCE((SELECT r.rating FROM user_ratings r WHERE r.user_id = u.id), 0)
                                   AS rating
                        FROM users u
                        LEFT JOIN matches m ON m.user_id = u.id
                        GROUP BY u.id, u.nickname
                        """)
                .query((rs, n) -> new Agg(rs.getString("user_id"), rs.getString("nickname"),
                        rs.getInt("wins"), rs.getInt("total"), rs.getInt("rating")))
                .list();

        List<RankingEntry> entries = new ArrayList<>();
        for (Agg a : aggs) {
            double winRate = a.total() == 0 ? 0.0 : (double) a.wins() / a.total();
            entries.add(new RankingEntry(a.userId(), a.nickname(), a.wins(), winRate, 0, a.rating()));
        }
        entries.sort(Comparator.comparingInt(RankingEntry::rating).reversed()
                .thenComparing(Comparator.comparingInt(RankingEntry::wins).reversed())
                .thenComparing(Comparator.comparingDouble(RankingEntry::winRate).reversed())
                .thenComparing(RankingEntry::nickname));
        List<RankingEntry> ranked = new ArrayList<>(entries.size());
        for (int i = 0; i < entries.size(); i++) {
            RankingEntry e = entries.get(i);
            ranked.add(new RankingEntry(e.userId(), e.nickname(), e.wins(), e.winRate(), i + 1,
                    e.rating()));
        }
        return ranked;
    }

    // ── 개인 기록(매치 이벤트 파생) ───────────────────────────────────────

    private PersonalRecords personalRecords(String userId) {
        // (1) 유저 매치 + 사이드(어웨이 리그경기면 away). 최신순 결과열은 연승 계산에 사용.
        record MatchRow(String id, String result, boolean userWasHome, String createdAt) {
        }
        List<MatchRow> matches = jdbcClient.sql("""
                        SELECT m.id AS id, m.result AS result, m.league_fixture_id AS lfid,
                               lf.home_team AS fixture_home, m.created_at AS created_at
                        FROM matches m
                        LEFT JOIN league_fixtures lf ON lf.id = m.league_fixture_id
                        WHERE m.user_id = ? AND m.result IS NOT NULL
                        ORDER BY m.created_at ASC, m.id ASC
                        """)
                .param(userId)
                .query((rs, n) -> new MatchRow(rs.getString("id"), rs.getString("result"),
                        rs.getString("lfid") == null || "USER".equals(rs.getString("fixture_home")),
                        rs.getString("created_at")))
                .list();

        int totalMatches = matches.size();
        int longestWinStreak = longestWinStreak(matches.stream().map(MatchRow::result).toList());

        // (2) goal 이벤트 파싱 → 유저 사이드 득점 playerId 집계.
        Map<String, Integer> goalsByPlayer = new LinkedHashMap<>();
        for (MatchRow m : matches) {
            String userSide = m.userWasHome() ? "home" : "away";
            for (String logJson : halfLogs(m.id())) {
                accumulateGoals(logJson, userSide, goalsByPlayer);
            }
        }

        TopScorer top = resolveTopScorer(goalsByPlayer);
        return new PersonalRecords(top == null ? null : top.ref(), top == null ? null : top.goals(),
                longestWinStreak, totalMatches);
    }

    private static int longestWinStreak(List<String> resultsChronological) {
        int longest = 0;
        int current = 0;
        for (String r : resultsChronological) {
            if ("WIN".equals(r)) {
                current++;
                longest = Math.max(longest, current);
            } else {
                current = 0;
            }
        }
        return longest;
    }

    private List<String> halfLogs(String matchId) {
        return jdbcClient.sql("SELECT match_log_json FROM match_halves WHERE match_id = ? ORDER BY half")
                .param(matchId)
                .query(String.class)
                .list();
    }

    /** matchLog 이벤트에서 team==userSide 인 goal 이벤트의 playerId 를 집계 맵에 누적. */
    private void accumulateGoals(String logJson, String userSide, Map<String, Integer> goalsByPlayer) {
        JsonNode events;
        try {
            events = objectMapper.readTree(logJson).path("events");
        } catch (Exception e) {
            return; // 파싱 실패 로그는 스킵(집계에서 제외)
        }
        if (!events.isArray()) {
            return;
        }
        for (JsonNode ev : events) {
            if (!"goal".equals(ev.path("type").asText())) {
                continue;
            }
            if (!userSide.equals(ev.path("team").asText())) {
                continue;
            }
            String playerId = ev.path("playerId").asText(null);
            if (playerId != null && !playerId.isBlank()) {
                goalsByPlayer.merge(playerId, 1, Integer::sum);
            }
        }
    }

    private record TopScorer(PlayerRef ref, int goals) {
    }

    /**
     * 최다 득점 선수 — 득점 수 desc → playerId asc 로 정렬하며 {@code players} 테이블에 존재하는 첫 후보를
     * 고른다(PlayerRef 4필드가 항상 유효하도록). 실전에서 유저 사이드 득점자는 항상 카탈로그 선수라
     * 첫 후보가 곧 최다 득점자다(비존재 스킵은 합성 픽스처 방어).
     */
    private TopScorer resolveTopScorer(Map<String, Integer> goalsByPlayer) {
        List<Map.Entry<String, Integer>> ordered = new ArrayList<>(goalsByPlayer.entrySet());
        ordered.sort(Comparator.<Map.Entry<String, Integer>>comparingInt(Map.Entry::getValue).reversed()
                .thenComparing(Map.Entry::getKey));
        for (Map.Entry<String, Integer> e : ordered) {
            Optional<PlayerRef> ref = playerRef(e.getKey());
            if (ref.isPresent()) {
                return new TopScorer(ref.get(), e.getValue());
            }
        }
        return null;
    }

    private Optional<PlayerRef> playerRef(String playerId) {
        return jdbcClient.sql("SELECT id, name, position, grade FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> new PlayerRef(rs.getString("id"), rs.getString("name"),
                        rs.getString("position"), rs.getString("grade")))
                .optional();
    }

    private static int clamp(int value) {
        if (value <= 0) {
            return LEADERBOARD_DEFAULT;
        }
        return Math.min(value, LEADERBOARD_MAX);
    }
}
