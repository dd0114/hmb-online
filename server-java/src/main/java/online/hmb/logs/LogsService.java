package online.hmb.logs;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import online.hmb.common.ApiException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 로그 탭 (AC-E1/E3, LLD-p2-server §7). 경기 기록 + 트레이드 이력 읽기 전용 조회.
 *
 * <p><b>유저 관점 오리엔트</b>(W3 이월 minor-1): {@code matches.score_home/score_away} 는 픽스처(=엔진)
 * 관점으로 저장된다(어웨이 유저 리그경기는 home=봇 득점). openapi-v2 {@code MatchLogItem.scoreHome/scoreAway}
 * 도 픽스처 관점이므로, additive 필드 {@code userWasHome} 를 계산해 실어보내 소비자(web)가
 * {@code 유저득점 = userWasHome ? scoreHome : scoreAway} 로 오리엔트한다. {@code matches.result} 는 이미
 * 유저 관점(finishMatch 에서 flip 반영). 연습·유저홈 리그경기는 {@code userWasHome=true} 라 불변.
 */
@Service
public class LogsService {

    private static final int MATCH_LIMIT_DEFAULT = 30;
    private static final int MATCH_LIMIT_MAX = 100;
    private static final int TRADE_LIMIT_DEFAULT = 30;
    private static final int TRADE_LIMIT_MAX = 100;

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public LogsService(JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    // ── DTO (openapi-v2) ─────────────────────────────────────────────────

    public record MatchLogItem(String id, String mode, String opponentName, Integer scoreHome,
                               Integer scoreAway, String result, Integer seasonNo, Integer round,
                               boolean userWasHome, boolean hasHalves, String createdAt) {
    }

    public record TradeLogItem(long id, String kind, String result, JsonNode detail, String createdAt) {
    }

    // ── GET /api/logs/matches (AC-E1) ────────────────────────────────────

    /**
     * 유저 경기 기록(모드·시즌 필터). 최신순, 유저 관점 스코어 오리엔트 플래그 + 상세 재생 링크용
     * matchId(=id)·hasHalves 포함. season 필터가 있으면 리그 경기만(해당 season_no) 반환.
     */
    public List<MatchLogItem> listMatches(String userId, String mode, Integer season, int limit) {
        if (mode != null && !mode.equals("practice") && !mode.equals("league")) {
            throw ApiException.validation("mode 는 practice|league 만 허용됩니다: " + mode);
        }
        int effectiveLimit = clamp(limit, MATCH_LIMIT_DEFAULT, MATCH_LIMIT_MAX);

        StringBuilder sql = new StringBuilder("""
                SELECT m.id AS id, m.mode AS mode, b.name AS opponent_name,
                       m.score_home AS score_home, m.score_away AS score_away, m.result AS result,
                       ls.season_no AS season_no, lf.round AS round, lf.home_team AS fixture_home,
                       m.league_fixture_id AS league_fixture_id, m.created_at AS created_at,
                       EXISTS(SELECT 1 FROM match_halves mh WHERE mh.match_id = m.id) AS has_halves
                FROM matches m
                JOIN bots b ON b.id = m.bot_id
                LEFT JOIN league_fixtures lf ON lf.id = m.league_fixture_id
                LEFT JOIN league_seasons ls ON ls.id = lf.season_id
                WHERE m.user_id = ?
                """);
        List<Object> params = new ArrayList<>();
        params.add(userId);
        if (mode != null) {
            sql.append(" AND m.mode = ?");
            params.add(mode);
        }
        if (season != null) {
            sql.append(" AND ls.season_no = ?");
            params.add(season);
        }
        sql.append(" ORDER BY m.created_at DESC, m.id DESC LIMIT ?");
        params.add(effectiveLimit);

        return jdbcClient.sql(sql.toString())
                .params(params)
                .query((rs, n) -> {
                    String leagueFixtureId = rs.getString("league_fixture_id");
                    String fixtureHome = rs.getString("fixture_home");
                    // 유저 관점: 연습/픽스처 없음이면 홈, 리그면 픽스처 home_team=='USER' 여부.
                    boolean userWasHome = leagueFixtureId == null || "USER".equals(fixtureHome);
                    Integer seasonNo = (Integer) rs.getObject("season_no");
                    Integer round = (Integer) rs.getObject("round");
                    return new MatchLogItem(
                            rs.getString("id"),
                            rs.getString("mode"),
                            rs.getString("opponent_name"),
                            (Integer) rs.getObject("score_home"),
                            (Integer) rs.getObject("score_away"),
                            rs.getString("result"),
                            seasonNo,
                            round,
                            userWasHome,
                            rs.getInt("has_halves") == 1,
                            rs.getString("created_at"));
                })
                .list();
    }

    // ── GET /api/logs/trades (AC-E3) ─────────────────────────────────────

    /** 트레이드 이력(성공/실패/거절/만료 + detail). 최신(id DESC)순, limit 페이지네이션(계약=limit 만). */
    public List<TradeLogItem> listTrades(String userId, int limit) {
        int effectiveLimit = clamp(limit, TRADE_LIMIT_DEFAULT, TRADE_LIMIT_MAX);
        return jdbcClient.sql("""
                        SELECT id, kind, result, detail_json, created_at
                        FROM trade_log
                        WHERE user_id = ?
                        ORDER BY id DESC
                        LIMIT ?
                        """)
                .params(userId, effectiveLimit)
                .query((rs, n) -> new TradeLogItem(
                        rs.getLong("id"),
                        rs.getString("kind"),
                        rs.getString("result"),
                        parseDetail(rs.getString("detail_json")),
                        rs.getString("created_at")))
                .list();
    }

    private JsonNode parseDetail(String detailJson) {
        try {
            return objectMapper.readTree(detailJson == null ? "{}" : detailJson);
        } catch (Exception e) {
            throw new IllegalStateException("trade_log detail 파싱 실패", e);
        }
    }

    private static int clamp(int value, int fallback, int max) {
        if (value <= 0) {
            return Math.min(fallback, max);
        }
        return Math.min(value, max);
    }
}
