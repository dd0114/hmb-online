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
 * <b>#207 시드 v2.3 소비 계약</b>(hero 결정 U-D5/U-D6) — <b>현행 소비본</b>이다
 * ({@code application.yml} 의 {@code hmb.data.players-file} 이 이 파일을 가리킨다).
 *
 * <p>{@link PlayerCatalogV22SeedTest} 는 남겨 둔다 — 그쪽은 {@code @DynamicPropertySource} 로
 * v2.2 를 <b>명시 지정</b>하므로 기본 설정이 v2.3 으로 넘어가도 계속 통과하는 <b>회귀 가드</b>다
 * (과거 발행물이 여전히 임포트 가능한가). 두 파일은 경쟁하지 않는다.
 *
 * <p>v2.2 대비 델타는 두 축뿐이다:
 * <ul>
 *   <li><b>이름 정정 2건</b>(U-D6) — 유라도나→열라도나(P175), 욱리엄→욱링엄(P179).
 *       정본은 <b>카드 아트</b>다(이름이 아트에 구워져 발행됐다).</li>
 *   <li><b>활성 5 / 비활성 3</b>(U-D5) — 실아트 입고분만 활성. 미입고 3종(P174 권씨·P178 석신·
 *       P180 경니시우스)은 <b>삭제가 아니라 플래그</b>라, 아트가 나오면 어드민 카탈로그 API
 *       토글 한 번으로 <b>배포 없이</b> 켜진다.</li>
 * </ul>
 *
 * <p>왜 파일이 아니라 <b>DB 결과 상태</b>를 보는가: 시드가 옳아도 임포터가 {@code active} 를
 * 왕복시키지 못하면 DB 는 전원 활성으로 뜬다 — data 쪽 파일 테스트로는 절대 안 잡히는 실패다.
 */
@SpringBootTest
class PlayerCatalogV23SeedTest {

    /** U-D1 — 획득 경로에서 빠지는 구 LEGEND 14종(등급은 LEGEND 유지). */
    private static final List<String> LEGACY_LEGENDS = List.of(
            "P001", "P002", "P003", "P004", "P005", "P006", "P007", "P008", "P009", "P010",
            "P011", "P012", "P143", "P144");

    /** U-D5 — 실아트 미입고라 비활성으로 들어오는 신규 3종. */
    private static final List<String> NEW_INACTIVE = List.of("P174", "P178", "P180");

    /** U-D5 — 실아트 입고 완료라 획득 가능한 신규 5종. */
    private static final List<String> ACTIVE_LEGENDS = List.of(
            "P173", "P175", "P176", "P177", "P179");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        try {
            Path dbFile = Files.createTempFile("hmb-test-v23-", ".db");
            Files.deleteIfExists(dbFile);
            registry.add("hmb.db.path", () -> dbFile.toAbsolutePath().toString());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        // 기본 설정(application.yml)과 같은 파일을 명시 지정한다 — 기본값이 다음 버전으로 넘어가도
        // 이 테스트는 "v2.3 이 임포트 가능한가"를 계속 지킨다(v2.2 테스트와 같은 이유).
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.3.json");
        registry.add("hmb.data.economy-file", () -> "src/test/resources/fixtures/economy.v1.json");
        registry.add("hmb.data.bots-file", () -> "src/test/resources/fixtures/bots.v1.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void v23SeedAppliesNameCorrectionsAndActivatesOnlyTheFiveWithArt() {
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single())
                .as("v2.3 = 172 + 신규 8").isEqualTo(180L);

        assertThat(jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'players_version'")
                .query(String.class).single()).isEqualTo("v2.3");

        // ── U-D6 이름 정정 — 정본은 카드 아트다.
        assertThat(jdbcClient.sql("SELECT name FROM players WHERE id = 'P175'")
                .query(String.class).single()).isEqualTo("열라도나");
        assertThat(jdbcClient.sql("SELECT name FROM players WHERE id = 'P179'")
                .query(String.class).single()).isEqualTo("욱링엄");

        // ── U-D5 비활성 = 구 14종 + 신규 미입고 3종. **정확히** 그 17개다
        //    (개수만 세면 엉뚱한 17개여도 통과한다).
        List<String> expectedInactive = new java.util.ArrayList<>(LEGACY_LEGENDS);
        expectedInactive.addAll(NEW_INACTIVE);
        java.util.Collections.sort(expectedInactive);
        assertThat(jdbcClient.sql("SELECT id FROM players WHERE active = 0 ORDER BY id")
                .query(String.class).list()).containsExactlyElementsOf(expectedInactive);

        // ── U-D1 손실 0 — 비활성 처리하면서 등급까지 내리지 않았다.
        //    등급을 내렸다면 GRADE_BAND 상한이 함께 내려가 기보유 카드의 성장 캡이 깎인다
        //    (성★이 높을수록 더 깎이는 역진). 그 손실 0 이 U-D1 의 핵심이라 여기서 못박는다.
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM players WHERE active = 0 AND grade <> 'LEGEND'")
                .query(Long.class).single())
                .as("비활성 처리하면서 등급까지 내렸다 — U-D1(손실 0) 위반").isZero();

