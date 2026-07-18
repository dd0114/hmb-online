package online.hmb.match;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.common.TxRunner;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 감독 관계(AC-C4, LLD-p2-server §4) — 선수 신뢰도(trust 0..100) + 팀 사기(morale 0..100/streak).
 *
 * <p>변동 규칙(config {@code hmb.relation.*}, 하드코딩 금지):
 * <ul>
 *   <li>선발 기용 +{@code starterBonus}</li>
 *   <li>승리 전원(선발+벤치) +{@code winBonus} / 패배 전원 {@code lossPenalty}</li>
 *   <li>교체 아웃 {@code subOutPenalty}</li>
 *   <li>결장 연속 {@code absentStreakThreshold} 경기째부터 {@code absentStreakPenalty}/경기</li>
 *   <li>사기: 승 +{@code moraleWin} / 무 +{@code moraleDraw} / 패 {@code moraleLoss}, streak 부호 갱신</li>
 * </ul>
 *
 * <p><b>멱등</b>: FINISHED 전이 트랜잭션에서 {@code matches.relations_applied} 플래그 CAS 로 정확히
 * 1회만 적용(관계 변동 이력 테이블 없이 — LLD §4). 재호출은 no-op.
 */
@Service
public class RelationService {

    private static final int TRUST_DEFAULT = 50;
    private static final int MORALE_DEFAULT = 50;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;

    private final int starterBonus;
    private final int winBonus;
    private final int lossPenalty;
    private final int subOutPenalty;
    private final int absentStreakPenalty;
    private final int absentStreakThreshold;
    private final int moraleWin;
    private final int moraleDraw;
    private final int moraleLoss;

