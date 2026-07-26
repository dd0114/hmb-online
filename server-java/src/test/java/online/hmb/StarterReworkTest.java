package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import online.hmb.auth.UserOnboardingService;
import online.hmb.catalog.EconomyService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #209 스타터/온보딩 개편 — AC1(가입 지급 = 최상위 4중 1 + 기본팩) · AC2(튜토리얼 완료 → 덱 지급, 멱등).
 *
 * <p>픽스처 economy: starterPack = P001..P014(기본), starterTop.pool = P018..P021(최상위 4종, 전원 LEGEND).
 * pool 을 기존 픽스처(P015~P017)와 겹치지 않게 새로 넣은 이유는, 다른 테스트가 "P015/P016/P017 은
 * 미보유"를 전제로 하기 때문이다 — 최상위 지급이 그 전제를 흔들면 안 된다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class StarterReworkTest extends ApiTestBase {

    private static final List<String> TOP_POOL = List.of("P018", "P019", "P020", "P021");
    private static final int BASIC_PACK_SIZE = 14;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    // ── AC1: 가입 지급 ────────────────────────────────────────────────

    @Test
    void signupGrantsExactlyOneTopUnitFromTheConfiguredPool() {
        String token = login("top_grant");
        String userId = userIdOf("top_grant");

        List<String> owned = ownedIds(userId);
        assertThat(owned).hasSize(BASIC_PACK_SIZE + 1);

        List<String> tops = owned.stream().filter(TOP_POOL::contains).toList();
        assertThat(tops).as("최상위는 정확히 1장").hasSize(1);

        // 박제 — 연출(AC3)이 읽는 값. user_players 만으로는 "스타터로 받은 최상위"를 복원할 수 없다.
        String grantedPlayerId = jdbcClient.sql("SELECT player_id FROM starter_grants WHERE user_id = ?")
                .param(userId).query(String.class).single();
        assertThat(grantedPlayerId).isEqualTo(tops.get(0));

        // 나머지는 전부 기본팩(= 최상위가 두 장 새어 들어오지 않는다)
        assertThat(owned.stream().filter(id -> !TOP_POOL.contains(id)).toList())
                .containsExactlyInAnyOrderElementsOf(basicPack());

        // 연출 API — 지급 사실 + 카드 정보를 그대로 준다.
        ResponseEntity<Map> grant = authGet("/api/me/starter-grant", token, Map.class);
        assertThat(grant.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((Boolean) grant.getBody().get("granted")).isTrue();
        Map<?, ?> player = (Map<?, ?>) grant.getBody().get("player");
        assertThat(player.get("id")).isEqualTo(grantedPlayerId);
        assertThat(player.get("grade")).isEqualTo("LEGEND");
        assertThat(player.get("name")).isNotNull();
        assertThat(player.get("position")).isNotNull();
    }

    @Test
    void topPickIsSeedDeterministic() {
        EconomyService.StarterTop top = new EconomyService.StarterTop(TOP_POOL, 1);
        // 같은 userId → 항상 같은 결과(재현 가능). 100회 반복해도 흔들리지 않는다.
        String first = UserOnboardingService.pickStarterTop("01J0USERAAAA", top).get(0);
        for (int i = 0; i < 100; i++) {
            assertThat(UserOnboardingService.pickStarterTop("01J0USERAAAA", top)).containsExactly(first);
        }
        assertThat(TOP_POOL).contains(first);
    }

    @Test
    void topPickSpreadsAcrossTheWholePool() {
        EconomyService.StarterTop top = new EconomyService.StarterTop(TOP_POOL, 1);
        // 4종 전부가 실제로 뽑힌다 — "결정론"이 "항상 같은 한 명"으로 굳어버리지 않았는지.
        Set<String> seen = java.util.stream.IntStream.range(0, 200)
                .mapToObj(i -> UserOnboardingService.pickStarterTop("01J0USER" + i, top).get(0))
                .collect(Collectors.toSet());
        assertThat(seen).containsExactlyInAnyOrderElementsOf(TOP_POOL);
    }

    @Test
    void topPickIsEmptyWhenPoolIsAbsent() {
        // 구 economy 파일(v2 이하) 호환 — 블록이 없으면 기본팩만 지급하고 가입은 계속된다.
        assertThat(UserOnboardingService.pickStarterTop("01J0USERX", null)).isEmpty();
        assertThat(UserOnboardingService.pickStarterTop("01J0USERX",
                new EconomyService.StarterTop(List.of(), 1))).isEmpty();
    }

    @Test
    void relogindDoesNotRegrantTheTopUnit() {
        login("top_idem");
        String userId = userIdOf("top_idem");
        login("top_idem");

        assertThat(ownedIds(userId)).hasSize(BASIC_PACK_SIZE + 1);
        long grants = jdbcClient.sql("SELECT COUNT(*) FROM starter_grants WHERE user_id = ?")
                .param(userId).query(Long.class).single();
        assertThat(grants).isEqualTo(1L);
        long topCount = jdbcClient.sql("""
                        SELECT count FROM user_players
                        WHERE user_id = ? AND player_id = (SELECT player_id FROM starter_grants WHERE user_id = ?)
                        """)
                .params(userId, userId).query(Long.class).single();
        assertThat(topCount).isEqualTo(1L);
    }

    // ── AC2: 튜토리얼 완료 → 덱 지급 ──────────────────────────────────

    @Test
    void newUserHasNoDeckUntilTutorialCompletes() {
        String token = login("tut_deck");

        assertThat(authGet("/api/me", token, Map.class).getBody())
                .extracting(b -> ((Map<?, ?>) ((Map<?, ?>) b).get("user")).get("tutorialDone"))
                .isEqualTo(false);
        assertThat(authGet("/api/deck", token, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        ResponseEntity<Map> done = authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        assertThat(done.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((Boolean) done.getBody().get("tutorialDone")).isTrue();
        assertThat((Boolean) done.getBody().get("deckGranted")).isTrue();

        ResponseEntity<Map> deck = authGet("/api/deck", token, Map.class);
        assertThat(deck.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> slots = (List<Map<String, Object>>) deck.getBody().get("slots");
        assertThat(slots.stream().filter(s -> "starter".equals(s.get("role")))).hasSize(11);
        assertThat(slots.stream().filter(s -> "bench".equals(s.get("role")))).isNotEmpty();
        assertThat(deck.getBody().get("formation")).isEqualTo("4-3-3");

        // 선발에 GK 가 있고(엔진·검증 요구), 최상위 유닛은 벤치에 처박히지 않는다.
        Set<String> starters = slots.stream().filter(s -> "starter".equals(s.get("role")))
                .map(s -> (String) s.get("playerId")).collect(Collectors.toSet());
        assertThat(positionsOf(starters)).contains("GK");
        String top = jdbcClient.sql("SELECT player_id FROM starter_grants WHERE user_id = ?")
                .param(userIdOf("tut_deck")).query(String.class).single();
        assertThat(starters).as("지급된 최상위는 선발로 배치된다").contains(top);

        // /api/me 가 서버 SoT 로 완료를 발행한다(클라 localStorage 가 아니라).
        assertThat(((Map<?, ?>) authGet("/api/me", token, Map.class).getBody().get("user")).get("tutorialDone"))
                .isEqualTo(true);
    }

    /**
     * 지급 덱에서 최상위가 <b>자기 포지션</b>에 선다 — 여러 계정을 만들어 pool 4종이 실제로
     * 골고루 지급되는 상황에서 확인한다(계정마다 다른 최상위를 받으므로 4종이 모두 표본에 든다).
     *
     * <p>이걸 보는 이유: 최상위는 기본팩보다 능력치가 압도적이라, 배치가 순수 적합도 그리디면
     * FW/MF 최상위가 <b>센터백 슬롯</b>을 이겨서 차지한다(실제로 그랬다). 튜토리얼 직후 첫 화면이
     * "펠레가 수비수" 인 그림이면 지급의 의미가 반감된다.
     */
    @Test
    void grantedTopUnitStartsInItsOwnPosition() {
        List<String> layout = List.of("GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW");
        Set<String> covered = new java.util.HashSet<>();

        // 지급은 시드 결정론이라 계정 수가 적으면 특정 포지션이 표본에 안 들 수 있다 —
        // 4종을 모두 덮을 때까지(상한 40) 계정을 늘린다. 상한은 무한루프 방지용이다.
        for (int i = 0; i < 40 && covered.size() < 4; i++) {
            String nickname = "slotfit_" + i;
            String token = login(nickname);
            String userId = userIdOf(nickname);
            authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);

            String top = jdbcClient.sql("SELECT player_id FROM starter_grants WHERE user_id = ?")
                    .param(userId).query(String.class).single();
            String topPosition = jdbcClient.sql("SELECT position FROM players WHERE id = ?")
                    .param(top).query(String.class).single();
            Integer slotIndex = jdbcClient.sql("""
                            SELECT ds.slot_index FROM deck_slots ds JOIN decks d ON d.id = ds.deck_id
                            WHERE d.user_id = ? AND d.is_active = 1 AND ds.player_id = ? AND ds.role = 'starter'
                            """)
                    .params(userId, top).query(Integer.class).optional().orElse(null);

            assertThat(slotIndex).as(nickname + ": 최상위(" + top + ")가 선발이 아니다").isNotNull();
            assertThat(layout.get(slotIndex))
                    .as(nickname + ": 최상위 " + top + "(" + topPosition + ") 가 slot " + slotIndex + " 에 섰다")
                    .isEqualTo(topPosition);
            covered.add(topPosition);
        }
        assertThat(covered).as("표본이 pool 4종(GK/DF/MF/FW)을 모두 덮는다").hasSize(4);
    }

    @Test
    void tutorialCompleteIsIdempotent() {
        String token = login("tut_idem");
        authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        Map<?, ?> firstDeck = authGet("/api/deck", token, Map.class).getBody();

        for (int i = 0; i < 3; i++) {
            ResponseEntity<Map> again = authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
            assertThat((Boolean) again.getBody().get("tutorialDone")).isTrue();
            assertThat((Boolean) again.getBody().get("deckGranted")).as("재지급 0").isFalse();
        }

        assertThat(authGet("/api/deck", token, Map.class).getBody()).isEqualTo(firstDeck);
        long decks = jdbcClient.sql("SELECT COUNT(*) FROM decks WHERE user_id = ?")
                .param(userIdOf("tut_idem")).query(Long.class).single();
        assertThat(decks).isEqualTo(1L);
    }

    @Test
    void tutorialCompleteNeverOverwritesADeckTheUserAlreadyBuilt() {
        String token = login("tut_keep");
        // 유저가 먼저 자기 덱을 저장한 뒤(예: 튜토리얼 덱 스텝에서 저장) 완료가 들어오는 순서.
        List<Map<String, Object>> slots = new java.util.ArrayList<>();
        List<String> basics = basicPack();
        for (int i = 0; i < 11; i++) {
            slots.add(slot(basics.get(i), "starter", i));
        }
        assertThat(authPut("/api/deck", token, deckBody("4-4-2", slots), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        ResponseEntity<Map> done = authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        assertThat((Boolean) done.getBody().get("deckGranted")).isFalse();

        Map<?, ?> deck = authGet("/api/deck", token, Map.class).getBody();
        assertThat(deck.get("formation")).as("유저 덱 보존").isEqualTo("4-4-2");
        assertThat(((List<?>) deck.get("slots"))).hasSize(11);
    }

    // ── helpers ──────────────────────────────────────────────────────

    private List<String> basicPack() {
        return jdbcClient.sql("SELECT id FROM players WHERE id <= 'P014' ORDER BY id")
                .query(String.class).list();
    }

    private List<String> ownedIds(String userId) {
        return jdbcClient.sql("SELECT player_id FROM user_players WHERE user_id = ? ORDER BY player_id")
                .param(userId).query(String.class).list();
    }

    private List<String> positionsOf(Set<String> playerIds) {
        return jdbcClient.sql("SELECT position FROM players WHERE id IN ("
                        + playerIds.stream().map(id -> "'" + id + "'").collect(Collectors.joining(",")) + ")")
                .query(String.class).list();
    }

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
    }
}