        // ── 획득 가능한 LEGEND = 실아트 입고 5종뿐.
        assertThat(jdbcClient.sql(
                        "SELECT id FROM players WHERE grade = 'LEGEND' AND active = 1 ORDER BY id")
                .query(String.class).list()).containsExactlyElementsOf(ACTIVE_LEGENDS);

        // ── 미입고 3종은 **지워지지 않고 남아 있다** — 아트가 나오면 어드민 API 토글 한 번으로
        //    켜진다(배포 불필요). 이게 "삭제가 아니라 플래그"의 실질이다.
        for (String id : NEW_INACTIVE) {
            assertThat(jdbcClient.sql("SELECT grade FROM players WHERE id = ?").param(id)
                    .query(String.class).optional())
                    .as(id + " 이 카탈로그에서 사라졌다 — 비활성은 삭제가 아니다").contains("LEGEND");
        }

        // ── 부팅 임포트는 아무것도 잠그지 않는다 — 잠금은 어드민 API 만 세운다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE admin_locked <> 0")
                .query(Long.class).single()).isZero();
    }

    /**
     * <b>알려진 갭을 침묵시키지 않고 박제한다</b> — 현재 <b>획득 가능한 LEGEND 에 GK·DF 가 0명</b>이다.
     *
     * <p>U-D4 가 석다이크(DF)를 빼고 석신(GK)을 넣어 GK 0 을 한 번 해소했는데, U-D5 에서 석신이
     * <b>실아트 미입고</b>로 비활성이 되면서 GK 가 다시 0 이 됐고 DF 도 0 이다. 즉 유저는 최고등급
     * 골키퍼·수비수를 <b>영영 뽑을 수 없다</b>(구 14종의 야신·말디니 등은 LEGEND 등급에 남아 있지만
     * 획득 경로가 없다).
     *
     * <p>이 테스트는 "이게 옳다"고 주장하지 않는다 — <b>현재 상태를 명시적으로 관측 가능하게</b> 만들어
     * 둘 뿐이다. 아트가 입고돼 석신이 활성화되면 이 테스트가 <b>실패하며</b> 갭이 닫혔음을 알린다.
     * 침묵하는 0 은 "의도"와 "사고"를 구분하지 못한다.
     */
    @Test
    void obtainableLegendsCurrentlyHaveNoGoalkeeperOrDefender() {
        List<String> positions = jdbcClient.sql(
                        "SELECT DISTINCT position FROM players WHERE grade = 'LEGEND' AND active = 1"
                                + " ORDER BY position")
                .query(String.class).list();

        assertThat(positions)
                .as("획득 가능한 LEGEND 포지션 구성이 바뀌었다 — 아트 입고로 갭이 닫혔다면 이 테스트를 갱신하라")
                .containsExactly("FW", "MF");
    }
}
