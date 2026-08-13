package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import online.hmb.common.TxRunner;
import online.hmb.events.BusinessEventRecorder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#492 AC3-②(장애주입) — 기록이 죽어도 게임은 정상 동작한다.</b>
 *
 * <p>주입 방식은 <b>테스트 전용 시임이 아니라 진짜 DB 장애</b>다: {@code business_events} 테이블을
 * 잠시 치워 INSERT 가 실제로 실패하게 만든다. 프로덕션 코드에 "실패하는 척" 스위치를 심으면
 * 그 스위치가 검증하는 것은 스위치지 실패 경로가 아니다.
 *
 * <p>판정은 상태코드가 아니다(AdminGateTest 규율) — <b>부수효과가 정확히 평소와 같은지</b>를 본다:
 * 지갑 잔액 · 원장 행 수 · 매치 상태 · 보유 카드. 200 을 받았어도 지갑이 안 깎였으면 그건 통과가 아니다.
 *
 * <p>여기에 <b>런타임 백스톱</b> 계약도 같이 있다 — 훅이 실수로 트랜잭션 안에 놓이면 recorder 는
 * <b>쓰지 않는다</b>(쓰면 실패 시 바깥 tx 가 같이 롤백된다). 배치 자체의 계약은
 * {@code BusinessEventHookPlacementTest}(소스 스캔)가 소유한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class BusinessEventNoImpactTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.abandon.sweep-interval-ms", () -> "3600000");
    }

    @org.junit.jupiter.api.AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private BusinessEventRecorder recorder;

    @Resource
    private TxRunner txRunner;

    @Resource
    private online.hmb.match.MatchOrchestrator orchestrator;

    @AfterEach
    void restoreEventTable() {
        healEventTable();
    }

    // ── ② 장애주입: 기록이 전부 실패해도 가입·뽑기·매치종료가 정상 완료 ────

    @SuppressWarnings("unchecked")
    @Test
    void gameKeepsWorkingWhenEveryEventWriteFails() {
        // 기준선: 정상 상태에서 한 판 돌려 "평소 부수효과"를 확정한다.
        String healthyToken = setupUserWithDeck("evt_fi_control");
        String healthyId = userIdOf("evt_fi_control");
        long healthyGemsBefore = gems(healthyId);
        pullGacha(healthyToken);
        long healthyGemCost = healthyGemsBefore - gems(healthyId);
        assertThat(healthyGemCost).as("기준선에서 실제로 재화가 움직였다").isPositive();
        assertThat(eventCount()).as("기준선은 이벤트를 남긴다 — 아래 0 이 의미를 가지려면").isPositive();

        long eventsBeforeOutage = eventCount();
        breakEventTable();

        // ① 가입 — 온보딩(지갑·스타터팩·원장)이 통째로 트랜잭션이다.
        String token = login("evt_fi_signup");
        assertThat(token).isNotBlank();
        String userId = userIdOf("evt_fi_signup");
        assertThat(gems(userId)).isEqualTo(6000);        // 픽스처 initialGems
        assertThat(points(userId)).isEqualTo(3000);      // 픽스처 initialPoints
        assertThat(ownedCards(userId)).as("스타터 팩이 지급됐다").isPositive();

        // ② 뽑기 — 차감 + 원장 + 보유풀이 한 트랜잭션. 여기가 깨지면 재화가 사라진다.
        String deckToken = setupUserWithDeck("evt_fi_signup");
        long gemsBefore = gems(userId);
        long gemLedgerBefore = gemLedgerRows(userId);
        long cardsBefore = ownedCards(userId);
        ResponseEntity<Map> gacha =
                authPost("/api/shop/gacha", deckToken, Map.of("kind", "single"), Map.class);
        assertThat(gacha.getStatusCode()).as(String.valueOf(gacha.getBody())).isEqualTo(HttpStatus.OK);
        assertThat(((List<Object>) gacha.getBody().get("results"))).hasSize(1);
        assertThat(gemsBefore - gems(userId)).isEqualTo(healthyGemCost);
        assertThat(gemLedgerRows(userId)).isEqualTo(gemLedgerBefore + 1);
        assertThat(ownedCards(userId)).isGreaterThanOrEqualTo(cardsBefore);

        // ③ 매치 시작·종료 — 정산(스코어·result·보상·관계·성장)이 한 트랜잭션.
        String matchId = createMatch(deckToken, null);
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
        long pointsBeforeSettle = points(userId);
        jdbcClient.sql("""
                        UPDATE matches SET state = 'SECOND_HALF', score_h1_home = 2, score_h1_away = 0,
                               score_h2_home = 1, score_h2_away = 0, phase_start_at = ?, phase_ends_at = NULL
                        WHERE id = ?
                        """)
                .params(Instant.now().toString(), matchId)
                .update();
        assertThat(orchestrator.settleFinishedIfDue(matchId, null))
                .as("기록이 죽었다고 정산이 실패하면 안 된다").isTrue();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        assertThat(jdbcClient.sql("SELECT result FROM matches WHERE id = ?").param(matchId)
                .query(String.class).single()).isEqualTo("WIN");
        assertThat(points(userId)).as("보상이 정상 지급됐다").isEqualTo(pointsBeforeSettle + 500);
        assertThat(rewardLedgerRows(matchId)).isEqualTo(1);

        // ④ 그 사이 이벤트는 **하나도 늘지 않았다** = 정말로 전부 실패했다(주입이 발화했다는 증거).
        healEventTable();
        assertThat(eventCount())
                .as("장애 중 기록이 늘었다면 주입이 발화하지 않은 것이고 위 단정은 전부 공허하다")
                .isEqualTo(eventsBeforeOutage);
    }

    /** recorder 는 <b>어떤 경우에도 던지지 않는다</b> — 호출부에 try/catch 가 없기 때문이다. */
    @Test
    void recorderNeverThrowsEvenWhenTheTableIsGone() {
        breakEventTable();
        assertThatCode(() -> recorder.record("user_signup", "no-such-user", Map.of("k", "v")))
                .doesNotThrowAnyException();
        // props 를 만드는 람다가 던져도 마찬가지다(호출부의 조회가 실패하는 형태).
        assertThatCode(() -> recorder.record("user_signup", "no-such-user", () -> {
            throw new IllegalStateException("props 조회 실패");
        })).doesNotThrowAnyException();
        healEventTable();

        // 직렬화 불가한 props 도 이벤트를 통째로 버리지 않는다(사실 > 속성).
        assertThatCode(() -> recorder.record("user_signup", "u-json",
                Map.of("bad", new Object()))).doesNotThrowAnyException();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM business_events WHERE user_id = 'u-json'")
                .query(Long.class).single()).isEqualTo(1);

        // probe 도 같은 계약 — 실패하면 기본값을 돌려준다(호출부가 계속 간다).
        assertThat(recorder.probe(() -> {
            throw new IllegalStateException("사전 조회 실패");
        }, "fallback")).isEqualTo("fallback");
    }

    // ── 런타임 백스톱: 트랜잭션 안에서는 쓰지 않는다 ──────────────────────

    /**
     * 소스 스캔(배치 계약)이 못 잡는 형태 — 런타임 호출 체인이 tx 안으로 들어가는 경우 — 의
     * 마지막 방어선. 쓰지 않는 쪽이 옳다: 여기서 INSERT 하면 실패 시 <b>바깥 트랜잭션이 같이
     * 롤백</b>되어 계측이 본 동작을 되돌린다.
     */
    @Test
    void recordingIsSkippedInsideATransactionSoItCanNeverRollBackTheCaller() {
        String marker = "tx-guard-" + Instant.now().toEpochMilli();

        Boolean committed = txRunner.run(() -> {
            recorder.record("user_signup", marker, Map.of("inside", true));
            // 같은 트랜잭션의 진짜 쓰기 — 이게 커밋돼야 "본 동작은 무사하다"가 관측된다.
            jdbcClient.sql("INSERT INTO meta_kv(key, value) VALUES (?, ?)")
                    .params(marker, "ok").update();
            return true;
        });

        assertThat(committed).isTrue();
        assertThat(jdbcClient.sql("SELECT value FROM meta_kv WHERE key = ?").param(marker)
                .query(String.class).single()).isEqualTo("ok");
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM business_events WHERE user_id = ?")
                .param(marker).query(Long.class).single())
                .as("트랜잭션 안에서는 기록하지 않는다(#492 무영향 2차 방어)")
                .isZero();

        // 같은 호출이 트랜잭션 **밖**에서는 정상적으로 기록된다 — 위 0 이 "recorder 가 고장났다"가
        // 아니라 "게이트가 발화했다"임을 가른다.
        recorder.record("user_signup", marker, Map.of("inside", false));
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM business_events WHERE user_id = ?")
                .param(marker).query(Long.class).single()).isEqualTo(1);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** 진짜 DB 장애: 테이블을 치운다 → 모든 INSERT 가 "no such table" 로 실패한다. */
    private void breakEventTable() {
        jdbcClient.sql("ALTER TABLE business_events RENAME TO business_events__outage").update();
    }

    private void healEventTable() {
        Long gone = jdbcClient.sql(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='business_events__outage'")
                .query(Long.class).single();
        if (gone != null && gone > 0) {
            jdbcClient.sql("ALTER TABLE business_events__outage RENAME TO business_events").update();
        }
    }

    private void pullGacha(String token) {
        assertThat(authPost("/api/shop/gacha", token, Map.of("kind", "single"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    private long eventCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM business_events").query(Long.class).single();
    }

    private long gems(String userId) {
        return jdbcClient.sql("SELECT gems FROM wallets WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private long points(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private long gemLedgerRows(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM gem_ledger WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private long ownedCards(String userId) {
        return jdbcClient.sql("SELECT COALESCE(SUM(count), 0) FROM user_players WHERE user_id = ?")
                .param(userId).query(Long.class).single();
    }

    private long rewardLedgerRows(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE ref_id = ? AND reason LIKE 'reward_%'")
                .param(matchId).query(Long.class).single();
    }
}
