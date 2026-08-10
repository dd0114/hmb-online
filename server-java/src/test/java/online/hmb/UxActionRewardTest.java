package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import online.hmb.rewards.RewardBundleService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #493 W3 — 행동 보상 5종(각 GEM 300, 우편 지급) 계약.
 *
 * <p>멱등 축 = 우편함 기존 유니크({@code uq_user_mails_user_campaign}) — 새 테이블 없음(V33 머리말
 * 준수). 같은 행동을 몇 번 반복해도(재호출·busy-retry 재실행) 우편은 유저당 1통이고, 수령은
 * 기존 claim 경로(원장 {@code ref_id = user_mails.id})라 이중 크레딧이 구조적으로 불가능하다.
 *
 * <p>fixture economy: 가입 지급 3000 P / single 뽑기 300 P (GachaApiTest 머리말).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class UxActionRewardTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private RewardBundleService rewardBundleService;

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname)
                .query(String.class)
                .single();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> mails(String token) {
        ResponseEntity<Map> res = authGet("/api/mails", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) res.getBody().get("mails");
    }

    private List<Map<String, Object>> mailsTitled(String token, String title) {
        return mails(token).stream().filter(m -> title.equals(m.get("title"))).toList();
    }

    @SuppressWarnings("unchecked")
    private long gemsAttached(Map<String, Object> mail) {
        Map<String, Object> att = (Map<String, Object>) mail.get("attachments");
        return ((Number) att.get("gems")).longValue();
    }

    // ── ① 튜토리얼 완주 ────────────────────────────────────────────────────────

    @Test
    void tutorialCompleteGrantsMailOnce() {
        String token = login("uxa_tuto");
        assertThat(authPost("/api/me/tutorial-complete", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> granted = mailsTitled(token, "튜토리얼 완주 보상");
        assertThat(granted).hasSize(1);
        assertThat(gemsAttached(granted.get(0))).isEqualTo(300L);

        // 완료 API 는 멱등 — 다시 불러도 우편이 늘지 않는다.
        authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        assertThat(mailsTitled(token, "튜토리얼 완주 보상")).hasSize(1);
    }

    // ── ③ 첫 덱 저장 (auto 여부 무관 — 서버는 auto 를 모른다, W0 Decision) ─────────

    @Test
    void firstDeckSaveGrantsMailOnce() {
        String token = login("uxa_deck");
        List<Map<String, Object>> slots = new java.util.ArrayList<>();
        for (int i = 1; i <= 11; i++) {
            slots.add(Map.of("playerId", String.format("P%03d", i), "role", "starter", "slotIndex", i - 1));
        }
        assertThat(authPut("/api/deck", token, deckBody("4-3-3", slots), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(mailsTitled(token, "첫 스쿼드 저장 보상")).hasSize(1);

        // 두 번째 저장은 보상이 없다.
        assertThat(authPut("/api/deck", token, deckBody("4-3-3", slots), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(mailsTitled(token, "첫 스쿼드 저장 보상")).hasSize(1);
    }

    // ── ④ 첫 뽑기 ────────────────────────────────────────────────────────────

    @Test
    void firstGachaGrantsMailOnce() {
        String token = login("uxa_gacha");
        assertThat(authPost("/api/shop/gacha", token, Map.of("kind", "single"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(mailsTitled(token, "첫 뽑기 보상")).hasSize(1);

        authPost("/api/shop/gacha", token, Map.of("kind", "single"), Map.class);
        assertThat(mailsTitled(token, "첫 뽑기 보상")).hasSize(1);
    }

    // ── ⑤ 첫 트레이드 등록 (hero verbatim "걸었을때" = 등록 시점) ───────────────────

    @Test
    void firstTradeStartGrantsMailOnce() {
        String token = login("uxa_trade");
        authGet("/api/trade", token, Map.class); // 슬롯 lazy 생성
        ResponseEntity<Map> started = authPost("/api/trade/1/start", token, null, Map.class);
        assertThat(started.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(mailsTitled(token, "첫 트레이드 보상")).hasSize(1);

        // 다른 슬롯에 또 걸어도 보상은 1회다.
        ResponseEntity<Map> second = authPost("/api/trade/2/start", token, null, Map.class);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(mailsTitled(token, "첫 트레이드 보상")).hasSize(1);
    }

    // ── ② 첫 경기 결과 열람 (보상 봉투 ack 시점 — W0 Decision) ─────────────────────

    @Test
    void firstResultAckGrantsMailOnce() {
        String token = login("uxa_result");
        String userId = userIdOf("uxa_result");
        String bundleId = rewardBundleService
                .create(userId, RewardBundleService.SOURCE_MATCH, "m-uxa-1",
                        List.of(new RewardBundleService.Section(RewardBundleService.KIND_CURRENCY,
                                List.of(RewardBundleService.currency("POINT", 100)))))
                .orElseThrow();
        assertThat(authPost("/api/rewards/" + bundleId + "/ack", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(mailsTitled(token, "첫 경기 결과 확인 보상")).hasSize(1);

        // ack 멱등 + 두 번째 봉투 ack 도 보상은 더 없다.
        authPost("/api/rewards/" + bundleId + "/ack", token, Map.of(), Map.class);
        String bundle2 = rewardBundleService
                .create(userId, RewardBundleService.SOURCE_MATCH, "m-uxa-2",
                        List.of(new RewardBundleService.Section(RewardBundleService.KIND_CURRENCY,
                                List.of(RewardBundleService.currency("POINT", 100)))))
                .orElseThrow();
        authPost("/api/rewards/" + bundle2 + "/ack", token, Map.of(), Map.class);
        assertThat(mailsTitled(token, "첫 경기 결과 확인 보상")).hasSize(1);
    }

    // ── 수령: 기존 claim 경로 — GEM +300 정확히 1회 (AC9 의 지갑 축) ───────────────

    @Test
    @SuppressWarnings("unchecked")
    void claimCreditsGemsExactlyOnce() {
        String token = login("uxa_claim");
        authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        Map<String, Object> mail = mailsTitled(token, "튜토리얼 완주 보상").get(0);
        String mailId = (String) mail.get("id");

        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        long gemsBefore = ((Number) ((Map<String, Object>) me.getBody().get("wallet")).get("gems")).longValue();

        ResponseEntity<Map> claim = authPost("/api/mails/" + mailId + "/claim", token, Map.of(), Map.class);
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(claim.getBody().get("applied")).isEqualTo(true);

        ResponseEntity<Map> after = authGet("/api/me", token, Map.class);
        long gemsAfter = ((Number) ((Map<String, Object>) after.getBody().get("wallet")).get("gems")).longValue();
        assertThat(gemsAfter - gemsBefore).isEqualTo(300L);

        // 재수령 시도 — 지갑이 더 늘지 않는다(기존 원장 유니크 축).
        authPost("/api/mails/" + mailId + "/claim", token, Map.of(), Map.class);
        ResponseEntity<Map> again = authGet("/api/me", token, Map.class);
        long gemsAgain = ((Number) ((Map<String, Object>) again.getBody().get("wallet")).get("gems")).longValue();
        assertThat(gemsAgain).isEqualTo(gemsAfter);
    }

    // ── 계정 격리: 남의 행동이 내 우편함을 만들지 않는다 ────────────────────────────

    @Test
    void grantsAreIsolatedPerUser() {
        String a = login("uxa_iso_a");
        String b = login("uxa_iso_b");
        authPost("/api/me/tutorial-complete", a, Map.of(), Map.class);
        assertThat(mailsTitled(a, "튜토리얼 완주 보상")).hasSize(1);
        assertThat(mailsTitled(b, "튜토리얼 완주 보상")).isEmpty();
    }
}
