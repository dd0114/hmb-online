package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import online.hmb.match.BotService;
import online.hmb.match.MatchService;
import online.hmb.match.PromptContextBuilder;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 원정도 A(베이스) 프리페치를 한다 — #402 W1 AC3.
 *
 * <p><b>왜</b>(코드+데이터 양쪽 확증, #402 W1): {@code MatchController.create}(연습)와
 * {@code LeagueController.nextMatch}(리그)는 매치를 만든 뒤 {@code prefetchBaseInputs} 를 부르는데
 * <b>{@code AwayController.start} 에만 그 호출이 없었다</b>. 결과로 원정은 유저 A 도 고스트 A 도
 * 매치 흐름에서 예열되지 않는다 — 라이브 07-31 이후 원정 봇 사이드 풀생성 9건 중 <b>9건 전부</b>
 * 그 id 의 A 행이 DB 에 아예 없었다.
 *
 * <p>AC1(고스트 키 정렬)과 <b>서로를 대체하지 않는다</b>: AC1 은 수비자가 이미 만들어 둔 A 를 찾게
 * 하고, 이 프리페치는 수비자가 그런 A 를 갖고 있지 않을 때(구 규약 유저·저장 이력 없음) 킥오프
 * 임계경로 밖에서 만들기 시작한다.
 *
 * <p>박제하는 불변식: ① 원정 시작 = 공격자 A + 고스트 A 가 그 자리에서 큐에 선다 ② 수비자 A 가 이미
 * done 이면 원정 킥오프의 상대 사이드는 <b>콜 0</b>(재사용) ③ 프리페치 실패가 원정 생성을 깨뜨리지
 * 않는다(연습·리그와 같은 자리·같은 형태).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class AwayBasePrefetchTest extends MatchTestBase {

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
    private PromptContextBuilder contextBuilder;

    @Resource
    private BotService botService;

    @Resource
    private MatchService matchService;

    @BeforeEach
    void clearPrewarmLedger() {
        jdbcClient.sql("DELETE FROM deck_prewarm").update();
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private static List<Map<String, Object>> slots11PlusBench(String twist) {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(i == 11 && twist != null
                    ? slot(String.format("P%03d", i), "starter", i - 1, twist)
                    : slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        return slots;
    }

    private void saveDeck(String token, String teamPrompt, String twist) {
        Map<String, Object> body = new HashMap<>();
        body.put("formation", "4-4-2");
        body.put("slots", slots11PlusBench(twist));
        if (teamPrompt != null) {
            body.put("teamPrompt", teamPrompt);
        }
        assertThat(authPut("/api/deck", token, body, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    /** 서버가 그 상대를 제시한 상태로 만들어 두고 <b>공개 API</b> 로 원정을 시작한다(컨트롤러 관통). */
    @SuppressWarnings("unchecked")
    private String startAway(String attackerToken, String attackerId, String defenderId) {
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(attackerId, "[\"" + defenderId + "\"]", java.time.Instant.now().toString())
                .update();
        ResponseEntity<Map> res = authPost("/api/away/matches", attackerToken,
                Map.of("defenderId", defenderId), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) res.getBody().get("id");
    }

    private long baseRows() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL")
                .query(Long.class).single();
    }

    private String ghostBaseId(String matchId) {
        MatchService.MatchRow match = matchService.find(matchId).orElseThrow();
        return contextBuilder.botBaseJob(match, botService.get(match.botId())).baseId();
    }

    private String userBaseId(String matchId) {
        MatchService.MatchRow match = matchService.find(matchId).orElseThrow();
        return contextBuilder.userBaseJob(match, matchService.readJson(match.userDeckJson())).baseId();
    }

    private String h1JobKind(String matchId, String side) {
        String json = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = 1 AND side = ? AND effective = 1
                        """)
                .params(matchId, side).query(String.class).single();
        return contextBuilder.readJson(json).path("kind").asText();
    }

    private boolean baseExists(String baseId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE id = ? AND match_id IS NULL")
                .param(baseId).query(Long.class).single() > 0;
    }

    // ── ① 원정 생성 = 양측 A 프리페치 ────────────────────────────────────

    /**
     * <b>이 테스트가 라이브 누락을 박제한다.</b> 원정을 시작하면 그 자리에서 공격자 A 와 고스트 A 가
     * 큐에 서야 한다 — 연습({@code MatchController.create})·리그({@code LeagueController.nextMatch})와
     * 같은 자리다. 수비자가 A 를 갖고 있지 않은 상태(구 규약 유저)를 재현해, 프리페치 말고는 그 A 가
     * 생길 경로가 없게 만든다.
     */
    @Test
    void startingAnAwayMatchPrefetchesBothBases() {
        String defender = setupOpponentWithDeck("awpf_def");
        saveDeck(defender, "수비자 팀 지시", "원정프리페치_수비자");
        String attacker = setupUserWithDeck("awpf_atk");
        saveDeck(attacker, null, "원정프리페치_공격자");
        // 07-30 이전 유저 재현: 활성 덱은 있는데 A 는 어디에도 없다.
        jdbcClient.sql("DELETE FROM ai_jobs WHERE match_id IS NULL").update();
        jdbcClient.sql("DELETE FROM deck_prewarm").update();
        assertThat(baseRows()).isZero();

        String matchId = startAway(attacker, userIdOf("awpf_atk"), userIdOf("awpf_def"));

        assertThat(baseExists(ghostBaseId(matchId)))
                .as("고스트 A 가 원정 생성 즉시 큐에 있어야 한다 — 없으면 킥오프가 20~180초 풀생성")
                .isTrue();
        assertThat(baseExists(userBaseId(matchId))).as("공격자 A 도 같은 자리에서 선다").isTrue();
        assertThat(baseRows()).isEqualTo(2L);
    }

    // ── ② 수비자가 저장해 둔 인풋을 상대 사이드가 그대로 쓴다(콜 0) ─────────

    /**
     * AC1 + AC3 의 결합 결과 = <b>원정 도전 → 킥오프 시 상대 사이드가 {@code materialized}</b>.
     * 수비자가 덱 저장으로 만든 A 가 done 이면 원정은 AI 콜 없이 즉시 시작한다.
     */
    @Test
    void awayKickoffReusesTheDefendersStoredInputWithZeroCalls() {
        String defender = setupOpponentWithDeck("awpf_reuse_d");
        saveDeck(defender, "우리는 압박한다", "원정재사용_수비자");
        String attacker = setupUserWithDeck("awpf_reuse_a");
        saveDeck(attacker, null, "원정재사용_공격자");
        assertThat(fakeServants.drain()).as("양측 A 가 준비된 상태").isEqualTo(2);

        String matchId = startAway(attacker, userIdOf("awpf_reuse_a"), userIdOf("awpf_reuse_d"));
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", attacker, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        assertThat(h1JobKind(matchId, "away"))
                .as("상대(고스트) 사이드 = 수비자가 이미 만들어 둔 인풋 재사용(콜 0)")
                .isEqualTo("materialized");
        assertThat(h1JobKind(matchId, "home")).isEqualTo("materialized");
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }
}
