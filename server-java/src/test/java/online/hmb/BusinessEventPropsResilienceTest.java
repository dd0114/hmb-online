package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import online.hmb.common.Ulid;
import online.hmb.events.BusinessEventQueryService;
import online.hmb.events.BusinessEventRecorder;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#492</b> — props 가 깨져도 <b>퍼널이 거짓말하지 않는다</b>.
 *
 * <h2>왜 이 계약이 필요한가</h2>
 * AC7 패널 5R 엣지케이스 렌즈가 두 경로를 지목했고 <b>둘 다 유효했다</b>. 공통점은
 * "실패가 예외가 아니라 <b>조용한 0/빈칸</b>으로 나타난다"는 것 — 관측 화면에서 가장 나쁜 실패 모양이다.
 *
 * <ol>
 *   <li><b>쓰기 쪽</b>: props 직렬화가 실패하면 {@code props_json} 이 통째로 NULL 이 됐다. 퍼널은
 *       {@code match_start} 의 {@code props.mode} 로 practice/league/away 를 가르므로
 *       ({@code json_extract(props_json,'$.mode')}), NULL 은 <b>"그 모드를 안 해봤다"로 읽힌다</b>.
 *       hero 의 1급 지표(어디까지 플레이했나)가 거짓이 되는 방향이다.</li>
 *   <li><b>읽기 쪽</b>: 저장된 props 가 깨져 파싱이 실패하면 빈 객체 {@code {}} 로 낮아졌다 —
 *       <b>"속성이 애초에 없었다"와 화면에서 완전히 같아 보인다</b>. 관측 화면이 자기 결손을 숨긴다.</li>
 * </ol>
 *
 * <h2>고친 방향</h2>
 * 쓰기는 <b>스칼라만 남겨 재직렬화</b>한다(퍼널·필터가 읽는 값은 전부 스칼라다). 읽기는 깨진 행에
 * {@code _parseError} 와 원문 일부를 달아 <b>눈에 띄게</b> 한다. 어느 쪽도 <b>이벤트를 버리지 않는다</b> —
 * 계측이 게임을 못 건드리는 것과 같은 이유로, 계측은 자기 자신도 조용히 버리면 안 된다.
 *
 * <h2>공허해지지 않게</h2>
 * ①의 "살아남았다"는 <b>같은 맵의 못 쓰는 값이 실제로 떨어져 나갔다</b>는 것과 같이 봐야 한다 —
 * 안 그러면 "애초에 직렬화가 실패하지 않았다"와 구분되지 않는다(그러면 폭발 객체를 안 넣은 것과 같다).
 * ③도 <b>NULL 행과 나란히</b> 본다 — 깨진 행만 보면 "원래 다 이렇게 나온다"와 구분되지 않는다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class BusinessEventPropsResilienceTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private BusinessEventRecorder recorder;

    @Resource
    private BusinessEventQueryService queryService;

    @Resource
    private JdbcClient jdbcClient;

    /** getter 가 던지는 값 — Jackson 직렬화를 <b>진짜로</b> 실패시킨다(빈 빈 취급 설정에 안 흔들린다). */
    public static final class Exploding {
        public String getBoom() {
            throw new IllegalStateException("직렬화 폭발(테스트)");
        }
    }

    // ── ① 쓰기: 값 하나가 못 써도 퍼널이 읽는 속성은 살아남는다 ──────────

    @Test
    void aBrokenPropValueDoesNotErasePracticeReachFromTheFunnel() {
        String userId = "evt_props_" + Ulid.next();

        Map<String, Object> props = new LinkedHashMap<>();
        props.put("mode", "practice");                 // 퍼널이 읽는 값
        props.put("matchId", "M-" + userId);
        props.put("botId", "BOT_BAL");
        props.put("broken", new Exploding());          // 이것 하나가 통째로 삼키던 값

        assertThatCode(() -> recorder.record("match_start", userId, props))
                .as("계측은 어떤 경우에도 던지지 않는다")
                .doesNotThrowAnyException();

        // 이벤트 자체가 남았다 + 퍼널이 보는 축(mode)이 살아 있다.
        assertThat(storedJson(userId)).as("props 를 통째로 버리지 않았다").isNotNull();
        assertThat(extractedMode(userId)).isEqualTo("practice");

        // 못 쓰는 값은 실제로 떨어져 나갔다 — 이게 없으면 위 단정은 "실패가 안 났다"와 구분되지 않는다.
        assertThat(storedJson(userId)).doesNotContain("broken");
        assertThat(storedJson(userId)).contains("matchId").contains("botId");

        // 핵심: 그래서 퍼널이 이 유저를 "practice 도달"로 센다.
        assertThat(reachedPracticeOf(userId)).as("퍼널의 1급 지표가 거짓이 되지 않는다").isTrue();
    }

    /** 대조군 — 정상 props 는 그대로 다 살아야 한다(폴백이 평소 경로를 갉아먹지 않는다). */
    @Test
    void healthyPropsAreStoredWhole() {
        String userId = "evt_props_ok_" + Ulid.next();
        recorder.record("match_start", userId,
                Map.of("mode", "league", "matchId", "M-ok", "round", 3));

        assertThat(extractedMode(userId)).isEqualTo("league");
        assertThat(storedJson(userId)).contains("round");
        assertThat(reachedLeagueOf(userId)).isTrue();
    }

    // ── ③ 읽기: 깨진 props 는 "속성 없음"과 구분돼 보인다 ────────────────

    @Test
    void aCorruptedRowIsMarkedInsteadOfLookingEmpty() {
        String brokenUser = "evt_broken_" + Ulid.next();
        String nullUser = "evt_null_" + Ulid.next();

        insertRaw(brokenUser, "gacha_pull", "{\"kind\":\"single\", 이건 JSON 이 아니다");
        insertRaw(nullUser, "gacha_pull", null);

        // 깨진 행이 있어도 페이지가 죽지 않는다.
        BusinessEventQueryService.EventPage page =
                queryService.page("gacha_pull", null, null, 200, 0);

        Map<String, Object> broken = propsOfRow(page, brokenUser);
        Map<String, Object> empty = propsOfRow(page, nullUser);

        // 깨진 행 = 표시가 붙고 원문이 보인다.
        assertThat(broken).containsEntry("_parseError", true);
        assertThat((String) broken.get("_raw")).contains("이건 JSON 이 아니다");

        // 속성 없는 행 = 그냥 비어 있다. 이 둘이 다르게 보이는 것이 이 계약의 전부다.
        assertThat(empty).isEmpty();
        assertThat(empty).doesNotContainKey("_parseError");
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private void insertRaw(String userId, String event, String propsJson) {
        jdbcClient.sql("""
                        INSERT INTO business_events(id, event, user_id, occurred_at, props_json)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(Ulid.next(), event, userId, Instant.now().toString(), propsJson)
                .update();
    }

    private String storedJson(String userId) {
        return jdbcClient.sql("SELECT props_json FROM business_events WHERE user_id = ?")
                .param(userId).query(String.class).optional().orElse(null);
    }

    private String extractedMode(String userId) {
        return jdbcClient.sql(
                        "SELECT json_extract(props_json, '$.mode') FROM business_events WHERE user_id = ?")
                .param(userId).query(String.class).optional().orElse(null);
    }

    private boolean reachedPracticeOf(String userId) {
        return funnelOf(userId).reached().practice();
    }

    private boolean reachedLeagueOf(String userId) {
        return funnelOf(userId).reached().league();
    }

    private BusinessEventQueryService.FunnelUser funnelOf(String userId) {
        return queryService.funnel().users().stream()
                .filter(u -> userId.equals(u.userId()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("퍼널에 유저가 없다: " + userId));
    }

    private Map<String, Object> propsOfRow(BusinessEventQueryService.EventPage page, String userId) {
        return page.items().stream()
                .filter(r -> userId.equals(r.userId()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("스트림에 행이 없다: " + userId))
                .props();
    }
}
