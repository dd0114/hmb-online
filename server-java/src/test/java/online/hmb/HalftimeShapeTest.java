package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
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
 * 감독시간 <b>포메이션 + 선발 배치(슬롯)</b> 변경 — #276 (hero 결정: "덱 구성과 같은 조작으로 통일").
 *
 * <p><b>공백이었던 것</b>: 감독시간이 받는 것은 {@code substitutions}(#66)와 {@code teamTactics}(#254)
 * 뿐이라 <b>포메이션·슬롯을 실을 자리가 없었다</b>. 엔진은 이미 후반 배치를 수용한다
 * ({@code applyDelta} 가 {@code basePosition}→{@code baseFx}, {@code resetFormationOnKickoff} 이 후반
 * 킥오프에 전 선수를 재정렬) — 없던 것은 <b>서버가 받는 자리</b> 하나였다.
 *
 * <p><b>#254 와 딱 하나 다른 지점</b>: 전술은 B(패치) 입력이라 패치로 보낼 수 있지만 배치는 아니다.
 * {@code packages/shared/src/tactical-patch.ts} 가 <i>"formation 은 A(덱) 소유라 패치 불가"</i>라고 못을
 * 박아 뒀고 패치 프롬프트({@code coach.ts})는 <b>베이스의</b> 포메이션을 출력한다 → 패치로 보내면 AI 가
 * 바뀐 줄 모르고 {@code basePosition} 11개를 그대로 물려준다(<b>조용한 무시</b>). 그래서 배치가 바뀌면
 * 유저 사이드는 <b>풀 생성</b>으로 강제한다 — 교체({@code subsPresent})가 이미 같은 이유로 같은 분기다.
 *
 * <p>박제하는 불변식:
 * <ol>
 *   <li>배치 제출 → 후반 <b>실효 스냅샷</b>의 formation·slotIndex 가 바뀐다(AI 컨텍스트가 보는 값까지).</li>
 *   <li>미첨부 → 손대지 않음 → 재해소가 풀 생성을 태우지 않는다(콜0, #215 계약).</li>
 *   <li>전반과 <b>같은 배치</b> → 무변경 → 콜0.</li>
 *   <li><b>교체 + 배치 동시</b> → 투입 선수가 배치가 지정한 슬롯에 선다(핵심 케이스).</li>
 *   <li>전반 기록({@code user_deck_json})은 후반 배치로 덮이지 않는다(소급 변조 금지).</li>
 *   <li>검증 400 {@code SHAPE_INVALID} — 11명 아님/슬롯 중복/선수 중복/한쪽만 옴/교체와 모순.</li>
 *   <li>재제출 보존 — substitutions·teamTactics·shape 3필드가 서로를 지우지 않는다.</li>
 *   <li>배치 변경 시 h2 유저 사이드가 풀 생성으로 태워지고 {@code supersede} 로 유효 잡이 1개다.</li>
 * </ol>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class HalftimeShapeTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Map<String, Object> AGGRESSIVE =
            Map.of("line", 0.9, "press", 0.8, "tempo", 0.75, "width", 0.6);

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private online.hmb.match.MatchService matchService;

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** MatchTestBase 덱: 선발 P001(GK,slot0)..P011(slot10), 벤치 P012/P013. */
    private static Map<String, Integer> baseSlots() {
        Map<String, Integer> slots = new LinkedHashMap<>();
        for (int i = 1; i <= 11; i++) {
            slots.put(String.format("P%03d", i), i - 1);
        }
        return slots;
    }

    private static List<Map<String, Object>> startersOf(Map<String, Integer> slots) {
        List<Map<String, Object>> list = new ArrayList<>();
        slots.forEach((playerId, slotIndex) ->
                list.add(Map.of("playerId", playerId, "slotIndex", slotIndex)));
        return list;
    }

    /** 전반을 마치고 감독시간(HALFTIME)에 세운다. */
    private String toHalftime(String nickname) {
        String token = setupUserWithDeck(nickname);
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain(); // A done
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain(); // h1 생성 + 시뮬
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        return matchId;
    }

    /** 유저(home) 후반 유효 잡의 컨텍스트. */
    private String userSecondHalfContext(String matchId) {
        return jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = 2 AND side = 'home' AND effective = 1
                        """)
                .param(matchId).query(String.class).single();
    }

    /** 유저 후반 유효 잡 개수 — supersede 가 (match,half,side) 당 1개를 유지하는지. */
    private long effectiveJobCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs
                        WHERE match_id = ? AND half = ? AND side = 'home' AND effective = 1
                        """)
                .params(matchId, half).query(Long.class).single();
    }

    /** 풀 생성(team-input) 잡 — "team-input-patch" 는 닫는 따옴표 때문에 매칭되지 않는다. */
    private long fullJobCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND side = 'home'
                          AND effective = 1 AND context_json LIKE '%"kind":"team-input"%'
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

    private String snapshotJson(String matchId) {
        return jdbcClient.sql("SELECT user_deck_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }

    private String shapeJson(String matchId) {
        return jdbcClient.sql("SELECT h2_shape_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).optional().orElse(null);
    }

    /** 후반이 <b>실제로 세울</b> 라인업(= {@code snapshotForHalf(row, 2, subs)}). */
    private JsonNode secondHalfSnapshot(String nickname, String matchId) {
        var row = matchService.getOwned(userIdOf(nickname), matchId);
        return matchService.snapshotForHalf(row, 2, List.of());
    }

    private static int snapshotSlotOf(JsonNode snapshot, String playerId) {
        for (JsonNode s : snapshot.path("starters")) {
            if (playerId.equals(s.path("playerId").asText())) {
                return s.path("slotIndex").asInt(-1);
            }
        }
        return -1;
    }

    private static String formationOf(String contextJson) throws Exception {
        return MAPPER.readTree(contextJson).path("formation").asText();
    }

    private static int rosterSlotOf(String contextJson, String playerId) throws Exception {
        JsonNode roster = MAPPER.readTree(contextJson).path("roster");
        for (JsonNode entry : roster) {
            if (playerId.equals(entry.path("playerId").asText())) {
                return entry.path("slotIndex").asInt(-1);
            }
        }
        return -1;
    }

    @SuppressWarnings("unchecked")
    private static String errorRule(org.springframework.http.ResponseEntity<Map> response) {
        Map<String, Object> body = response.getBody();
        Object detail = body == null ? null : body.get("detail");
        return detail instanceof Map<?, ?> map ? String.valueOf(map.get("rule")) : null;
    }

    // ── 1: 배치 제출 → 후반 실효 스냅샷(= AI 컨텍스트)에 반영 ─────────────

    @Test
    void shapeChangeReachesSecondHalfInput() throws Exception {
        String matchId = toHalftime("shape_change");
        String token = login("shape_change");

        // 4-4-2 → 4-3-3 + P002 와 P006 의 슬롯을 맞바꾼다(덱 화면에서 토큰 두 개를 서로 옮긴 것과 같다).
        Map<String, Integer> slots = baseSlots();
        slots.put("P002", 5);
        slots.put("P006", 1);

        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-3-3",
                        "starters", startersOf(slots)), Map.class);

        String context = userSecondHalfContext(matchId);
        assertThat(formationOf(context)).isEqualTo("4-3-3");
        assertThat(rosterSlotOf(context, "P002")).isEqualTo(5);
        assertThat(rosterSlotOf(context, "P006")).isEqualTo(1);

        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    // ── 2~3: 무변경은 콜0 유지 (#215 예산 계약) ──────────────────────────

    @Test
    void noShapeSubmittedKeepsCall0() {
        String matchId = toHalftime("shape_none");
        String token = login("shape_none");

        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);

        assertThat(shapeJson(matchId)).isNull();
        assertThat(fullJobCount(matchId, 2)).isZero();
        assertThat(materializedCount(matchId, 2)).isEqualTo(2L);
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    @Test
    void resubmittingTheSameShapeIsNotAChange() {
        String matchId = toHalftime("shape_same");
        String token = login("shape_same");

        // web 은 보드 현재 상태를 그대로 실어 보낸다 — 안 건드렸는데 재생성되면 감독시간마다 AI 콜이
        // 한 번씩 늘어난다(P2-D8 위반). "같은 배치 = 무변경"이어야 한다.
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-4-2",
                        "starters", startersOf(baseSlots())), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);

        assertThat(shapeJson(matchId)).isNotNull(); // 저장은 됐다(= 판정이 저장 유무가 아니다)
        assertThat(fullJobCount(matchId, 2)).isZero();
        assertThat(materializedCount(matchId, 2)).isEqualTo(2L);
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    /**
     * <b>포메이션만</b> 바꾼 경우도 변경이다 — 유저가 할 수 있는 가장 흔한 조작(FormationSelect 한 번)
     * 이 여기 걸린다. 다른 배치 테스트들은 formation 과 슬롯을 <b>항상 같이</b> 바꿔서,
     * {@link online.hmb.match.MatchService#secondHalfShapeChanged} 의 formation 비교 3줄을 통째로
     * 지워도 전부 통과했다(독립검증 변이체 M2). 그 상태로 회귀하면 포메이션 변경이 h1 인풋 재사용으로
     * 떨어져 <b>조용히 무시</b>된다 — 유저는 4-3-3 을 골랐는데 후반이 4-4-2 로 돈다.
     */
    @Test
    void changingOnlyTheFormationCountsAsAChange() throws Exception {
        String matchId = toHalftime("shape_formonly");
        String token = login("shape_formonly");

        // 슬롯은 전반 그대로(baseSlots), 포메이션만 4-4-2 → 4-3-3.
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-3-3",
                        "starters", startersOf(baseSlots())), Map.class);

        // 패치·재사용이 아니라 풀 생성이어야 한다(포메이션은 패치로 표현할 수 없다).
        assertThat(fullJobCount(matchId, 2)).isEqualTo(1L);
        assertThat(effectiveJobCount(matchId, 2)).isEqualTo(1L);

        String context = userSecondHalfContext(matchId);
        assertThat(formationOf(context)).isEqualTo("4-3-3");
        assertThat(rosterSlotOf(context, "P002")).isEqualTo(1);   // 슬롯은 손대지 않았다
        assertThat(rosterSlotOf(context, "P011")).isEqualTo(10);

        assertThat(secondHalfSnapshot("shape_formonly", matchId).path("formation").asText())
                .isEqualTo("4-3-3");
    }

    // ── 4: 교체 + 배치 동시 (핵심) ──────────────────────────────────────

    @Test
    void substituteInPlayerStandsInTheSlotTheShapeAssigns() throws Exception {
        String matchId = toHalftime("shape_subs");
        String token = login("shape_subs");

        // P011(slot10) → P012 교체. 그리고 그 P012 를 slot3 에 세우고, 원래 slot3 이던 P004 를 slot10 으로.
        // buildRoster 는 스냅샷 starters 를 돌며 out→in 만 치환하고 slotIndex 는 **그 자리 것**을 쓰므로,
        // 배치를 <b>투입 선수 기준</b>으로 되쓰지 않으면 P012 는 P011 의 slot10 을 그대로 물려받는다.
        Map<String, Integer> slots = baseSlots();
        slots.remove("P011");
        slots.put("P004", 10);
        slots.put("P012", 3);

        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P011", "in", "P012")),
                        "formation", "4-3-3", "starters", startersOf(slots)), Map.class);

        String context = userSecondHalfContext(matchId);
        assertThat(formationOf(context)).isEqualTo("4-3-3");
        assertThat(rosterSlotOf(context, "P012")).isEqualTo(3);   // 투입 선수가 지정 슬롯에
        assertThat(rosterSlotOf(context, "P004")).isEqualTo(10);
        assertThat(rosterSlotOf(context, "P011")).isEqualTo(-1);  // 빠진 선수는 로스터에 없다

        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    // ── 5: 전반 기록 불변 ───────────────────────────────────────────────

    @Test
    void firstHalfRecordIsNotRewritten() {
        String matchId = toHalftime("shape_record");
        String token = login("shape_record");

        Map<String, Integer> slots = baseSlots();
        slots.put("P002", 5);
        slots.put("P006", 1);
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-3-3",
                        "starters", startersOf(slots)), Map.class);

        // "나는 전반을 4-4-2 로 뛰었다"가 후반 배치로 사라지면 안 된다 — 스냅샷은 전반의 박제다.
        String snapshot = snapshotJson(matchId);
        assertThat(snapshot).contains("\"formation\":\"4-4-2\"");
        assertThat(snapshot).doesNotContain("4-3-3");
        assertThat(shapeJson(matchId)).contains("4-3-3");
    }

    // ── 6: 검증 400 SHAPE_INVALID ───────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void shapeWithWrongStarterCountIsRejected() {
        String matchId = toHalftime("shape_count");
        String token = login("shape_count");

        Map<String, Integer> slots = baseSlots();
        slots.remove("P011");
        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-3-3",
                        "starters", startersOf(slots)), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().get("code")).isEqualTo("SHAPE_INVALID");
        assertThat(errorRule(response)).isEqualTo("STARTER_COUNT");
        assertThat(shapeJson(matchId)).isNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void duplicateSlotIndexIsRejected() {
        String matchId = toHalftime("shape_slotdup");
        String token = login("shape_slotdup");

        Map<String, Integer> slots = baseSlots();
        slots.put("P002", 2); // P003 과 같은 슬롯
        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-4-2",
                        "starters", startersOf(slots)), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorRule(response)).isEqualTo("SLOT_INDEX_DUPLICATE");
        assertThat(shapeJson(matchId)).isNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void duplicatePlayerIsRejected() {
        String matchId = toHalftime("shape_pdup");
        String token = login("shape_pdup");

        List<Map<String, Object>> starters = new ArrayList<>(startersOf(baseSlots()));
        starters.set(10, Map.of("playerId", "P001", "slotIndex", 10)); // P011 자리에 P001 을 또
        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-4-2", "starters", starters), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorRule(response)).isEqualTo("DUPLICATE_PLAYER");
        assertThat(shapeJson(matchId)).isNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void slotIndexOutOfRangeIsRejected() {
        String matchId = toHalftime("shape_range");
        String token = login("shape_range");

        Map<String, Integer> slots = baseSlots();
        slots.put("P011", 11); // 0..10 밖
        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-4-2",
                        "starters", startersOf(slots)), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorRule(response)).isEqualTo("SLOT_INDEX_RANGE");
        assertThat(shapeJson(matchId)).isNull();
    }

    /** 배치는 한 덩어리다 — formation 만 오거나 starters 만 오면 400(반쪽 배치는 뜻이 없다). */
    @Test
    @SuppressWarnings("unchecked")
    void partialShapeIsRejectedInBothDirections() {
        String matchId = toHalftime("shape_partial");
        String token = login("shape_partial");

        var formationOnly = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-3-3"), Map.class);
        assertThat(formationOnly.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorRule(formationOnly)).isEqualTo("SHAPE_PARTIAL");

        var startersOnly = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "starters", startersOf(baseSlots())), Map.class);
        assertThat(startersOnly.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorRule(startersOnly)).isEqualTo("SHAPE_PARTIAL");

        assertThat(shapeJson(matchId)).isNull();
    }

    @Test
    @SuppressWarnings("unchecked")
    void blankFormationIsRejected() {
        String matchId = toHalftime("shape_noform");
        String token = login("shape_noform");

        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "  ",
                        "starters", startersOf(baseSlots())), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorRule(response)).isEqualTo("FORMATION_REQUIRED");
        assertThat(shapeJson(matchId)).isNull();
    }

    /** 배치의 선발 집합은 (전반 선발 − out + in) 과 정확히 같아야 한다. 같은 요청의 교체 기준. */
    @Test
    @SuppressWarnings("unchecked")
    void shapeContradictingSubstitutionsIsRejected() {
        String matchId = toHalftime("shape_mismatch");
        String token = login("shape_mismatch");

        // 교체는 P011→P012 인데 배치는 아직 P011 을 세우고 있다.
        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P011", "in", "P012")),
                        "formation", "4-4-2", "starters", startersOf(baseSlots())), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().get("code")).isEqualTo("SHAPE_INVALID");
        assertThat(errorRule(response)).isEqualTo("ROSTER_MISMATCH");
        // 부분 저장이 없어야 한다 — 교체만 남고 배치가 빠지면 유저가 짠 것과 다른 팀이 뛴다.
        assertThat(shapeJson(matchId)).isNull();
        assertThat(jdbcClient.sql("SELECT subs_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).optional().orElse(null)).isNull();
    }

    /**
     * 배치 미첨부 재제출도 <b>DB 에 저장된 교체</b>를 기준으로 정합해야 한다 — 그러지 않으면 앞서 낸
     * 배치가 새 교체와 어긋난 채 남아 조용히 무시된다(투입 선수를 배치에서 못 찾아 슬롯 승계로 떨어진다).
     */
    @Test
    @SuppressWarnings("unchecked")
    void storedShapeIsRevalidatedAgainstNewlySubmittedSubstitutions() {
        String matchId = toHalftime("shape_revalidate");
        String token = login("shape_revalidate");

        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("formation", "4-3-3", "starters", startersOf(baseSlots())), Map.class);
        assertThat(shapeJson(matchId)).isNotNull();

        // 이제 교체만 낸다 — 저장된 배치엔 P012 가 없으므로 어긋난다.
        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P011", "in", "P012"))), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(errorRule(response)).isEqualTo("ROSTER_MISMATCH");
    }

    // ── 6-b: 웹이 보드를 항상 함께 보낸다는 전제의 왕복 계약 (독립검증 blocker 2건) ──

    /**
     * <b>blocker-1 — 재제출 400 고착</b>. 배치+교체를 낸 뒤 {@code POST /resume} 이 완료되지 않으면
     * (네트워크 끊김·탭 종료·리로드) 화면 재진입 시 보드는 매치 스냅샷 원본에서 다시 시작한다.
     *
     * <p>그때 웹이 배치를 <b>빼고</b> {@code substitutions:[]} 만 보내면
     * {@link #storedShapeIsRevalidatedAgainstNewlySubmittedSubstitutions} 가 박제한 대로 <b>400
     * ROSTER_MISMATCH</b> 다 — 살아남은 이전 배치와 새 교체가 어긋나기 때문. 유저는 몇 번을 눌러도
     * 400 이라 후반을 시작할 수 없었다. 400 을 없애는 게 아니라(그건 계약 방어다) <b>웹이 보드 현재
     * 상태를 항상 함께 보내면</b> 그 모순 자체가 생기지 않는다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void resubmittingTheWholeBoardAfterARemountIsAcceptedAndWins() {
        String matchId = toHalftime("shape_remount");
        String token = login("shape_remount");

        // ① 보드로 교체 + 배치 제출
        Map<String, Integer> slots = baseSlots();
        slots.remove("P011");
        slots.put("P004", 10);
        slots.put("P012", 3);
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P011", "in", "P012")),
                        "formation", "4-3-3", "starters", startersOf(slots)), Map.class);
        assertThat(shapeJson(matchId)).contains("P012");

        // ② 재마운트 — 보드가 스냅샷 원본에서 다시 시작하고, 웹은 그 상태를 통째로 싣는다.
        var response = authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-4-2",
                        "starters", startersOf(baseSlots())), Map.class);
        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();

        // 저장된 배치가 화면과 일치한다 — 이전 배치가 살아남지 않는다.
        assertThat(shapeJson(matchId)).contains("4-4-2").doesNotContain("P012");
        JsonNode h2 = secondHalfSnapshot("shape_remount", matchId);
        assertThat(h2.path("formation").asText()).isEqualTo("4-4-2");
        assertThat(snapshotSlotOf(h2, "P011")).isEqualTo(10);
        assertThat(snapshotSlotOf(h2, "P004")).isEqualTo(3);

        // 전반과 같은 배치로 수렴했으므로 재생성도 없다(#215 콜0).
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        assertThat(fullJobCount(matchId, 2)).isZero();
        assertThat(materializedCount(matchId, 2)).isEqualTo(2L);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    /**
     * <b>blocker-2 — 취소한 배치가 조용히 후반에 반영</b>. 배치를 바꿔 제출한 뒤 유저가 보드를
     * 원상복구하고 재제출하면 후반은 <b>전반 배치</b>로 돌아와야 한다. 배치를 안 보내면
     * {@code COALESCE} 가 이전 배치를 남겨 400 도 없이 취소된 배치로 후반이 돈다(유저는 취소했다고
     * 믿는다). 되돌린 뒤에는 전반과 같으므로 <b>풀 생성도 0</b> 이다.
     */
    @Test
    void revertingTheBoardRestoresTheFirstHalfShapeAndCostsNoCall() {
        String matchId = toHalftime("shape_revert");
        String token = login("shape_revert");

        // ① 배치만 바꿔 제출 — 변경이므로 풀 생성 1콜
        Map<String, Integer> slots = baseSlots();
        slots.put("P002", 5);
        slots.put("P006", 1);
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-3-3",
                        "starters", startersOf(slots)), Map.class);
        assertThat(fullJobCount(matchId, 2)).isEqualTo(1L);

        // ② 유저가 원상복구 → 웹이 base 배치를 명시 전송
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-4-2",
                        "starters", startersOf(baseSlots())), Map.class);

        JsonNode h2 = secondHalfSnapshot("shape_revert", matchId);
        assertThat(h2.path("formation").asText()).isEqualTo("4-4-2");
        assertThat(snapshotSlotOf(h2, "P002")).isEqualTo(1);
        assertThat(snapshotSlotOf(h2, "P006")).isEqualTo(5);

        // 되돌렸으니 전반 인풋 재사용 — 유효 풀 생성 잡이 남아 있으면 안 된다(#215).
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        assertThat(fullJobCount(matchId, 2)).isZero();
        assertThat(effectiveJobCount(matchId, 2)).isEqualTo(1L);
        assertThat(materializedCount(matchId, 2)).isEqualTo(2L);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    // ── 7: 재제출 보존 (3필드 상호 비파괴) ──────────────────────────────

    @Test
    void threeFieldsDoNotEraseEachOtherOnResubmit() {
        String matchId = toHalftime("shape_resubmit");
        String token = login("shape_resubmit");

        Map<String, Integer> slots = baseSlots();
        slots.remove("P011");
        slots.put("P012", 10);

        // ① 교체 + 배치 + 전술을 한 번에
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P011", "in", "P012")),
                        "teamTactics", AGGRESSIVE,
                        "formation", "4-3-3", "starters", startersOf(slots)), Map.class);

        // ② 전술만 고쳐 재제출 — 교체·배치가 지워지면 안 된다
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("teamTactics", Map.of("line", 0.1, "press", 0.2, "tempo", 0.3, "width", 0.4)),
                Map.class);
        assertThat(shapeJson(matchId)).contains("4-3-3").contains("P012");
        assertThat(jdbcClient.sql("SELECT subs_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single()).contains("P012");

        // ③ 교체만 재제출 — 배치·전술이 지워지면 안 된다
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P011", "in", "P012"))), Map.class);
        assertThat(shapeJson(matchId)).contains("4-3-3");
        assertThat(jdbcClient.sql("SELECT h2_tactics_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single()).contains("\"line\":0.1");

        // ④ 배치만 재제출 — 교체·전술이 지워지면 안 된다
        Map<String, Integer> slots2 = baseSlots();
        slots2.remove("P011");
        slots2.put("P012", 4);
        slots2.put("P005", 10);
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("formation", "3-5-2", "starters", startersOf(slots2)), Map.class);
        assertThat(shapeJson(matchId)).contains("3-5-2");
        assertThat(jdbcClient.sql("SELECT subs_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single()).contains("P012");
        assertThat(jdbcClient.sql("SELECT h2_tactics_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single()).contains("\"line\":0.1");
    }

    // ── 8: 풀 생성 강제 + 유효 잡 1개 ───────────────────────────────────

    @Test
    void shapeChangeForcesFullGenerationWithASingleEffectiveJob() throws Exception {
        String matchId = toHalftime("shape_full");
        String token = login("shape_full");

        Map<String, Integer> slots = baseSlots();
        slots.put("P002", 5);
        slots.put("P006", 1);

        // 두 번 제출(감독시간엔 여러 번 부를 수 있다) — supersede 가 유효 잡 1개를 유지해야 한다.
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-3-3",
                        "starters", startersOf(slots)), Map.class);
        slots.put("P003", 7);
        slots.put("P008", 2);
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(), "formation", "4-3-3",
                        "starters", startersOf(slots)), Map.class);

        // 패치가 아니라 풀 생성이어야 한다 — 패치 프롬프트는 베이스의 포메이션을 출력하므로
        // 배치 변경을 패치로 보내면 AI 가 바뀐 줄 모르고 basePosition 11개를 그대로 물려준다.
        assertThat(fullJobCount(matchId, 2)).isEqualTo(1L);
        assertThat(effectiveJobCount(matchId, 2)).isEqualTo(1L);
        assertThat(materializedCount(matchId, 2)).isEqualTo(1L); // 봇 사이드만 재사용(종전대로)

        String context = userSecondHalfContext(matchId);
        assertThat(context).contains("\"kind\":\"team-input\"");
        assertThat(rosterSlotOf(context, "P003")).isEqualTo(7);
        assertThat(rosterSlotOf(context, "P008")).isEqualTo(2);
    }
}
