package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.away.AwaySeasonService;
import online.hmb.away.AwayService;
import online.hmb.league.LeagueService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>타 유저 선수단 조회</b> {@code GET /api/users/{targetUserId}/squad} (#432).
 *
 * <p>공개 범위는 hero 확정(2026-08-02 결정 ③ A안) — 이름·포지션·등급·★·OVR·능력치 + <b>"지시 있음"
 * 여부만</b>. 비공개는 <b>네 축</b>이다: 지시문 내용 · 팀 지시 · 팀 전술 · <b>컨디션</b>.
 *
 * <p><b>누설 계약은 두 겹이어야 한다</b>(독립검증 blocker-1):
 * <ol>
 *   <li><b>센티넬</b> — 대상 덱에 고유 문자열을 심고 응답 본문 전체(raw JSON)에 없다고 단언한다.
 *       중첩 객체로 새든 새 필드로 새든 문자열이면 죽는다.</li>
 *   <li><b>키 집합 동결</b> — 응답의 키를 <b>정확집합</b>으로 단언한다. 센티넬만으로는
 *       <b>문자열 축만</b> 지켜진다: 컨디션(숫자)·팀 전술(숫자)은 어느 문자열 대조에도 안 걸리고
 *       이름 블랙리스트에도 없다. 실제로 슬롯에 {@code condition} 을 하나 더 실어도 초판 계약은
 *       7건 전부 green 이었다. 키를 얼리면 <b>새 필드는 기본으로 막힌다</b> —
 *       {@code MatchService.toDetailFor} 의 "지울 것을 열거하지 않고 허용할 것을 열거한다"와 같은 형태다.</li>
 * </ol>
 *
 * <p>자격은 <b>DB 행</b>이다: 현재 유효한 원정 후보 제시 ∪ 나를 친 원정 기록(복수 큐) ∪
 * <b>랭킹보드가 실제로 내주는 목록</b>. 각 절은 <b>다른 절이 꺼진 상태로</b> 검증한다 — 겹쳐 두면
 * 절 하나를 통째로 지워도 계약이 green 이다(초판이 그랬다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class UserSquadApiTest extends MatchTestBase {

    /** 대상 유저의 <b>선수</b> 지시문에만 존재하는 문자열. 응답 어디에도 나오면 안 된다. */
    private static final String PLAYER_SENTINEL = "SENTINEL-PROMPT-9f2a";
    /** 대상 유저의 <b>팀</b> 지시문에만 존재하는 문자열. */
    private static final String TEAM_SENTINEL = "SENTINEL-TEAM-4c1b";

    /** 응답 최상위에 허용된 키 — <b>정확집합</b>. */
    private static final Set<String> SQUAD_KEYS =
            Set.of("userId", "nickname", "rating", "streak", "formation", "slots");
    /** 슬롯 1인에 허용된 키 — <b>정확집합</b>. 컨디션·지시문·성장 진행도는 여기 없다. */
    private static final Set<String> SLOT_KEYS =
            Set.of("playerId", "role", "slotIndex", "name", "position", "grade",
                    "star", "ovr", "attributes", "hasPrompt");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    @Resource
    private AwayService awayService;

    @Resource
    private AwaySeasonService seasonService;

    @Resource
    private LeagueService leagueService;

    @BeforeEach
    void clearPrewarmLedger() {
        jdbcClient.sql("DELETE FROM deck_prewarm").update();
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** 선발 11 + 벤치 2. P002 에만 선수 지시, 덱에 팀 지시 — 둘 다 센티넬이다. */
    private String setupTargetWithSentinelDeck(String nickname) {
        String token = login(nickname);
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(i == 2
                    ? slot("P002", "starter", 1, PLAYER_SENTINEL)
                    : slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, PLAYER_SENTINEL + "-bench"));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("formation", "4-4-2");
        body.put("teamPrompt", TEAM_SENTINEL);
        body.put("slots", slots);
        assertThat(authPut("/api/deck", token, body, Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        return token;
    }

    private ResponseEntity<String> squad(String viewerToken, String targetUserId) {
        return authGet("/api/users/" + targetUserId + "/squad", viewerToken, String.class);
    }

    private JsonNode json(String body) {
        try {
            return MAPPER.readTree(body);
        } catch (Exception e) {
            throw new IllegalStateException("bad json: " + body, e);
        }
    }

    private static Set<String> keysOf(JsonNode node) {
        Set<String> keys = new LinkedHashSet<>();
        node.fieldNames().forEachRemaining(keys::add);
        return keys;
    }

    private long aiJobRows() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs").query(Long.class).single();
    }

    /**
     * <b>실제 원정 랭킹보드에 올린다</b> — 정산된 비-몰수 원정 1판(시즌 창 안). 보드 등재의 정의는
     * {@code AwaySeasonService.standings} 가 소유하므로 조건을 흉내 내지 않고 그 입력을 만든다.
     *
     * <p>시즌 행을 <b>먼저</b> 연다: 시즌이 없으면 보드 조회 시점에 {@code started_at = now} 로 열려
     * 방금 만든 리포트가 창 밖으로 떨어진다(픽스처가 조용히 거짓이 된다).
     */
    private void putOnAwayBoard(String attackerId, String defenderId) {
        seasonService.current();
        awayService.settle(seedAwayChallenge(attackerId, defenderId), attackerId, "WIN", 2, 0);
    }

    /** 자격 절 <b>격리</b>의 근거 — 보드가 내주는 목록(원정·리그)에 정말 없는지 실제 보드에 묻는다. */
    private void assertNotOnAnyBoard(String viewerId, String targetId) {
        assertThat(awayService.rankings(viewerId, Integer.MAX_VALUE).entries())
                .as("원정 보드에 없어야 절 격리가 성립한다")
                .noneSatisfy(e -> assertThat(e.userId()).isEqualTo(targetId));
        assertThat(leagueService.rankings(viewerId, "global", Integer.MAX_VALUE).entries())
                .as("리그 보드에 없어야 절 격리가 성립한다")
                .noneSatisfy(e -> assertThat(e.userId()).isEqualTo(targetId));
    }

    /** 정산은 매치·도전장이 있어야 한다 — 시뮬을 돌리지 않고 그 상태만 만든다(AwayV2Test 와 같은 방식). */
    private String seedAwayChallenge(String attackerId, String defenderId) {
        String matchId = online.hmb.common.Ulid.next();
        String now = java.time.Instant.now().toString();
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', 'test', '{}', 'away', ?)
                        """)
                .params(matchId, attackerId, now).update();
        jdbcClient.sql("""
                        INSERT INTO away_challenges(match_id, defender_id, ghost_bot_id, created_at)
                        VALUES (?, ?, 'BOT_BAL', ?)
                        """)
                .params(matchId, defenderId, now).update();
        return matchId;
    }

    /** 서버가 제시를 기억하는 그 표에 행을 만든다({@code AwayService.offerCandidates} 와 같은 형태). */
    private void seedOffer(String viewerId, String targetUserId, java.time.Instant createdAt) {
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(viewerId, "[\"" + targetUserId + "\"]", createdAt.toString())
                .update();
    }

    private JsonNode slotOf(JsonNode slots, String playerId) {
        for (JsonNode slot : slots) {
            if (playerId.equals(slot.path("playerId").asText())) {
                return slot;
            }
        }
        throw new AssertionError(playerId + " 슬롯이 응답에 없다: " + slots);
    }

    // ── 핵심: 누설 0 (문자열 + 키 집합 두 겹) ───────────────────────────

    /**
     * 랭킹보드에 오른 유저의 선수단은 보이되, <b>지시문은 한 글자도, 새 필드는 한 개도</b> 안 나간다.
     *
     * <p>이 테스트가 절③(보드 등재) 표본이기도 하다: 뷰어와 대상 사이엔 제시도 리포트도 없다.
     */
    @Test
    void boardListedUsersSquadIsVisibleButLeaksNothingBeyondAllowedKeys() {
        setupTargetWithSentinelDeck("squad_target");
        String targetId = userIdOf("squad_target");
        setupUserWithDeck("squad_prey");
        putOnAwayBoard(targetId, userIdOf("squad_prey"));   // 대상이 제3자를 쳐서 보드에 오른다
        String viewer = login("squad_viewer");
        String viewerId = userIdOf("squad_viewer");
        // 절 격리: 뷰어에게 제시된 적도, 뷰어를 친 적도 없다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM away_offers WHERE user_id = ?")
                .param(viewerId).query(Long.class).single()).isZero();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE defender_id = ?")
                .param(viewerId).query(Long.class).single()).isZero();

        ResponseEntity<String> res = squad(viewer, targetId);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        String raw = res.getBody();

        // ① 문자열 축 — 지시문 원문은 본문 어디에도 없다.
        assertThat(raw).as("선수 지시문이 새면 안 된다").doesNotContain(PLAYER_SENTINEL);
        assertThat(raw).as("팀 지시문이 새면 안 된다").doesNotContain(TEAM_SENTINEL);

        JsonNode body = json(raw);
        // ② 키 축 — **정확집합**. 숫자·열거로 새는 축(컨디션·팀 전술)과 아직 없는 필드까지 막는다.
        assertThat(keysOf(body)).as("최상위 키를 얼린다").isEqualTo(SQUAD_KEYS);
        for (JsonNode slot : body.path("slots")) {
            assertThat(keysOf(slot))
                    .as("슬롯 키를 얼린다 — 컨디션·지시문·성장 진행도가 끼어들 자리가 없다")
                    .isEqualTo(SLOT_KEYS);
        }

        // ③ 화면이 그릴 것은 다 있다(계약 스키마 #432 코멘트).
        assertThat(body.path("userId").asText()).isEqualTo(targetId);
        assertThat(body.path("nickname").asText()).isEqualTo("squad_target");
        assertThat(body.path("formation").asText()).isEqualTo("4-4-2");

        JsonNode slots = body.path("slots");
        assertThat(slots.size()).as("벤치 포함 = 선수단 구경").isEqualTo(13);

        JsonNode withPrompt = slotOf(slots, "P002");
        assertThat(withPrompt.path("hasPrompt").asBoolean()).as("있음/없음만 말한다").isTrue();
        assertThat(withPrompt.path("name").asText()).isNotBlank();
        assertThat(withPrompt.path("position").asText()).isNotBlank();
        assertThat(withPrompt.path("grade").asText()).isNotBlank();
        assertThat(withPrompt.path("ovr").asDouble()).isGreaterThan(0.0);
        assertThat(withPrompt.path("attributes").size()).isGreaterThanOrEqualTo(9);
        assertThat(withPrompt.path("role").asText()).isEqualTo("starter");
        assertThat(withPrompt.path("slotIndex").asInt()).isEqualTo(1);

        assertThat(slotOf(slots, "P003").path("hasPrompt").asBoolean())
                .as("지시가 없는 선수는 false").isFalse();
        assertThat(slotOf(slots, "P013").path("role").asText()).isEqualTo("bench");
    }

    /**
     * <b>★ 는 대상 유저의 카드값</b>이다 — 뷰어 카드로 읽으면 남의 선수단에 내 성장이 그려진다.
     *
     * <p>대상만 3★ 로 올리고 뷰어는 기본값으로 둔 뒤 <b>정확한 값</b>을 단언한다. "≥1" 로 걸면
     * 소유자를 바꿔치기해도(양쪽 다 1★) 계약이 통과한다.
     */
    @Test
    void starComesFromTheTargetsCardNotTheViewers() {
        setupTargetWithSentinelDeck("squad_star");
        String targetId = userIdOf("squad_star");
        setupUserWithDeck("sq_star_prey");
        putOnAwayBoard(targetId, userIdOf("sq_star_prey"));
        String viewer = setupUserWithDeck("sq_star_view");
        String viewerId = userIdOf("sq_star_view");

        jdbcClient.sql("UPDATE user_players SET star = 3 WHERE user_id = ? AND player_id = 'P004'")
                .param(targetId).update();

        int viewerStar = jdbcClient.sql("SELECT star FROM user_players WHERE user_id = ? AND player_id = 'P004'")
                .param(viewerId).query(Integer.class).optional().orElse(0);
        assertThat(viewerStar).as("두 값이 같으면 소유자 바꿔치기를 관측할 수 없다").isNotEqualTo(3);

        assertThat(slotOf(json(squad(viewer, targetId).getBody()).path("slots"), "P004")
                .path("star").asInt()).isEqualTo(3);
    }

    /**
     * <b>능력치는 성장 반영 유효치</b>다(카탈로그 기본치가 아니다) — 스탯을 올린 뒤 값이 따라 움직인다.
     */
    @Test
    void attributesReflectGrowthNotCatalogBase() {
        setupTargetWithSentinelDeck("squad_grown");
        String targetId = userIdOf("squad_grown");
        setupUserWithDeck("sq_grow_prey");
        putOnAwayBoard(targetId, userIdOf("sq_grow_prey"));
        String viewer = login("sq_grow_viewer");

        double before = slotOf(json(squad(viewer, targetId).getBody()).path("slots"), "P003")
                .path("attributes").path("pace").asDouble();

        jdbcClient.sql("UPDATE user_players SET stat_add_json = ? WHERE user_id = ? AND player_id = 'P003'")
                .params("{\"pace\":5.0}", targetId)
                .update();

        JsonNode after = slotOf(json(squad(viewer, targetId).getBody()).path("slots"), "P003");
        assertThat(after.path("attributes").path("pace").asDouble())
                .as("성장분이 응답에 반영돼야 한다(카탈로그 기본치를 실으면 안 움직인다)")
                .isGreaterThan(before);
    }

    // ── 자격: DB 행이 근거 ──────────────────────────────────────────────

    /**
     * 자격 밖이면 <b>404</b> — 존재를 숨긴다(403 팩토리가 이 리포에 없다).
     *
     * <p>⚠️ 표본은 <b>과거 완료 경기가 있는</b> 유저다: "한 판도 안 한 사람"으로 걸면 자격을
     * "완료 경기 1판"으로 흉내 낸 구현도 통과한다(초판이 그랬다). 보드에 <b>실제로</b> 없어야 404 다.
     */
    @Test
    void userWhoPlayedButIsNotOnAnyBoardIsNotFound() {
        setupTargetWithSentinelDeck("squad_hidden");
        String hiddenId = userIdOf("squad_hidden");
        markPlayedOnce(hiddenId);                        // 완료 경기 1판(연습) — 보드 등재는 아니다
        String viewer = login("squad_stranger");
        String viewerId = userIdOf("squad_stranger");

        assertNotOnAnyBoard(viewerId, hiddenId);
        ResponseEntity<String> res = squad(viewer, hiddenId);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody()).doesNotContain(PLAYER_SENTINEL).doesNotContain(TEAM_SENTINEL);
    }

    @Test
    void unknownUserIsNotFound() {
        String viewer = login("sq_unk_viewer");
        assertThat(squad(viewer, "01NOPE0000000000000000000").getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * <b>절① 격리</b>: 서버가 방금 제시한 원정 후보는 <b>보드 밖이어도</b> 볼 수 있다.
     *
     * <p>초판은 {@code setupOpponentWithDeck}(= 자격 부여 포함)으로 후보를 세워서, 제시 검사를
     * 통째로 지워도 green 이었다(다른 절이 받아 줬다). 여기서는 대상에게 <b>제시 행 말고는</b>
     * 아무 근거도 주지 않는다.
     */
    @Test
    void freshOfferAloneOpensTheSquad() {
        setupTargetWithSentinelDeck("squad_offered");
        String targetId = userIdOf("squad_offered");
        String viewer = login("sq_offer_view");
        String viewerId = userIdOf("sq_offer_view");

        assertNotOnAnyBoard(viewerId, targetId);
        seedOffer(viewerId, targetId, java.time.Instant.now());

        assertThat(squad(viewer, targetId).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /**
     * <b>만료된 제시는 자격이 아니다</b> — 오래된 제시로 나중에 골라 담지 못하는 것과 같은 이유로,
     * 만료되면 볼 수도 없다(TTL 검사를 지우면 이 계약이 죽는다).
     */
    @Test
    void staleOfferDoesNotOpenTheSquad() {
        setupTargetWithSentinelDeck("squad_stale");
        String targetId = userIdOf("squad_stale");
        String viewer = login("sq_stale_view");
        String viewerId = userIdOf("sq_stale_view");

        assertNotOnAnyBoard(viewerId, targetId);
        // offer-ttl-sec 기본 600 보다 한참 지난 제시.
        seedOffer(viewerId, targetId, java.time.Instant.now().minusSeconds(4000));

        assertThat(squad(viewer, targetId).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /** 실제 제시 경로(서비스가 만든 제시)로도 열린다 — seedOffer 가 형태를 흉내 낸 게 아니라는 확인. */
    @Test
    void offeredAwayCandidateIsVisible() {
        setupOpponentWithDeck("squad_cand_a");
        setupOpponentWithDeck("squad_cand_b");
        String viewer = setupUserWithDeck("sq_cand_viewer");
        String viewerId = userIdOf("sq_cand_viewer");

        List<AwayService.Candidate> offered = awayService.offerCandidates(viewerId);
        assertThat(offered).isNotEmpty();
        assertThat(squad(viewer, offered.get(0).userId()).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /**
     * <b>절② 격리</b>: 나를 친 상대(복수 큐의 그 사람)는 <b>보드 밖이어도</b> 볼 수 있다.
     *
     * <p>리포트를 시즌 창 <b>밖</b>(지난 시즌)으로 밀어 보드 등재를 떼어 낸다 — 복수 큐는 시즌을
     * 가리지 않으므로(최근 N건) 그 사람은 여전히 큐에 있고, 화면이 그를 누를 수 있다.
     */
    @Test
    void attackerWhoRaidedMeIsVisibleEvenOffTheBoard() {
        setupUserWithDeck("squad_raider");
        String raiderId = userIdOf("squad_raider");
        String viewer = setupUserWithDeck("squad_victim");
        String viewerId = userIdOf("squad_victim");

        seasonService.current();
        String matchId = seedAwayChallenge(raiderId, viewerId);
        awayService.settle(matchId, raiderId, "WIN", 2, 0);
        // 지난 시즌 기록으로 민다(보드 참가 = 시즌 창 안의 비-몰수 리포트).
        jdbcClient.sql("UPDATE away_reports SET created_at = ? WHERE match_id = ?")
                .params("2020-01-01T00:00:00Z", matchId).update();

        assertNotOnAnyBoard(viewerId, raiderId);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE defender_id = ? AND attacker_id = ?")
                .params(viewerId, raiderId).query(Long.class).single()).isEqualTo(1);
        assertThat(squad(viewer, raiderId).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    // ── 읽기 전용 ───────────────────────────────────────────────────────

    /**
     * <b>남의 화면을 보는 것만으로 AI 예산이 나가면 안 된다</b>(#432 §4-5 · 판단 ③).
     * {@code GET /api/deck} 의 프리워밍 부수효과({@code DeckController:41-43})를 옮겨오지 않았다는 계약.
     */
    @Test
    void squadReadEnqueuesNoAiJob() {
        setupTargetWithSentinelDeck("squad_nojob");
        String targetId = userIdOf("squad_nojob");
        setupUserWithDeck("sq_nojob_prey");
        putOnAwayBoard(targetId, userIdOf("sq_nojob_prey"));
        String viewer = login("sq_nojob_view");

        // 프리워밍이 붙었다면 "만들 것이 있는" 상태여야 관측된다 — 큐와 원장을 비우고 본다.
        jdbcClient.sql("DELETE FROM ai_jobs").update();
        jdbcClient.sql("DELETE FROM deck_prewarm").update();

        assertThat(squad(viewer, targetId).getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(aiJobRows()).as("읽기 전용 API 가 AI 잡을 만들면 안 된다").isZero();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM deck_prewarm").query(Long.class).single())
                .as("프리워밍 원장도 건드리지 않는다").isZero();
    }
}
