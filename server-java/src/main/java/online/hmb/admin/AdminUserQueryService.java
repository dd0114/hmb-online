package online.hmb.admin;

import java.util.List;
import online.hmb.common.ApiException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * admin 유저 조회(AC-C1 "유저 상태 조회 — 보유·덱·전적"). 읽기 전용.
 *
 * <p><b>비번은 어떤 응답에도 들어가지 않는다</b>(AC-A2 연장): 이 클래스의 SELECT 는
 * {@code users.password} 를 <b>한 번도 나열하지 않고</b>, DTO 에도 그 필드가 없다.
 * {@code SELECT *} 를 쓰지 않는 이유가 그것이다 — 컬럼을 명시하면 새 비밀 컬럼이 추가돼도
 * 자동으로 응답에 실리지 않는다. 테스트가 응답 <b>원문</b>에서 비번 문자열을 검색해 재확인한다.
 *
 * <p>전적·지갑은 기존 도메인과 같은 파생 규칙을 쓴다({@code matches} GROUP BY result, {@code wallets}).
 */
@Service
public class AdminUserQueryService {

    /** 페이지 크기 상한 — 무제한 스캔 방지(운영 도구라도 전량 덤프는 막는다). */
    private static final int MAX_LIMIT = 200;
    private static final int DEFAULT_LIMIT = 50;

    private final JdbcClient jdbcClient;

    public AdminUserQueryService(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public UserPage list(String query, Integer limit, Integer offset) {
        int effLimit = clamp(limit == null ? DEFAULT_LIMIT : limit, 1, MAX_LIMIT);
        int effOffset = Math.max(0, offset == null ? 0 : offset);
        // LIKE 와일드카드(%, _)를 리터럴로 취급 — 검색어 '%' 하나로 전량 매칭되는 걸 막는다.
        String like = "%" + escapeLike(query == null ? "" : query.trim()) + "%";

        long total = jdbcClient.sql("SELECT COUNT(*) FROM users WHERE nickname LIKE ? ESCAPE '\\'")
                .param(like)
                .query(Long.class)
                .single();

        List<UserRow> items = jdbcClient.sql("""
                        SELECT u.id, u.nickname, u.auth_provider, u.is_admin, u.created_at,
                               COALESCE(w.points, 0) AS points
                        FROM users u LEFT JOIN wallets w ON w.user_id = u.id
                        WHERE u.nickname LIKE ? ESCAPE '\\'
                        ORDER BY u.created_at DESC, u.id DESC
                        LIMIT ? OFFSET ?
                        """)
                .params(like, effLimit, effOffset)
                .query((rs, rowNum) -> new UserRow(
                        rs.getString("id"),
                        rs.getString("nickname"),
                        rs.getString("auth_provider"),
                        rs.getInt("is_admin") != 0,
                        rs.getLong("points"),
                        rs.getString("created_at")))
                .list();

        return new UserPage(items, total, effLimit, effOffset);
    }

    public UserDetail detail(String userId) {
        UserRow user = jdbcClient.sql("""
                        SELECT u.id, u.nickname, u.auth_provider, u.is_admin, u.created_at,
                               COALESCE(w.points, 0) AS points
                        FROM users u LEFT JOIN wallets w ON w.user_id = u.id
                        WHERE u.id = ?
                        """)
                .param(userId)
                .query((rs, rowNum) -> new UserRow(
                        rs.getString("id"),
                        rs.getString("nickname"),
                        rs.getString("auth_provider"),
                        rs.getInt("is_admin") != 0,
                        rs.getLong("points"),
                        rs.getString("created_at")))
                .optional()
                .orElseThrow(() -> ApiException.notFound("유저를 찾을 수 없습니다"));

        long distinctPlayers = countOne("SELECT COUNT(*) FROM user_players WHERE user_id = ?", userId);
        long totalPlayers = countOne("SELECT COALESCE(SUM(count), 0) FROM user_players WHERE user_id = ?", userId);
        long presets = countOne("SELECT COUNT(*) FROM prompt_presets WHERE user_id = ?", userId);
        long teamPresets = countOne("SELECT COUNT(*) FROM team_presets WHERE user_id = ?", userId);

        DeckSummary deck = jdbcClient.sql("""
                        SELECT d.id, d.name, d.formation, d.updated_at,
                               (SELECT COUNT(*) FROM deck_slots s WHERE s.deck_id = d.id AND s.role = 'starter') AS starters,
                               (SELECT COUNT(*) FROM deck_slots s WHERE s.deck_id = d.id AND s.role = 'bench') AS bench
                        FROM decks d WHERE d.user_id = ? AND d.is_active = 1
                        """)
                .param(userId)
                .query((rs, rowNum) -> new DeckSummary(
                        rs.getString("id"), rs.getString("name"), rs.getString("formation"),
                        rs.getInt("starters"), rs.getInt("bench"), rs.getString("updated_at")))
                .optional()
                .orElse(null);

        long wins = countOne("SELECT COUNT(*) FROM matches WHERE user_id = ? AND result = 'WIN'", userId);
        long draws = countOne("SELECT COUNT(*) FROM matches WHERE user_id = ? AND result = 'DRAW'", userId);
        long losses = countOne("SELECT COUNT(*) FROM matches WHERE user_id = ? AND result = 'LOSS'", userId);

        return new UserDetail(user,
                new PlayerHoldings(distinctPlayers, totalPlayers),
                deck,
                new PresetSummary(presets, teamPresets),
                new Records(wins, draws, losses));
    }

    /** 대상 유저 존재 확인(포인트 지급 전 404 판정). */
    public boolean exists(String userId) {
        return countOne("SELECT COUNT(*) FROM users WHERE id = ?", userId) > 0;
    }

    private long countOne(String sql, String userId) {
        return jdbcClient.sql(sql).param(userId).query(Long.class).single();
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(v, max));
    }

    private static String escapeLike(String raw) {
        return raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    /** 비번 필드 없음 — 이 record 에 password 를 추가하는 순간 테스트가 깨진다. */
    public record UserRow(String id, String nickname, String authProvider, boolean isAdmin,
                          long points, String createdAt) {
    }

    public record UserPage(List<UserRow> items, long total, int limit, int offset) {
    }

    public record PlayerHoldings(long distinct, long total) {
    }

    public record DeckSummary(String id, String name, String formation, int starters, int bench, String updatedAt) {
    }

    public record PresetSummary(long promptPresets, long teamPresets) {
    }

    public record Records(long wins, long draws, long losses) {
    }

    public record UserDetail(UserRow user, PlayerHoldings players, DeckSummary deck,
                             PresetSummary presets, Records records) {
    }
}
