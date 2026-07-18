package online.hmb.meta;

import java.util.List;
import java.util.Map;
import online.hmb.common.ApiException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/me — user + wallet.points + records{wins,draws,losses}(matches 파생, LLD §4).
 * GET /api/me/matches — 전적 리스트(최근 20).
 * 전적은 별도 테이블 없이 matches에서 COUNT by result로 파생(ERD 설계 노트).
 */
@RestController
public class MeController {

    private final JdbcClient jdbcClient;
    private final WalletService walletService;

    public MeController(JdbcClient jdbcClient, WalletService walletService) {
        this.jdbcClient = jdbcClient;
        this.walletService = walletService;
    }

    @GetMapping("/api/me")
    public MeResponse me(@RequestAttribute("userId") String userId) {
        String nickname = jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(userId)
                .query(String.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("유저를 찾을 수 없습니다"));

        long points = walletService.points(userId);

        Map<String, Long> byResult = new java.util.HashMap<>();
        jdbcClient.sql("""
                        SELECT result, COUNT(*) AS cnt FROM matches
                        WHERE user_id = ? AND result IS NOT NULL
                        GROUP BY result
                        """)
                .param(userId)
                .query((rs, rowNum) -> Map.entry(rs.getString("result"), rs.getLong("cnt")))
                .list()
                .forEach(e -> byResult.put(e.getKey(), e.getValue()));

        return new MeResponse(
                new UserRef(userId, nickname),
                new WalletInfo(points),
                new Records(
                        byResult.getOrDefault("WIN", 0L),
                        byResult.getOrDefault("DRAW", 0L),
                        byResult.getOrDefault("LOSS", 0L)));
    }

    @GetMapping("/api/me/matches")
    public List<MatchListItem> myMatches(@RequestAttribute("userId") String userId,
                                          @RequestParam(name = "limit", defaultValue = "20") int limit) {
        int effectiveLimit = Math.max(1, Math.min(limit, 100));
        // W4 orient(additive): score_home/away 는 픽스처(=엔진) 관점 저장이라, 어웨이 유저 리그경기는
        // 유저 득점=away 슬롯. userWasHome 플래그를 additive 로 실어 소비자가 오리엔트하게 한다(breaking 아님).
        return jdbcClient.sql("""
                        SELECT m.id, b.name AS opponent_name, m.score_home, m.score_away, m.result,
                               m.league_fixture_id AS lfid, lf.home_team AS fixture_home, m.created_at
                        FROM matches m JOIN bots b ON b.id = m.bot_id
                        LEFT JOIN league_fixtures lf ON lf.id = m.league_fixture_id
                        WHERE m.user_id = ?
                        ORDER BY m.created_at DESC
                        LIMIT ?
                        """)
                .params(userId, effectiveLimit)
                .query((rs, rowNum) -> new MatchListItem(
                        rs.getString("id"),
                        rs.getString("opponent_name"),
                        (Integer) rs.getObject("score_home"),
                        (Integer) rs.getObject("score_away"),
                        rs.getString("result"),
                        rs.getString("lfid") == null || "USER".equals(rs.getString("fixture_home")),
                        rs.getString("created_at")))
                .list();
    }

    public record UserRef(String id, String nickname) {
    }

    public record WalletInfo(long points) {
    }

    public record Records(long wins, long draws, long losses) {
    }

    public record MeResponse(UserRef user, WalletInfo wallet, Records records) {
    }

    public record MatchListItem(String id, String opponentName, Integer scoreHome, Integer scoreAway,
                                 String result, boolean userWasHome, String createdAt) {
    }
}
