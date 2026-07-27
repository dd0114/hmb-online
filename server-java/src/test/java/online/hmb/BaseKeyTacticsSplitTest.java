package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * A(베이스) 캐시 키에서 <b>수동 전술(manualTactics)을 분리</b>한다 — #215 W2-B1.
 *
 * <p><b>왜</b>(라이브 실측, #215 W1 addendum): A 프리페치는 <b>매치 생성 시점 스냅샷</b>으로 키를 만드는데
 * 그때는 전술이 없고, 킥오프의 {@code recaptureSnapshotAtKickoff} 가 브리핑 최종 전술을
 * 스냅샷에 <b>새로 넣은 뒤</b> 같은 키를 다시 계산한다. 전술이 한쪽에만 있으니 두 키는 절대 같아지지
 * 않아 <b>A 가 done 이어도 조회 자체가 실패</b>했다(브라우저 유저 100% 풀생성). 실측 근거: 라이브
 * A 잡 컨텍스트엔 manualTactics 가 없고, 같은 매치 스냅샷엔 {@code {0.5,0.5,0.5,0.5}} 가 있었다 —
 * 즉 <b>슬라이더를 손대지 않은 기본값</b>에도 미스가 났다.
 *
 * <p><b>규약</b>: A = <b>덱만</b>(포메이션·로스터·덱 프롬프트). 전술은 A 가 모르는 <b>매치 시점 입력</b>이라
 * 프롬프트와 같은 자리(B 패치)에서 얹는다. 그래서 전술이 있으면 재사용(materialize)이 아니라 패치로
 * 간다 — 패치 컨텍스트는 이미 manualTactics 를 싣고 실행기도 그 블록을 렌더한다(코드 추가 없음).
 *
 * <p>박제하는 불변식: ① 전술 유무는 A 키를 바꾸지 않는다(=A 잡이 새로 생기지 않는다) ② A 컨텍스트엔
 * manualTactics 가 없다 ③ 전술이 있으면 프롬프트가 없어도 B 패치로 간다 ④ 전술이 없으면 기존대로
 * 재사용(콜0) — 무회귀 ⑤ <b>전 축 중앙(=슬라이더 안 건드림)은 미지정과 같다</b> — 브리핑 UI 가 손대지
 * 않아도 {@code {0.5×4}} 를 항상 보내므로, 이걸 지정으로 보면 무변경 경기가 영영 콜0으로 못 간다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class BaseKeyTacticsSplitTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry); // 주제는 키 분리 — 라우팅은 끈다
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private ObjectMapper objectMapper;

    private static final Map<String, Object> NEUTRAL_TACTICS =
            Map.of("line", 0.5, "press", 0.5, "tempo", 0.5, "width", 0.5);

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** A(덱 베이스)가 채워진 브리핑 매치 — 유저 A + 봇 A 2건이 done 이 된다. */
    private String warmBriefing(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(fakeServants.drain()).isEqualTo(2);
        return matchId;
    }

    private void submitPre(String token, String matchId, String text) {
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", text), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    private void kickoff(String token, String matchId, Map<String, Object> tactics) {
        Map<String, Object> body = tactics == null ? Map.of() : Map.of("teamTactics", tactics);
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, body, Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
    }

    /** A(베이스) 잡 행 수 — match_id IS NULL 이 A 의 표식(AiJobQueue.enqueueBase). */
    private long baseJobRows() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL")
                .query(Long.class).single();
    }

    private JsonNode h1Context(String matchId, String side) {
        String json = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = 1 AND side = ? AND effective = 1
                        """)
                .params(matchId, side).query(String.class).single();
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private JsonNode baseContextOf(String formationHint) {
        String json = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id IS NULL AND context_json LIKE ?
                        """)
                .param("%\"formation\":\"" + formationHint + "\"%")
                .query(String.class).list().get(0);
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ── ①② A 는 덱만 안다 ────────────────────────────────────────────────

    /**
     * A 컨텍스트에 manualTactics 가 없다 — A 는 덱 성향이지 매치 전술이 아니다. (있으면 그 전술로 만든
     * A 가 다른 전술 유저에게 재사용돼 <b>남의 슬라이더가 섞인다</b>.)
     */
    @Test
    void baseJobContextCarriesNoManualTactics() {
        String token = setupUserWithDeck("basekey_ctx");
        // 매치를 **전술과 함께** 만든다 — 그래야 A 조립 경로가 실제로 전술을 보고도 버리는지 확인된다
        // (전술 없이 만들면 이 테스트는 어떤 구현에서도 통과해 변이를 못 죽인다).
        assertThat(authPost("/api/matches", token,
                Map.of("botId", "BOT_BAL", "teamTactics", NEUTRAL_TACTICS), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(fakeServants.drain()).isEqualTo(2);

        JsonNode userBase = baseContextOf("4-4-2");
        assertThat(userBase.path("matchId").asText()).isEqualTo("BASE");
        assertThat(userBase.has("manualTactics")).isFalse();
    }

    /**
     * 같은 덱이면 <b>전술을 달리 준 두 매치가 같은 A 를 쓴다</b> — A 잡은 첫 매치에서 만든 1개뿐.
     * (분리 전에는 전술마다 A 가 따로 생겨 크로스매치 캐시가 사실상 무력화됐다.)
     */
    @Test
    void twoMatchesWithDifferentTacticsShareOneBaseJob() {
        String token = setupUserWithDeck("basekey_share");
        assertThat(authPost("/api/matches", token,
                Map.of("botId", "BOT_BAL", "teamTactics", NEUTRAL_TACTICS), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        fakeServants.drain();
        long afterFirst = baseJobRows();

        assertThat(authPost("/api/matches", token,
                Map.of("botId", "BOT_BAL",
                        "teamTactics", Map.of("line", 0.9, "press", 0.1, "tempo", 0.7, "width", 0.3)),
                Map.class).getStatusCode()).isEqualTo(HttpStatus.CREATED);

        assertThat(baseJobRows()).as("전술이 달라도 A 는 덱 것 하나").isEqualTo(afterFirst);
    }

    /**
     * ① <b>이 테스트가 라이브 버그를 박제한다.</b> 킥오프가 전술을 실어 보내도 A 키는 그대로여야 한다 —
     * 즉 킥오프 조회가 기존 A 를 찾아내고 <b>A 잡이 새로 생기지 않는다</b>. (수정 전에는 킥오프 시점
     * 키가 달라져 A 를 못 찾고 풀생성으로 갔다.)
     */
    @Test
    void kickoffTacticsDoNotChangeTheBaseKey() {
        String token = setupUserWithDeck("basekey_same");
        String matchId = warmBriefing(token);
        long basesBefore = baseJobRows();

        submitPre(token, matchId, "측면을 넓게 써라");
        kickoff(token, matchId, NEUTRAL_TACTICS);

        assertThat(baseJobRows()).isEqualTo(basesBefore); // A 재생성 0
        JsonNode home = h1Context(matchId, "home");
        assertThat(home.path("kind").asText())
                .as("A 를 찾았으면 풀생성(team-input)이 아니라 A 위의 패치여야 한다")
                .isEqualTo("team-input-patch");
        assertThat(home.path("base").isObject()).isTrue();
    }

    /**
     * <b>슬라이더를 건드리지 않은 유저는 콜0이어야 한다.</b> 브리핑 UI 는 수동 전술이 기본이라 손대지
     * 않아도 킥오프에 {@code {0.5×4}} 를 항상 싣는다 — 그걸 "지정된 전술"로 보면 아무것도 바꾸지 않은
     * 유저의 <b>모든</b> 경기가 패치(수 초~수십 초)로 가서 "무변경이면 즉시 시작"이 영영 발동하지 않는다.
     */
    @Test
    void untouchedNeutralSlidersStillMeanZeroCalls() {
        String token = setupUserWithDeck("basekey_neutral");
        String matchId = warmBriefing(token);

        kickoff(token, matchId, NEUTRAL_TACTICS); // 프롬프트 없음 + 슬라이더 안 건드림

        assertThat(h1Context(matchId, "home").path("kind").asText())
                .as("중앙 슬라이더는 미지정과 같다 — A 재사용(콜0)")
                .isEqualTo("materialized");
    }

    // ── ③ 전술은 B(패치) 입력 ────────────────────────────────────────────

    /** 프롬프트가 하나도 없어도 전술이 있으면 패치다 — A 는 그 전술을 모르기 때문. */
    @Test
    void tacticsAloneRouteToPatchAndReachTheContext() {
        String token = setupUserWithDeck("basekey_patch");
        String matchId = warmBriefing(token);

        kickoff(token, matchId, Map.of("line", 0.8, "press", 0.9, "tempo", 0.3, "width", 0.2));

        JsonNode home = h1Context(matchId, "home");
        assertThat(home.path("kind").asText()).isEqualTo("team-input-patch");
        assertThat(home.path("manualTactics").path("line").asDouble()).isEqualTo(0.8);
        assertThat(home.path("manualTactics").path("press").asDouble()).isEqualTo(0.9);
    }

    // ── ④ 무회귀: 전술 없으면 콜0 ────────────────────────────────────────

    /** 전술도 프롬프트도 없으면 기존대로 A 재사용(materialize, 서번트 왕복 0). */
    @Test
    void noTacticsNoPromptStillReusesTheBaseWithZeroCalls() {
        String token = setupUserWithDeck("basekey_reuse");
        String matchId = warmBriefing(token);

        kickoff(token, matchId, null);

        assertThat(h1Context(matchId, "home").path("kind").asText()).isEqualTo("materialized");
        assertThat(h1Context(matchId, "away").path("kind").asText()).isEqualTo("materialized");
    }
}
