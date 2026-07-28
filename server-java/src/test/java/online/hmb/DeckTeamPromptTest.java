package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 덱 <b>팀 전체 프롬프트</b> 저장 관통 — #253 (오픈베타 데이터 유실).
 *
 * <p><b>증상</b>: 덱 화면에서 팀 문장을 쓰고 [저장]을 누르면 화면은 "저장되었습니다"를 띄우는데
 * 리로드하면 값이 사라졌다. 원인은 web 이 아니라 <b>계약</b>이었다 — {@code DeckUpdateRequest} 에
 * 팀 문장을 실을 필드 자체가 없어 PUT 바디가 슬롯만 싣고 나갔다. 선수별 문장은 슬롯의
 * {@code promptText} 로 정상 저장되므로 유저 눈엔 "선수 문장은 남는데 팀 문장만 없어진다"로 보였다.
 *
 * <p><b>왜 저장만으로 안 끝나는가</b>: #215 가 덱 저장 시점에 AI 인풋(A 베이스)을 <b>선실행</b>한다.
 * 팀 문장이 A 의 재료에 빠져 있으면 미리 만들어 둔 인풋과 킥오프의 실제 입력이 <b>다른 내용</b>이 된다
 * — 캐시가 히트해도 유저가 쓴 팀 문장이 반영되지 않은 결과를 쓰게 된다. 그래서 이 클래스는 저장/리로드
 * 뿐 아니라 <b>A 캐시 키·컨텍스트·킥오프 재사용까지 한 줄로</b> 박제한다.
 *
 * <p>박제하는 불변식:
 * <ol>
 *   <li>저장 → 리로드에 값이 남는다(원증상).</li>
 *   <li>공백만 있는 문장은 없는 것으로 정규화된다(빈 문자열로 굳어 캐시 키를 흔들지 않게).</li>
 *   <li>상한 초과는 400 DECK_INVALID(rule=TEAM_PROMPT_TOO_LONG).</li>
 *   <li>팀 문장이 <b>A 컨텍스트에 실린다</b>(AI 가 실제로 읽는다).</li>
 *   <li>팀 문장을 바꾸면 A 가 <b>재생성</b>된다(캐시 키 재료).</li>
 *   <li>선실행한 A 를 킥오프가 <b>그대로 찾아 쓴다</b>(새 A 를 만들지 않는다 = 키 일치).</li>
 *   <li>브리핑이 덱 문장을 그대로 pre 로 제출해도 <b>콜0(재사용)</b>이다 — A 가 이미 쓴 값이라
 *       패치를 태우면 같은 답을 돈 주고 다시 만드는 것이다.</li>
 *   <li>브리핑에서 <b>다른</b> 문장을 쓰면 덮어쓰기(B 패치)로 간다 — 덱 문장은 기본값이다.</li>
 * </ol>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class DeckTeamPromptTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        // 주제는 팀 문장 관통이지 대변경 라우팅(#193 라운드2)이 아니다 — 분기만 보게 라우팅은 끈다.
        TestDbSupport.disableOverhaulRouting(registry);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @BeforeEach
    void clearPrewarmLedger() {
        jdbcClient.sql("DELETE FROM deck_prewarm").update();
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private static List<Map<String, Object>> starters11PlusBench() {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        return slots;
    }

    /** teamPrompt 를 포함한 PUT 바디. {@code null} 이면 필드를 아예 싣지 않는다(구 클라이언트 재현). */
    private static Map<String, Object> deckBodyWithTeamPrompt(String teamPrompt) {
        Map<String, Object> body = new HashMap<>();
        body.put("formation", "4-4-2");
        body.put("slots", starters11PlusBench());
        if (teamPrompt != null) {
            body.put("teamPrompt", teamPrompt);
        }
        return body;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> putDeck(String token, String teamPrompt, HttpStatus expected) {
        var response = authPut("/api/deck", token, deckBodyWithTeamPrompt(teamPrompt), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(expected);
        return response.getBody();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> getDeck(String token) {
        var response = authGet("/api/deck", token, Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return response.getBody();
    }

    /** 이 유저가 선실행으로 기다리는 A 의 id(= 캐시 키). */
    private String prewarmBaseId(String nickname) {
        return jdbcClient.sql("SELECT base_id FROM deck_prewarm WHERE user_id = ?")
                .param(userIdOf(nickname)).query(String.class).optional().orElse(null);
    }

    private String baseContextJson(String baseId) {
        return jdbcClient.sql("SELECT context_json FROM ai_jobs WHERE id = ?")
                .param(baseId).query(String.class).single();
    }

    private long baseJobCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL").query(Long.class).single();
    }

    private long patchJobCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND effective = 1
                          AND context_json LIKE '%"kind":"team-input-patch"%'
                        """)
                .params(matchId, half).query(Long.class).single();
    }

    private long materializedCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND status = 'done'
                          AND effective = 1 AND context_json = '{"kind":"materialized"}'
                        """)
                .params(matchId, half).query(Long.class).single();
    }

    // ── 1~3: 저장 관통 (원증상) ─────────────────────────────────────────

    @Test
    void teamPromptSurvivesSaveAndReload() {
        String token = login("tp_persist");
        putDeck(token, "전원 강하게 압박하고 라인 올려", HttpStatus.OK);

        // 저장 응답과 리로드(GET) 둘 다 값을 돌려줘야 한다 — 원증상은 "응답은 200인데 리로드하면 없다".
        assertThat(getDeck(token).get("teamPrompt")).isEqualTo("전원 강하게 압박하고 라인 올려");

        // 덮어쓰기도 관통한다(전체 교체 시맨틱).
        putDeck(token, "오늘은 수비적으로", HttpStatus.OK);
        assertThat(getDeck(token).get("teamPrompt")).isEqualTo("오늘은 수비적으로");
    }

    @Test
    void blankTeamPromptNormalizesToNull() {
        String token = login("tp_blank");
        putDeck(token, "라인 올려", HttpStatus.OK);
        assertThat(getDeck(token).get("teamPrompt")).isEqualTo("라인 올려");

        // 공백만 남기는 것 = 지우는 것. "" 로 굳으면 문장 없는 덱과 스냅샷 바이트가 달라져
        // A 캐시 키가 원래 자리로 못 돌아온다(지우기 전과도, 애초에 안 쓴 유저와도 다른 키).
        putDeck(token, "   ", HttpStatus.OK);
        assertThat(getDeck(token).get("teamPrompt")).isNull();

        // 필드 미첨부(구 클라이언트)도 전체 교체 시맨틱대로 "없음"이다.
        putDeck(token, "다시 씀", HttpStatus.OK);
        putDeck(token, null, HttpStatus.OK);
        assertThat(getDeck(token).get("teamPrompt")).isNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void tooLongTeamPromptIsRejected() {
        String token = login("tp_long");
        Map<String, Object> body = putDeck(token, "가".repeat(501), HttpStatus.BAD_REQUEST);
        assertThat(body.get("code")).isEqualTo("DECK_INVALID");
        assertThat(((Map<String, Object>) body.get("detail")).get("rule")).isEqualTo("TEAM_PROMPT_TOO_LONG");

        // 경계값(=상한)은 통과해야 한다 — off-by-one 으로 500자를 막으면 그것도 유실이다.
        putDeck(token, "가".repeat(500), HttpStatus.OK);
        assertThat((String) getDeck(token).get("teamPrompt")).hasSize(500);
    }

    /**
     * 구 프리셋 적용이 팀 문장을 지우지 않는다(독립검증 minor-2).
     *
     * <p>{@code teamPrompt} 는 이번에 스냅샷에 들어간 필드라, 그전에 저장된 라이브 프리셋에는 <b>키 자체가
     * 없다</b>. 그걸 "빈 값"으로 읽으면 구 프리셋을 적용하는 순간 방금 쓴 팀 지시가 사라진다 — #253 과
     * 똑같은 종류의 조용한 유실을 프리셋 경로에 새로 만드는 셈이다. 키 없음 = 유지, 키 있음 = 그 값.
     */
    @Test
    void applyingALegacyPresetKeepsTheTeamPrompt() {
        String token = login("tp_preset");
        putDeck(token, "지워지면 안 되는 팀 지시", HttpStatus.OK);

        // 이 필드가 생기기 전에 저장된 프리셋을 그대로 재현한다(스냅샷에 teamPrompt 키 없음).
        String userId = userIdOf("tp_preset");
        StringBuilder starters = new StringBuilder();
        starters.append("{\"playerId\":\"P001\",\"slotIndex\":0}");
        for (int i = 2; i <= 11; i++) {
            starters.append(String.format(",{\"playerId\":\"P%03d\",\"slotIndex\":%d}", i, i - 1));
        }
        String legacySnapshot = "{\"formation\":\"4-4-2\",\"starters\":[" + starters
                + "],\"bench\":[{\"playerId\":\"P012\",\"slotIndex\":0}]}";
        jdbcClient.sql("""
                        INSERT INTO team_presets(id, user_id, slot_no, name, snapshot_json, updated_at)
                        VALUES (?, ?, 1, '구프리셋', ?, '2026-01-01T00:00:00Z')
                        """)
                .params("preset_legacy_" + userId, userId, legacySnapshot)
                .update();

        assertThat(authPost("/api/presets/team/1/apply", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(getDeck(token).get("teamPrompt")).isEqualTo("지워지면 안 되는 팀 지시");
    }

    // ── 4~5: A(베이스) 캐시 재료 (#215 정합) ────────────────────────────

    @Test
    void teamPromptRidesIntoBaseContextAndRekeysTheCache() {
        String token = login("tp_base");
        putDeck(token, "전원 강하게 압박", HttpStatus.OK);

        String first = prewarmBaseId("tp_base");
        assertThat(first).isNotNull();
        // AI 가 실제로 읽는 자리에 들어가야 의미가 있다 — 저장만 되고 컨텍스트에 안 실리면 유실과 같다.
        assertThat(baseContextJson(first)).contains("전원 강하게 압박");

        // 문장을 바꾸면 재료가 바뀌므로 A 도 바뀐다 = 캐시 무효화 규칙을 따로 둘 필요가 없다.
        putDeck(token, "라인 내리고 역습", HttpStatus.OK);
        String second = prewarmBaseId("tp_base");
        assertThat(second).isNotEqualTo(first);
        assertThat(baseContextJson(second)).contains("라인 내리고 역습");

        // 같은 문장으로 되돌리면 원래 A 로 돌아온다(내용 해시 = 멱등).
        putDeck(token, "전원 강하게 압박", HttpStatus.OK);
        assertThat(prewarmBaseId("tp_base")).isEqualTo(first);
    }

    // ── 6~8: 킥오프 실입력과의 일치 (#253 산출물 3) ─────────────────────

    @Test
    void prewarmedBaseIsTheOneKickoffUses() {
        String token = login("tp_kick");
        putDeck(token, "측면 활용해라", HttpStatus.OK);
        fakeServants.drain(); // 선실행 A done

        String prewarmed = prewarmBaseId("tp_kick");
        String matchId = createMatch(token, "BOT_BAL");

        // 매치 생성이 A 를 프리페치한다. 팀 문장이 스냅샷·A 양쪽에 같은 바이트로 들어가면 유저 A 는
        // **이미 있는 그 잡**이고 새로 생기는 건 봇 A 하나뿐이다(= 총 2). 어긋나면 3이 된다 —
        // 이게 #215 W1 이 라이브에서 겪은 "done 인데 조회 실패" 의 재현 지점이다.
        assertThat(baseJobCount()).isEqualTo(2L);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE id = ?")
                .param(prewarmed).query(Long.class).single()).isEqualTo(1L);

        fakeServants.drain(); // 봇 A done
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        // 매치시점 지시가 없으니 양측 재사용(콜0). 팀 문장은 A 안에 이미 반영돼 있다.
        assertThat(materializedCount(matchId, 1)).isEqualTo(2L);
        assertThat(patchJobCount(matchId, 1)).isZero();
    }

    @Test
    void briefingResubmittingTheSameTeamSentenceStaysCall0() {
        String token = login("tp_same");
        putDeck(token, "측면 활용해라", HttpStatus.OK);
        fakeServants.drain();
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain();

        // web 브리핑은 덱의 팀 문장을 그대로 pre 로 제출한다(#244 흐름). "지시가 있다"는 참이지만
        // 내용은 A 가 이미 쓴 것과 같다 — 여기서 패치를 태우면 팀 문장을 쓴 유저만 영영 콜0 을 못 본다.
        authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "측면 활용해라"), Map.class);
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        assertThat(patchJobCount(matchId, 1)).isZero();
        assertThat(materializedCount(matchId, 1)).isEqualTo(2L);
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    @Test
    void briefingOverridesTheDeckSentence() {
        String token = login("tp_override");
        putDeck(token, "측면 활용해라", HttpStatus.OK);
        fakeServants.drain();
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain();

        // 덱 문장은 **기본값**이다 — 이 경기만 다르게 가겠다면 그게 이긴다.
        authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "오늘은 잠그고 역습"), Map.class);
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        assertThat(patchJobCount(matchId, 1)).isEqualTo(1L); // 유저만 B 패치
        assertThat(materializedCount(matchId, 1)).isEqualTo(1L); // 봇은 재사용

        // 패치 컨텍스트의 유효 팀 지시 = 브리핑 문장(덱 문장이 아니다).
        String patchContext = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs WHERE match_id = ? AND half = 1 AND effective = 1
                          AND context_json LIKE '%"kind":"team-input-patch"%'
                        """)
                .param(matchId).query(String.class).single();
        assertThat(patchContext).contains("오늘은 잠그고 역습");

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }
}
