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
 * <b>#207 LEGEND 개편 시드(v2.2) 소비 계약</b> — 부팅 임포트가 신규 8종을 들여오고 구 14종을
 * 비활성으로 앉히는지. 실제 발행물({@code data/players/players.v2.2.json})을 가리킨다.
 *
 * <p>왜 서버 쪽에서 박제하는가: 시드가 옳아도 <b>임포터가 {@code active} 를 왕복시키지 못하면</b>
 * (필드를 안 읽거나 upsert 에서 빠뜨리면) DB 는 전원 활성으로 뜬다 — 파일만 검사하는 data 쪽
 * 테스트로는 절대 안 잡히는 실패다. 여기서 보는 것은 <b>파일이 아니라 DB 의 결과 상태</b>다.
 */
@SpringBootTest
class PlayerCatalogV22SeedTest {

    /** hero 결정 U-D1 — 획득 경로에서 빠지는 구 LEGEND 14종. */
    private static final List<String> LEGACY_LEGENDS = List.of(
            "P001", "P002", "P003", "P004", "P005", "P006", "P007", "P008", "P009", "P010",
            "P011", "P012", "P143", "P144");

    /** hero 결정 U-D4 — 확정 신규 8종(석다이크 제외, 석신 추가로 GK 확보). */
    private static final List<String> NEW_LEGENDS = List.of(
            "P173", "P174", "P175", "P176", "P177", "P178", "P179", "P180");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        try {
            Path dbFile = Files.createTempFile("hmb-test-v22-", ".db");
            Files.deleteIfExists(dbFile);
            registry.add("hmb.db.path", () -> dbFile.toAbsolutePath().toString());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.2.json");
        registry.add("hmb.data.economy-file", () -> "src/test/resources/fixtures/economy.v1.json");
        registry.add("hmb.data.bots-file", () -> "src/test/resources/fixtures/bots.v1.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void v22SeedImportsEightNewLegendsAndDeactivatesTheFourteenLegacyOnes() {
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single())
                .as("v2.2 = 172 + 신규 8").isEqualTo(180L);

        // 비활성은 **정확히** 그 14종이다(개수만 세면 엉뚱한 14개여도 통과한다).
        List<String> inactive = jdbcClient.sql("SELECT id FROM players WHERE active = 0 ORDER BY id")
                .query(String.class).list();
        assertThat(inactive).containsExactlyElementsOf(LEGACY_LEGENDS);

        // 구 14종은 **등급을 유지**한다(U-D1: 강등이 아니라 비활성) — 등급을 내렸다면 캡 역전으로
        // 기보유 카드가 깎인다. 그 손실 0 이 이 결정의 핵심이므로 여기서 못박는다.
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM players WHERE active = 0 AND grade <> 'LEGEND'")
                .query(Long.class).single())
                .as("비활성 처리하면서 등급까지 내렸다 — U-D1(손실 0) 위반").isZero();

        // 신규 8종은 활성 LEGEND 로 들어온다.
        for (String id : NEW_LEGENDS) {
            assertThat(jdbcClient.sql("SELECT grade FROM players WHERE id = ?").param(id)
                    .query(String.class).optional())
                    .as("신규 유닛 " + id + " 이 임포트되지 않았다").contains("LEGEND");
            assertThat(jdbcClient.sql("SELECT active FROM players WHERE id = ?").param(id)
                    .query(Integer.class).single()).as(id + " 이 비활성으로 들어왔다").isEqualTo(1);
        }

        // GK 0 문제 해소(U-D4) — **뽑을 수 있는** LEGEND 에 골키퍼가 있어야 한다.
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM players WHERE grade = 'LEGEND' AND active = 1 AND position = 'GK'")
                .query(Long.class).single())
                .as("활성 LEGEND 에 GK 가 없다 — 최고등급 골키퍼를 영영 못 뽑는다").isEqualTo(1L);

        // 획득 가능한 LEGEND = 신규 8종뿐.
        assertThat(jdbcClient.sql("SELECT id FROM players WHERE grade = 'LEGEND' AND active = 1 ORDER BY id")
                .query(String.class).list()).containsExactlyElementsOf(NEW_LEGENDS);

        // 부팅 임포트는 아무것도 잠그지 않는다 — 잠금은 어드민 API 만 세운다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE admin_locked <> 0")
                .query(Long.class).single()).isZero();

        assertThat(jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'players_version'")
                .query(String.class).single()).isEqualTo("v2.2");
    }
}
