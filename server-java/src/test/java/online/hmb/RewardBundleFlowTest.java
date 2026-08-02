package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>보상 봉투</b>(#405 W2b, 설계 §2.9) — 경기 종료 → 재화/성장 한 장 → [확인].
 *
 * <p>계약 9: <b>봉투 멱등</b>(같은 매치가 두 번 정산돼도 봉투는 하나) + <b>ack 멱등</b>
 * (다시 확인해도 200, 확인 시각은 처음 것 유지 — 덮으면 "언제 봤나"가 재시도마다 미래로 밀린다).
 *
 * <p>재화는 <b>코드만</b> 실린다(#232) — 이름·심볼이 서버 응답에 있으면 표기 변경이 곧 배포다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class RewardBundleFlowTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchClockSweeper clockSweeper;

    @SuppressWarnings("unchecked")
    @Test
    void finishedMatchResultCarriesARewardBundleWithCurrencyAndGrowth() {
        String token = setupUserWithDeck("rb_flow");
        String matchId = driveToFinished(token);

        ResponseEntity<Map> res = authGet("/api/matches/" + matchId + "/result", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> bundle = (Map<String, Object>) res.getBody().get("rewardBundle");
        assertThat(bundle).as("결과 응답에 보상 봉투가 additive 로 실려야 한다(설계 §2.9)").isNotNull();
        assertThat(bundle.get("source")).isEqualTo("MATCH");
        assertThat(bundle.get("sourceRef")).isEqualTo(matchId);
        assertThat(bundle.get("acknowledgedAt")).isNull();

        List<Map<String, Object>> sections = (List<Map<String, Object>>) bundle.get("sections");
        List<String> kinds = sections.stream().map(s -> (String) s.get("kind")).toList();
        assertThat(kinds).contains("CURRENCY", "GROWTH");

        Map<String, Object> currency = sections.stream()
                .filter(s -> "CURRENCY".equals(s.get("kind"))).findFirst().orElseThrow();
        List<Map<String, Object>> entries = (List<Map<String, Object>>) currency.get("entries");
        assertThat(entries).isNotEmpty();
        assertThat(entries.get(0)).containsOnlyKeys("code", "amount");
        // ⚠️ 재화 이름·심볼이 새면 표기 변경(#232)이 곧 배포가 된다.
        assertThat(currency.toString()).doesNotContain("골드").doesNotContain("다이아");

        Map<String, Object> growth = sections.stream()
                .filter(s -> "GROWTH".equals(s.get("kind"))).findFirst().orElseThrow();
        List<Map<String, Object>> growthEntries = (List<Map<String, Object>>) growth.get("entries");
        assertThat(growthEntries).isNotEmpty();
        assertThat(growthEntries.get(0)).containsKeys("playerId", "name", "position", "grade",
                "xpGained", "levelBefore", "levelAfter", "pendingChoices",
                // 목업 화면 ② — 행 XP 진행바 + 미투입/교체 구분의 재료
                "cardXp", "xpToNext", "minutes");
    }

    /**
     * <b>XP 바의 재료는 서버가 계산해 내린다</b>(목업 화면 ②). 클라가 {@code xpToNext} 곡선을 미러하면
     * {@code xp.lvBase}/{@code lvPow} 를 무배포로 돌리는 순간 <b>화면만 옛 곡선</b>으로 그려진다 —
     * §2.8 이 막으려는 바로 그 상태다. 그래서 계약은 "필드가 있다"가 아니라 <b>관계</b>로 건다:
     * 진행도는 항상 {@code 0 ≤ cardXp < xpToNext} 안에 있어야 한다(만렙 제외).
     */
    @SuppressWarnings("unchecked")
    @Test
    void growthEntriesCarryServerComputedXpProgressAndMinutes() {
        String token = setupUserWithDeck("rb_xpbar");
        String matchId = driveToFinished(token);
        Map<String, Object> bundle = (Map<String, Object>) authGet(
                "/api/matches/" + matchId + "/result", token, Map.class).getBody().get("rewardBundle");
        List<Map<String, Object>> sections = (List<Map<String, Object>>) bundle.get("sections");
        List<Map<String, Object>> entries = (List<Map<String, Object>>) sections.stream()
                .filter(s -> "GROWTH".equals(s.get("kind"))).findFirst().orElseThrow().get("entries");

        assertThat(entries).hasSizeGreaterThan(1);
        for (Map<String, Object> e : entries) {
            int cardXp = ((Number) e.get("cardXp")).intValue();
            int xpToNext = ((Number) e.get("xpToNext")).intValue();
            assertThat(cardXp).as("%s", e.get("playerId")).isGreaterThanOrEqualTo(0);
            assertThat(xpToNext).as("%s: 만렙이 아닌데 xpToNext 가 0 이면 바가 영영 안 찬다", e.get("playerId"))
                    .isGreaterThan(0);
            assertThat(cardXp).as("%s: 진행도가 임계를 넘었다 = 레벨업이 안 돌았다", e.get("playerId"))
                    .isLessThan(xpToNext);
            assertThat((String) e.get("minutes")).isIn("starter", "partial", "bench");
        }

        // 미투입 벤치와 선발이 **구분**된다 — 한쪽으로 뭉개지면 화면이 회색 행을 못 그린다.
        java.util.Set<Object> minutes = new java.util.HashSet<>();
        entries.forEach(e -> minutes.add(e.get("minutes")));
        assertThat(minutes).as("선발 11 + 미출전 벤치 2 인데 출전 구분이 한 종류다").hasSizeGreaterThan(1);
        // 미출전은 XP 가 0 이라 레벨이 그대로다(구분이 장식이 아니라 실제 정산과 맞물려 있다).
        Map<String, Object> bench = entries.stream()
                .filter(e -> "bench".equals(e.get("minutes"))).findFirst().orElseThrow();
        assertThat(((Number) bench.get("xpGained")).intValue()).isZero();
        assertThat(bench.get("levelBefore")).isEqualTo(bench.get("levelAfter"));
    }

    @SuppressWarnings("unchecked")
    @Test
    void ackIsIdempotentAndKeepsTheFirstTimestamp() {
        String token = setupUserWithDeck("rb_ack");
        String matchId = driveToFinished(token);
        Map<String, Object> bundle = (Map<String, Object>) authGet(
                "/api/matches/" + matchId + "/result", token, Map.class).getBody().get("rewardBundle");
        String bundleId = (String) bundle.get("bundleId");

        ResponseEntity<Map> first = authPost("/api/rewards/" + bundleId + "/ack", token, Map.of(), Map.class);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        String acknowledgedAt = (String) first.getBody().get("acknowledgedAt");
        assertThat(acknowledgedAt).isNotNull();

        ResponseEntity<Map> second = authPost("/api/rewards/" + bundleId + "/ack", token, Map.of(), Map.class);
        assertThat(second.getStatusCode())
                .as("재시도가 에러가 되면 클라가 영원히 재시도한다").isEqualTo(HttpStatus.OK);
        assertThat(second.getBody().get("acknowledgedAt"))
                .as("확인 시각을 덮으면 '언제 봤나'가 재시도마다 미래로 밀린다").isEqualTo(acknowledgedAt);

        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM reward_bundles WHERE source_ref = ?")
                .param(matchId).query(Long.class).single()).isEqualTo(1L);
    }

    /** 같은 매치의 봉투는 하나뿐이다 — 재정산이 들어와도 유저가 같은 보상을 두 번 보지 않는다. */
    @Test
    void bundleCreationIsIdempotentPerMatch() {
        String token = setupUserWithDeck("rb_idem");
        String userId = userIdOf("rb_idem");
        String matchId = driveToFinished(token);

        // 봉투 생성 경로를 직접 다시 부른다(정산 재진입 시뮬레이션).
        rewardBundleService.create(userId, "MATCH", matchId,
                List.of(new online.hmb.rewards.RewardBundleService.Section("CURRENCY",
                        List.of(online.hmb.rewards.RewardBundleService.currency("POINT", 999)))));

        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM reward_bundles WHERE source_ref = ?")
                .param(matchId).query(Long.class).single()).isEqualTo(1L);
    }

    @Resource
    private online.hmb.rewards.RewardBundleService rewardBundleService;

    /** 남의 봉투는 확인할 수 없다 — 404(존재를 흘리지 않는다). */
    @SuppressWarnings("unchecked")
    @Test
    void someoneElsesBundleIsNotFound() {
        String token = setupUserWithDeck("rb_owner");
        String matchId = driveToFinished(token);
        String bundleId = (String) ((Map<String, Object>) authGet(
                "/api/matches/" + matchId + "/result", token, Map.class).getBody().get("rewardBundle"))
                .get("bundleId");

        String intruder = login("rb_intruder");
        ResponseEntity<Map> res = authPost("/api/rewards/" + bundleId + "/ack", intruder, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /** GrowthSettlementFlowTest 와 같은 패턴 — 시계 창을 강제 만료시켜 FINISHED 까지 민다. */
    @SuppressWarnings("unchecked")
    private String driveToFinished(String token) {
        releaseActiveMatches();
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        for (int i = 0; i < 6 && !"FINISHED".equals(matchState(matchId)); i++) {
            jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                    .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                    .update();
            clockSweeper.sweep();
            fakeServants.drain();
        }
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        return matchId;
    }
}
