package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#256 시드 v2.4 소비 계약</b>(hero 확정 2026-07-29) — <b>현행 소비본</b>이다
 * ({@code application.yml} 의 {@code hmb.data.players-file} 이 이 파일을 가리킨다).
 *
 * <p>{@link PlayerCatalogV23SeedTest} · {@link PlayerCatalogV22SeedTest} 는 남겨 둔다 — 그쪽은
 * {@code @DynamicPropertySource} 로 각자의 버전을 <b>명시 지정</b>하므로 기본 설정이 v2.4 로
 * 넘어가도 계속 통과하는 <b>회귀 가드</b>다(과거 발행물이 여전히 임포트 가능한가). 경쟁하지 않는다.
 *
 * <p>v2.3 대비 델타는 <b>행 2개 append</b> 하나뿐이다(스키마 무변경):
 * <ul>
 *   <li><b>P181 석다이크</b>(DF ← Virgil van Dijk) — 아트는 #207 3차 입고분. 채번이 없어
 *       {@code pendingCatalog} 로 놀고 있던 것을 이번에 붙였다.</li>
 *   <li><b>P182 오시야스</b>(GK ← Iker Casillas) — 아트·채번 동시(4차 입고).</li>
 * </ul>
 *
 * <p>둘 다 <b>{@code active:false} 로 들어온다</b>. 아트 머지 → 배포 → <b>어드민 카탈로그 API
 * 토글</b>이 운영 순서고(#207 U-D5 와 동일), 시드는 런타임 상태가 아니기 때문이다.
 *
 * <p>왜 파일이 아니라 <b>DB 결과 상태</b>를 보는가: 시드가 옳아도 임포터가 신규 행을 넣지
 * 못하거나 {@code active} 를 왕복시키지 못하면 DB 는 다른 상태로 뜬다 — data 쪽 파일 테스트로는
 * 절대 안 잡히는 실패다.
 */
@SpringBootTest
class PlayerCatalogV24SeedTest {

    /** U-D1 — 획득 경로에서 빠지는 구 LEGEND 14종(등급은 LEGEND 유지). */
    private static final List<String> LEGACY_LEGENDS = List.of(
            "P001", "P002", "P003", "P004", "P005", "P006", "P007", "P008", "P009", "P010",
            "P011", "P012", "P143", "P144");

    /** U-D5 — 실아트 미입고라 비활성으로 들어오는 #207 신규 3종. */
    private static final List<String> V23_NEW_INACTIVE = List.of("P174", "P178", "P180");

    /** #256 — 아트는 있지만 활성화 대기(어드민 토글)라 비활성으로 들어오는 신규 2종. */
    private static final List<String> V24_NEW_INACTIVE = List.of("P181", "P182");

    /** 획득 가능한 LEGEND = #207 실아트 입고 5종뿐(v2.3 과 동일 — v2.4 는 여기를 안 건드린다). */
    private static final List<String> ACTIVE_LEGENDS = List.of(
            "P173", "P175", "P176", "P177", "P179");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        try {
            Path dbFile = Files.createTempFile("hmb-test-v24-", ".db");
            Files.deleteIfExists(dbFile);
            registry.add("hmb.db.path", () -> dbFile.toAbsolutePath().toString());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        // 기본 설정(application.yml)과 같은 파일을 명시 지정한다 — 기본값이 다음 버전으로 넘어가도
        // 이 테스트는 "v2.4 가 임포트 가능한가"를 계속 지킨다(v2.2/v2.3 테스트와 같은 이유).
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.4.json");
        registry.add("hmb.data.economy-file", () -> "src/test/resources/fixtures/economy.v1.json");
        registry.add("hmb.data.bots-file", () -> "src/test/resources/fixtures/bots.v1.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
    }

    @Resource
    private JdbcClient jdbcClient;

    /** {@code attributes_json}(shared PlayerAttributes 9종)을 이름→값 맵으로 읽는다. */
    private static java.util.Map<String, Integer> readAttributes(String json) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readValue(
                    json, new com.fasterxml.jackson.core.type.TypeReference<
                            java.util.LinkedHashMap<String, Integer>>() {});
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("attributes_json 파싱 실패: " + json, e);
        }
    }

    @Test
    void v24SeedAppendsTwoLegendsInactiveAndLeavesEverythingElseUntouched() {
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single())
                .as("v2.4 = 172 + #207 8종 + #256 2종").isEqualTo(182L);

        assertThat(jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'players_version'")
                .query(String.class).single()).isEqualTo("v2.4");

        // ── 신규 2종이 실제로 들어왔고, 이름·포지션·등급이 hero 확정과 일치한다.
        assertThat(jdbcClient.sql("SELECT name FROM players WHERE id = 'P181'")
                .query(String.class).single()).isEqualTo("석다이크");
        assertThat(jdbcClient.sql("SELECT position FROM players WHERE id = 'P181'")
                .query(String.class).single()).isEqualTo("DF");
        assertThat(jdbcClient.sql("SELECT name FROM players WHERE id = 'P182'")
                .query(String.class).single()).isEqualTo("오시야스");
        assertThat(jdbcClient.sql("SELECT position FROM players WHERE id = 'P182'")
                .query(String.class).single()).isEqualTo("GK");
        for (String id : V24_NEW_INACTIVE) {
            assertThat(jdbcClient.sql("SELECT grade FROM players WHERE id = ?").param(id)
                    .query(String.class).single()).as(id + " 등급").isEqualTo("LEGEND");
        }

        // ── 스탯은 **LEGEND 밴드(80~95)** 안이다. 소스 실선수(판다이크 = DIA 등급)의 값을 그대로
        //    복사한 것이 아니라 밴드 롤이라는 뜻 — 값 복사였다면 여기가 뚫린다.
        for (String id : V24_NEW_INACTIVE) {
            String json = jdbcClient.sql("SELECT attributes_json FROM players WHERE id = ?")
                    .param(id).query(String.class).single();
            java.util.Map<String, Integer> attrs = readAttributes(json);
            assertThat(attrs).as(id + " 능력치 9종").hasSize(9);
            attrs.forEach((k, v) -> assertThat(v)
                    .as(id + " " + k + " 가 LEGEND 밴드(80~95) 밖")
                    .isBetween(80, 95));
        }

        // ── 비활성 = 구 14종 + #207 미입고 3종 + #256 신규 2종. **정확히** 그 19개다
        //    (개수만 세면 엉뚱한 19개여도 통과한다).
        List<String> expectedInactive = new java.util.ArrayList<>(LEGACY_LEGENDS);
        expectedInactive.addAll(V23_NEW_INACTIVE);
        expectedInactive.addAll(V24_NEW_INACTIVE);
        java.util.Collections.sort(expectedInactive);
        assertThat(jdbcClient.sql("SELECT id FROM players WHERE active = 0 ORDER BY id")
                .query(String.class).list()).containsExactlyElementsOf(expectedInactive);

        // ── U-D1 손실 0 — 비활성 처리하면서 등급까지 내리지 않았다.
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM players WHERE active = 0 AND grade <> 'LEGEND'")
                .query(Long.class).single())
                .as("비활성 처리하면서 등급까지 내렸다 — U-D1(손실 0) 위반").isZero();

        // ── 획득 가능한 LEGEND 집합은 v2.3 과 **동일**하다. v2.4 는 순수 append 이므로
        //    기존 유저가 뽑을 수 있는 것이 늘지도 줄지도 않는다(활성화는 어드민 몫).
        assertThat(jdbcClient.sql(
                        "SELECT id FROM players WHERE grade = 'LEGEND' AND active = 1 ORDER BY id")
                .query(String.class).list()).containsExactlyElementsOf(ACTIVE_LEGENDS);

        // ── v2.3 의 이름 정정이 그대로 살아 있다(레이어가 과거를 덮지 않았다).
        assertThat(jdbcClient.sql("SELECT name FROM players WHERE id = 'P175'")
                .query(String.class).single()).isEqualTo("열라도나");
        assertThat(jdbcClient.sql("SELECT name FROM players WHERE id = 'P179'")
                .query(String.class).single()).isEqualTo("욱링엄");

        // ── 부팅 임포트는 아무것도 잠그지 않는다 — 잠금은 어드민 API 만 세운다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE admin_locked <> 0")
                .query(Long.class).single()).isZero();
    }

    /**
     * <b>알려진 갭을 침묵시키지 않고 박제한다</b> — 채번만으로는 <b>획득 가능한 LEGEND 에 GK·DF 가
     * 여전히 0명</b>이다. 신규 2종이 {@code active:false} 로 들어오기 때문이다.
     *
     * <p>{@link PlayerCatalogV23SeedTest} 의 같은 이름 테스트와 <b>같은 성질을 다른 시점에</b>
     * 건다: 그쪽은 "아트가 없어서" 0, 이쪽은 "아트는 있는데 아직 안 켜서" 0 이다. 그래서 아래
     * 두 번째 단언이 중요하다 — <b>켜기만 하면 갭이 닫힌다</b>는 것을 같이 박아, 남은 일이
     * 데이터 작업이 아니라 <b>어드민 토글</b>임을 코드가 말하게 한다.
     *
     * <p>어드민이 P181/P182 를 활성화하면 이 테스트의 첫 단언이 <b>실패하며</b> 갭이 닫혔음을
     * 알린다. 그때 갱신하라. 침묵하는 0 은 "의도"와 "사고"를 구분하지 못한다.
     */
    @Test
    void obtainableLegendsStillHaveNoGoalkeeperOrDefenderUntilTheNewTwoAreActivated() {
        assertThat(jdbcClient.sql(
                        "SELECT DISTINCT position FROM players WHERE grade = 'LEGEND' AND active = 1"
                                + " ORDER BY position")
                .query(String.class).list())
                .as("획득 가능한 LEGEND 포지션 구성이 바뀌었다 — 어드민이 켰다면 이 테스트를 갱신하라")
                .containsExactly("FW", "MF");

        // 켜면 닫힌다 — 카탈로그에 DF/GK LEGEND 가 실제로 준비돼 있다는 증거.
        assertThat(jdbcClient.sql(
                        "SELECT position FROM players WHERE grade = 'LEGEND' AND id IN ('P181','P182')"
                                + " ORDER BY position")
                .query(String.class).list()).containsExactly("DF", "GK");
    }
}
