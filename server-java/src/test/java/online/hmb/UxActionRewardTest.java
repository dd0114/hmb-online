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

    /**
     * #493 W9 — 완주 보상의 근거는 <b>서버가 아는 사실</b>(FINISHED 인 튜토리얼 매치)이지 클라의
     * 완료 신고가 아니다. 여기서는 그 사실을 <b>행으로 심어</b> 이 클래스의 주제(우편 1통·GEM 300·
     * 멱등)만 본다 — 실제로 경기를 치러 그 사실이 생기는 경로는 {@code TutorialMatchTest} 가 전담한다
     * ({@code TestDbSupport.disableMatchClock} 과 같은 규율).
     */
    @Test
    void tutorialCompleteGrantsMailOnce() {
        String token = login("uxa_tuto");
        plantFinishedTutorialMatch(userIdOf("uxa_tuto"));
        assertThat(authPost("/api/me/tutorial-complete", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> granted = mailsTitled(token, "튜토리얼 완주 보상");
        assertThat(granted).hasSize(1);
        assertThat(gemsAttached(granted.get(0))).isEqualTo(300L);

        // 완료 API 는 멱등 — 다시 불러도 우편이 늘지 않는다.
        authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        assertThat(mailsTitled(token, "튜토리얼 완주 보상")).hasSize(1);
    }

    /**
     * #493 W9 — <b>클라가 신고만 해서는 지급되지 않는다</b>. 이게 이 웨이브가 고친 결함이다:
     * 완료 모달을 스킵하거나 클라가 임의로 이 엔드포인트를 불러도 GEM 300 이 나갔다.
     * 호출 자체는 <b>여전히 200</b> 이어야 한다(구버전 클라 호환 — 덱 지급·완료 플래그는 그대로 돈다).
     */
    @Test
    void tutorialCompleteWithoutTheServersOwnEvidenceGrantsNothing() {
        String token = login("uxa_tuto_claim");
        assertThat(authPost("/api/me/tutorial-complete", token, Map.of(), Map.class).getStatusCode())
                .as("호환 유지 — 호출은 받는다").isEqualTo(HttpStatus.OK);
        assertThat(mailsTitled(token, "튜토리얼 완주 보상")).isEmpty();

        // 튜토리얼이 **아닌** 경기를 끝낸 것도 근거가 아니다 — 아니면 "아무 경기나 하나"가 우회로다.
        plantFinishedMatch(userIdOf("uxa_tuto_claim"), false);
        authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        assertThat(mailsTitled(token, "튜토리얼 완주 보상")).isEmpty();

        // 튜토리얼 매치가 FINISHED 가 되어야 비로소 지급된다(같은 호출, 달라진 것은 서버 사실뿐).
        plantFinishedTutorialMatch(userIdOf("uxa_tuto_claim"));
        authPost("/api/me/tutorial-complete", token, Map.of(), Map.class);
        assertThat(mailsTitled(token, "튜토리얼 완주 보상")).hasSize(1);
    }

    /** 서버 사실을 행으로 심는다(= 정산 CAS 가 만드는 것과 같은 상태). */
    private void plantFinishedTutorialMatch(String userId) {
        plantFinishedMatch(userId, true);
    }

    private void plantFinishedMatch(String userId, boolean tutorial) {
        String botId = jdbcClient.sql("SELECT id FROM bots ORDER BY id LIMIT 1")
                .query(String.class).single();
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, created_at, is_tutorial)
                        VALUES (?, ?, ?, 'FINISHED', 'seed', 'test', '{}', 'practice', ?, ?)
                        """)
                .params("m-" + userId + "-" + (tutorial ? "tut" : "normal"), userId, botId,
                        java.time.Instant.now().toString(), tutorial ? 1 : 0)
                .update();
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
        plantFinishedTutorialMatch(userIdOf("uxa_claim"));   // #493 W9 — 지급의 근거는 서버 사실이다
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
        // ⚠️ 근거는 **둘 다** 심는다 — b 에게 근거가 없으면 "격리됐다"가 "근거가 없었다"와
        // 구분되지 않아 계약이 공허해진다. 다른 것은 a 만 완료를 지났다는 사실 하나다.
        plantFinishedTutorialMatch(userIdOf("uxa_iso_a"));
        plantFinishedTutorialMatch(userIdOf("uxa_iso_b"));
        authPost("/api/me/tutorial-complete", a, Map.of(), Map.class);
        assertThat(mailsTitled(a, "튜토리얼 완주 보상")).hasSize(1);
        assertThat(mailsTitled(b, "튜토리얼 완주 보상")).isEmpty();
    }
}