    public RelationService(JdbcClient jdbcClient,
                           TxRunner txRunner,
                           ObjectMapper objectMapper,
                           @Value("${hmb.relation.starter-bonus}") int starterBonus,
                           @Value("${hmb.relation.win-bonus}") int winBonus,
                           @Value("${hmb.relation.loss-penalty}") int lossPenalty,
                           @Value("${hmb.relation.sub-out-penalty}") int subOutPenalty,
                           @Value("${hmb.relation.absent-streak-penalty}") int absentStreakPenalty,
                           @Value("${hmb.relation.absent-streak-threshold}") int absentStreakThreshold,
                           @Value("${hmb.relation.morale-win}") int moraleWin,
                           @Value("${hmb.relation.morale-draw}") int moraleDraw,
                           @Value("${hmb.relation.morale-loss}") int moraleLoss) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.starterBonus = starterBonus;
        this.winBonus = winBonus;
        this.lossPenalty = lossPenalty;
        this.subOutPenalty = subOutPenalty;
        this.absentStreakPenalty = absentStreakPenalty;
        this.absentStreakThreshold = absentStreakThreshold;
        this.moraleWin = moraleWin;
        this.moraleDraw = moraleDraw;
        this.moraleLoss = moraleLoss;
    }

    // ── 초기화 (첫 로그인) ──────────────────────────────────────────────

    /**
     * 첫 로그인 초기화(AC-C4): team_morale 기본 행 + 보유 선수 신뢰도 기본 행 생성.
     * INSERT OR IGNORE 라 재로그인/재호출에도 멱등. 호출자(MockOAuthProvider)의 신규유저 tx 안에서 실행.
     */
    public void initForUser(String userId) {
        String now = Instant.now().toString();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO team_morale(user_id, morale, streak, updated_at)
                        VALUES (?, ?, 0, ?)
                        """)
                .params(userId, MORALE_DEFAULT, now)
                .update();
        for (String playerId : ownedPlayers(userId)) {
            ensureRelationRow(userId, playerId, now);
        }
    }

    private void ensureRelationRow(String userId, String playerId, String now) {
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO player_relations(user_id, player_id, trust, updated_at)
                        VALUES (?, ?, ?, ?)
                        """)
                .params(userId, playerId, TRUST_DEFAULT, now)
                .update();
    }

    // ── 조회 (GET /api/relations) ───────────────────────────────────────

    public record PlayerRelation(String playerId, int trust, String personality) {
    }

    public record Relations(int morale, int streak, List<PlayerRelation> players) {
    }

    /**
     * GET /api/relations 응답(openapi-v2 RelationsResponse): morale/streak + 보유 선수별 신뢰도·성격.
     * 신뢰도 행이 없으면 기본 {@value #TRUST_DEFAULT}(lazy default). 성격은 players.personality.
     */
    public Relations getRelations(String userId) {
        Morale m = moraleOf(userId);
        List<PlayerRelation> players = jdbcClient.sql("""
                        SELECT up.player_id AS pid,
                               COALESCE(pr.trust, ?) AS trust,
                               p.personality AS personality
                        FROM user_players up
                        JOIN players p ON p.id = up.player_id
                        LEFT JOIN player_relations pr ON pr.user_id = up.user_id AND pr.player_id = up.player_id
                        WHERE up.user_id = ?
                        ORDER BY up.player_id
                        """)
                .params(TRUST_DEFAULT, userId)
                .query((rs, n) -> new PlayerRelation(
                        rs.getString("pid"), rs.getInt("trust"), rs.getString("personality")))
                .list();
        return new Relations(m.morale(), m.streak(), players);
    }

    /** AI 컨텍스트용 관계 맵 {playerId: {trust, personality}} — 지정 선수(로스터)만. */
    public Map<String, Map<String, Object>> relationContextFor(String userId, List<String> playerIds) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        if (playerIds == null || playerIds.isEmpty()) {
            return out;
        }
        String in = String.join(",", playerIds.stream().map(p -> "?").toList());
        List<Object> params = new ArrayList<>();
        params.add(TRUST_DEFAULT);
        params.add(userId);
        params.addAll(playerIds);
        jdbcClient.sql("""
                        SELECT p.id AS pid, COALESCE(pr.trust, ?) AS trust, p.personality AS personality
                        FROM players p
                        LEFT JOIN player_relations pr ON pr.player_id = p.id AND pr.user_id = ?
                        WHERE p.id IN (""" + in + ")")
                .params(params)
                .query((rs, n) -> Map.entry(rs.getString("pid"),
                        (Map<String, Object>) new LinkedHashMap<String, Object>(Map.of(
                                "trust", rs.getInt("trust"),
                                "personality", rs.getString("personality")))))
                .list()
                .forEach(e -> out.put(e.getKey(), e.getValue()));
        return out;
    }

    public record Morale(int morale, int streak) {
    }

    /** team_morale 행 — 없으면 기본값(초기화 누락 방어). */
    public Morale moraleOf(String userId) {
        return jdbcClient.sql("SELECT morale, streak FROM team_morale WHERE user_id = ?")
                .param(userId)
                .query((rs, n) -> new Morale(rs.getInt("morale"), rs.getInt("streak")))
                .optional()
                .orElse(new Morale(MORALE_DEFAULT, 0));
    }

    // ── 매치 결과 적용 (FINISHED 트랜잭션, 멱등) ─────────────────────────

    /**
     * 매치 결과 관계/사기 변동 — {@code matches.relations_applied} CAS 로 정확히 1회 적용.
     * 이미 적용됐으면(재호출) 아무것도 하지 않는다(멱등). result ∈ {WIN,DRAW,LOSS}.
     */
    public void applyMatchResult(String userId, String matchId, String result) {
        // 멱등 게이트: 0→1 로 바꾼 요청만 실제 적용을 수행.
        int claimed = jdbcClient.sql(
                        "UPDATE matches SET relations_applied = 1 WHERE id = ? AND relations_applied = 0")
                .params(matchId)
                .update();
        if (claimed != 1) {
            return; // 이미 적용됨 — 중복 금지
        }

        MatchSquad squad = squadOf(matchId);
        String now = Instant.now().toString();

        // 1) 신뢰도 델타 누적(선수별) → clamp 후 1회 반영.
        Map<String, Integer> delta = new LinkedHashMap<>();
        for (String pid : squad.starters()) {
            delta.merge(pid, starterBonus, Integer::sum);
        }
        for (String out : squad.subsOut()) {
            delta.merge(out, subOutPenalty, Integer::sum);
        }
        if ("WIN".equals(result)) {
            for (String pid : squad.rosterAll()) {
                delta.merge(pid, winBonus, Integer::sum);
            }
        } else if ("LOSS".equals(result)) {
            for (String pid : squad.rosterAll()) {
                delta.merge(pid, lossPenalty, Integer::sum);
            }
        }
        // 결장 연속(threshold 경기째부터): 보유 선수 중 이번 매치 로스터 미포함 + 직전 연속결장 streak≥threshold.
        applyAbsenceStreak(userId, matchId, squad.rosterAll(), delta);

        for (Map.Entry<String, Integer> e : delta.entrySet()) {
            ensureRelationRow(userId, e.getKey(), now);
            jdbcClient.sql("""
                            UPDATE player_relations
                            SET trust = MAX(0, MIN(100, trust + ?)), updated_at = ?
                            WHERE user_id = ? AND player_id = ?
                            """)
                    .params(e.getValue(), now, userId, e.getKey())
                    .update();
        }

        // 2) 사기/연승연패.
        Morale cur = moraleOf(userId);
        int moraleDelta = switch (result) {
            case "WIN" -> moraleWin;
            case "LOSS" -> moraleLoss;
            default -> moraleDraw;
        };
        int newMorale = Math.max(0, Math.min(100, cur.morale() + moraleDelta));
        int newStreak = switch (result) {
            case "WIN" -> cur.streak() >= 0 ? cur.streak() + 1 : 1;
            case "LOSS" -> cur.streak() <= 0 ? cur.streak() - 1 : -1;
            default -> 0; // 무승부는 연승/연패 종료
        };
        jdbcClient.sql("""
                        INSERT INTO team_morale(user_id, morale, streak, updated_at) VALUES (?, ?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET morale = excluded.morale,
                             streak = excluded.streak, updated_at = excluded.updated_at
                        """)
                .params(userId, newMorale, newStreak, now)
                .update();
    }

    /** 결장 연속 streak 페널티 — 보유 선수 중 현재 로스터 미포함 선수의 연속결장 길이 계산. */
    private void applyAbsenceStreak(String userId, String matchId, Set<String> currentRoster,
                                    Map<String, Integer> delta) {
        List<Set<String>> priorRosters = priorFinishedRosters(userId, matchId);
        for (String pid : ownedPlayers(userId)) {
            if (currentRoster.contains(pid)) {
                continue; // 이번 경기 출전(로스터 포함) — 결장 아님
            }
            // 연속결장 = 이번(1) + 직전부터 연속으로 미포함인 경기 수. present 만나면 중단.
            int streak = 1;
            for (Set<String> roster : priorRosters) {
                if (roster.contains(pid)) {
                    break;
                }
                streak++;
            }
            if (streak >= absentStreakThreshold) {
                delta.merge(pid, absentStreakPenalty, Integer::sum);
            }
        }
    }

    // ── 내부 조회 ────────────────────────────────────────────────────────

    private record MatchSquad(Set<String> starters, Set<String> bench, Set<String> subsOut) {
        Set<String> rosterAll() {
            Set<String> all = new HashSet<>(starters);
            all.addAll(bench);
            return all;
        }
    }

    private MatchSquad squadOf(String matchId) {
        String deckJson = jdbcClient.sql("SELECT user_deck_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        String subsJson = jdbcClient.sql("SELECT subs_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).optional().orElse(null);
        JsonNode snapshot = readJson(deckJson);
        Set<String> starters = new HashSet<>();
        Set<String> bench = new HashSet<>();
        snapshot.path("starters").forEach(s -> starters.add(s.path("playerId").asText()));
        snapshot.path("bench").forEach(b -> bench.add(b.path("playerId").asText()));
        Set<String> subsOut = new HashSet<>();
        if (subsJson != null && !subsJson.isBlank()) {
            for (JsonNode sub : readJson(subsJson)) {
                if (sub.hasNonNull("out")) {
                    subsOut.add(sub.path("out").asText());
                }
            }
        }
        return new MatchSquad(starters, bench, subsOut);
    }

    /** 직전 FINISHED 매치들의 로스터(선발+벤치) 집합, 최신순. 현재 매치는 제외. */
    private List<Set<String>> priorFinishedRosters(String userId, String matchId) {
        List<String> deckJsons = jdbcClient.sql("""
                        SELECT user_deck_json FROM matches
                        WHERE user_id = ? AND state = 'FINISHED' AND id <> ?
                        ORDER BY finished_at DESC, created_at DESC
                        LIMIT 30
                        """)
                .params(userId, matchId)
                .query(String.class)
                .list();
        List<Set<String>> rosters = new ArrayList<>();
        for (String deckJson : deckJsons) {
            JsonNode snap = readJson(deckJson);
            Set<String> roster = new HashSet<>();
            snap.path("starters").forEach(s -> roster.add(s.path("playerId").asText()));
            snap.path("bench").forEach(b -> roster.add(b.path("playerId").asText()));
            rosters.add(roster);
        }
        return rosters;
    }

    private List<String> ownedPlayers(String userId) {
        return jdbcClient.sql("SELECT player_id FROM user_players WHERE user_id = ?")
                .param(userId)
                .query(String.class)
                .list();
    }

    private JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("JSON 파싱 실패: " + e.getMessage(), e);
        }
    }
}
