package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.annotation.Resource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import online.hmb.engine.LiveEngineConfigService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #383 W2 — <b>계수 오버레이 스냅샷이 매치에 박힌다</b> (T-J1~J4, T-J8).
 *
 * <p>이 파일 하나가 지키는 명제: <b>오버레이를 바꿔도 이미 시작한 경기는 건드리지 않는다.</b>
 * 그게 #241(버전 범프 배포가 진행 중 매치를 FAILED 로 밀어낸 사건)의 재발 방지선이고, 이 기능이
 * 존재해도 되는 유일한 조건이다.
 *
 * <p>판정은 <b>러너가 실제로 받은 요청 본문</b>으로 한다(FakeEngineRunner 가 기록한다) — DB 컬럼을
 * 읽어 확인하면 "저장은 했는데 안 보냈다"가 통과한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class EngineConfigSnapshotTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private LiveEngineConfigService liveConfig;

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /**
     * 각 테스트를 <b>오버레이 없음</b>에서 시작시킨다. 클래스 단위로 DB 를 공유하므로 앞 테스트가
     * 남긴 리비전이 다음 테스트로 샌다(실제로 T-J8 이 그렇게 한 번 거짓 실패했다).
     *
     * <p>초기화를 SQL DELETE 로 하지 않는 이유: 서비스가 현재 리비전을 캐시하므로 행만 지우면
     * 캐시가 남고, 그러면 테스트가 <b>운영에 존재하지 않는 상태</b>를 만든다. 공개 롤백 경로
     * (빈 오버레이 리비전)로 되돌리면 초기화 자체가 계약의 일부가 된다.
     */
    @org.junit.jupiter.api.BeforeEach
    void resetLiveOverrides() {
        setupUserWithDeck("cfg_actor");   // 원장의 actor FK 대상
        setLive(Map.of(), "test-reset");
    }

    private void setLive(Map<String, Object> overrides, String reason) {
        liveConfig.recordRevision(userIdOf("cfg_actor"), overrides, "hash-" + overrides.hashCode(),
                reason, null, "req-" + overrides.hashCode() + reason);
    }

    /** 킥오프 → 서번트 드레인 → h1 시뮬까지 밀어붙인다. */
    private void driveToHalfTime(String token, String matchId) {
        RUNNER.requests.clear();
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
    }

    private void driveToFinish(String token, String matchId) {
        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", java.util.List.of()), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
    }

    private JsonNode overridesSentForHalf(int half) {
        JsonNode req = RUNNER.lastRequestForHalf(half);
        assertThat(req).as("러너가 half=%s 요청을 받았어야 한다", half).isNotNull();
        return req.get("configOverrides"); // 없으면 null
    }

    // ── T-J8 : 기본값(오버레이 무설정) ───────────────────────────────────

    @Test
    void withNoLiveOverridesTheRunnerRequestHasNoConfigOverridesKeyAtAll() {
        String token = setupUserWithDeck("cfg_none");
        String matchId = createMatch(token, "BOT_BAL");
        driveToHalfTime(token, matchId);

        // "빈 객체를 보낸다"도 아니고 **키 자체가 없다** — 기존 배포와 완전히 같은 와이어여야
        // 이 웨이브가 단독으로 안전하다고 말할 수 있다.
        assertThat(overridesSentForHalf(1)).isNull();
    }

    // ── T-J2 : 설정 이후 생성된 매치 ────────────────────────────────────

    @Test
    void matchesCreatedAfterAChangePickUpTheNewOverrides() {
        String token = setupUserWithDeck("cfg_after");
        setLive(Map.of("contest.shootRange", 22), "after-test");

        String matchId = createMatch(token, "BOT_BAL");
        driveToHalfTime(token, matchId);

        JsonNode sent = overridesSentForHalf(1);
        assertThat(sent).isNotNull();
        assertThat(sent.path("contest.shootRange").asInt()).isEqualTo(22);
    }

    // ── T-J1 : #241 핵심 — 진행 중 매치는 옛 값으로 끝난다 ────────────────

    @Test
    void aChangeDuringAnOngoingMatchNeverReachesThatMatch() {
        String token = setupUserWithDeck("cfg_ongoing");
        setLive(Map.of("contest.shootRange", 19), "before-match");

        String matchId = createMatch(token, "BOT_BAL");     // ← 여기서 19 가 박힌다

        // 브리핑 중에 운영이 값을 바꾼다(현실적인 타이밍 — 브리핑은 유저가 오래 머무는 화면이다).
        setLive(Map.of("contest.shootRange", 33), "mid-briefing");

        driveToHalfTime(token, matchId);
        assertThat(overridesSentForHalf(1).path("contest.shootRange").asInt())
                .as("생성 시점 스냅샷(19)이어야 한다 — 브리핑 중 변경이 새어 들어오면 안 된다")
                .isEqualTo(19);

        // 후반 사이에 또 바꿔도 마찬가지다.
        setLive(Map.of("contest.shootRange", 44), "mid-halftime");
        driveToFinish(token, matchId);
        assertThat(overridesSentForHalf(2).path("contest.shootRange").asInt())
                .as("h2 도 같은 스냅샷이어야 한다 — 한 매치는 config 하나로만 돈다")
                .isEqualTo(19);
    }

    // ── T-J3 : 두 하프가 같은 스냅샷 ────────────────────────────────────

    @Test
    void bothHalvesOfOneMatchCarryTheIdenticalSnapshot() {
        String token = setupUserWithDeck("cfg_halves");
        setLive(Map.of("contest.shootRange", 21, "decisionWeights.shoot", 0.4), "halves");

        String matchId = createMatch(token, "BOT_BAL");
        driveToHalfTime(token, matchId);
        JsonNode h1 = overridesSentForHalf(1);
        driveToFinish(token, matchId);
        JsonNode h2 = overridesSentForHalf(2);

        assertThat(h2).isEqualTo(h1);
    }

    // ── 하프 번들에 실적이 남는다 (재현 계약 §3) ──────────────────────────

    @Test
    void theHalfBundleRecordsWhatWasActuallyUsed() {
        String token = setupUserWithDeck("cfg_bundle");
        setLive(Map.of("contest.shootRange", 25), "bundle");

        String matchId = createMatch(token, "BOT_BAL");
        driveToHalfTime(token, matchId);

        String stored = jdbcClient
                .sql("SELECT config_overrides_json FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(String.class).single();
        assertThat(stored).contains("contest.shootRange").contains("25");
    }

    /**
     * 독립검증 M1 — <b>"실제로 무슨 config 로 돌았나"가 진짜로 저장되는가.</b>
     *
     * <p>이 계약이 없을 때 {@code effective_config_hash} 에 null 을 기록하는 변이체가 전체 953
     * 테스트를 통과했다(가짜 러너가 그 필드를 안 줘서 파싱·저장 경로가 한 번도 안 돌았다).
     * #385 와 같은 형태다 — 로컬 게이트가 전부 green 인데 실환경에서만 빈다.
     */
    @Test
    void theHalfBundleRecordsTheEffectiveConfigFingerprint() {
        String token = setupUserWithDeck("cfg_hash");
        setLive(Map.of("contest.shootRange", 29), "지문");

        String matchId = createMatch(token, "BOT_BAL");
        driveToHalfTime(token, matchId);
        String h1Hash = effectiveHashOf(matchId, 1);
        assertThat(h1Hash).as("러너가 준 유효 config 지문이 저장돼야 한다").isNotBlank();

        driveToFinish(token, matchId);
        assertThat(effectiveHashOf(matchId, 2))
                .as("한 매치는 config 하나로만 돈다 — 두 하프의 지문이 다르면 그건 다른 경기다")
                .isEqualTo(h1Hash);
    }

    private String effectiveHashOf(String matchId, int half) {
        return jdbcClient
                .sql("SELECT effective_config_hash FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half).query(String.class).single();
    }

    // ── T-J4 : INSERT 지점 전수 (소스를 직접 센다) ────────────────────────

    @Test
    void everyMatchInsertCarriesTheConfigSnapshot() throws Exception {
        // 구현 코드가 들고 있는 "경로 목록"과 대조하면 **구현과 검증이 같은 실수를 공유**한다
        // (AdminUnitPurgeTest 의 REFERENCING_TABLES 선례). 소스를 직접 읽어 센다.
        String source = Files.readString(Path.of("src/main/java/online/hmb/match/MatchService.java"));

        Matcher m = Pattern.compile("INSERT INTO matches\\(([^)]*)\\)").matcher(source);
        int found = 0;
        while (m.find()) {
            found++;
            assertThat(m.group(1))
                    .as("MatchService 의 %d 번째 'INSERT INTO matches' 가 config 스냅샷을 안 싣는다 — "
                            + "새 매치 모드를 추가했다면 그 모드만 계수가 안 먹는다", found)
                    .contains("config_overrides_json");
        }
        assertThat(found)
                .as("MatchService 에서 'INSERT INTO matches' 를 하나도 못 찾았다 — 정규식이 낡았다")
                .isGreaterThanOrEqualTo(3);
    }

    // ── 원장 ────────────────────────────────────────────────────────────

    @Test
    void revisionsAreAppendOnlyAndTheLatestWins() {
        setLive(Map.of("contest.shootRange", 11), "rev-1");
        setLive(Map.of("contest.shootRange", 12), "rev-2");

        assertThat(liveConfig.current().overrides().path("contest.shootRange").asInt()).isEqualTo(12);
        assertThat(liveConfig.history(10).size())
                .as("과거 리비전은 지워지지 않는다 — 매치가 리비전 id 로 근거를 가리킨다")
                .isGreaterThanOrEqualTo(2);
    }

    @Test
    void anEmptyOverrideRevisionIsTheRollbackPath() {
        String token = setupUserWithDeck("cfg_rollback");
        setLive(Map.of("contest.shootRange", 30), "set");
        setLive(Map.of(), "rollback-to-defaults");

        String matchId = createMatch(token, "BOT_BAL");
        driveToHalfTime(token, matchId);
        // 빈 오버레이 = 기본값 = **키를 아예 안 보낸다**(러너 입장에서 오늘과 동일).
        assertThat(overridesSentForHalf(1)).isNull();
    }
}
