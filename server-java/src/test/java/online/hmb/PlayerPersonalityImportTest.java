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
 * 데이터 v2.1 스위치(W1 ①): players.v2.1.json 부팅 임포트 시 personality 컬럼이 채워지는지 검증.
 * 172명 임포트 + 성격 4종 분포 + 알려진 선수(P001 Lev Yashin=CALM). 실제 data 산출물 파일을 가리킨다.
 */
@SpringBootTest
class PlayerPersonalityImportTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        try {
            Path dbFile = Files.createTempFile("hmb-test-p21-", ".db");
            Files.deleteIfExists(dbFile);
            registry.add("hmb.db.path", () -> dbFile.toAbsolutePath().toString());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        // 실제 v2.1 데이터 파일(성격 포함). economy/bots 는 fixture 유지(임포트 독립).
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.1.json");
        registry.add("hmb.data.economy-file", () -> "src/test/resources/fixtures/economy.v1.json");
        registry.add("hmb.data.bots-file", () -> "src/test/resources/fixtures/bots.v1.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void imports172PlayersWithPersonality() {
        Integer count = jdbcClient.sql("SELECT COUNT(*) FROM players").query(Integer.class).single();
        assertThat(count).isEqualTo(172);

        // 성격이 전부 채워져 있고 CHECK 허용값 안 (NULL/빈값 없음)
        Integer bad = jdbcClient.sql("""
                        SELECT COUNT(*) FROM players
                        WHERE personality IS NULL OR personality NOT IN ('FIERY','CALM','GLASS','AMBITIOUS')
                        """).query(Integer.class).single();
        assertThat(bad).isZero();

        // 4종 성격이 실제로 분포(모두 기본 CALM 으로만 채워진 게 아님)
        List<String> distinct = jdbcClient.sql("SELECT DISTINCT personality FROM players ORDER BY personality")
                .query(String.class).list();
        assertThat(distinct).contains("CALM").hasSizeGreaterThan(1);

        // 알려진 선수 성격
        String p001 = jdbcClient.sql("SELECT personality FROM players WHERE id = 'P001'")
                .query(String.class).single();
        assertThat(p001).isEqualTo("CALM");

        // 파일명 규약에서 유도한 버전 라벨(점 포함 전체 캡처): players.v2.1.json → v2.1
        String version = jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'players_version'")
                .query(String.class).single();
        assertThat(version).isEqualTo("v2.1");
    }

    /**
     * <b>#207 무회귀</b>: {@code active} 필드가 <b>없는</b> 구 시드(v2.1)로 부팅하면 전원 활성이다.
     *
     * <p>임포터가 없는 필드를 0/false 로 읽으면 <b>구 시드로 부팅하는 순간 카탈로그 전체가 비활성</b>이
     * 되어 가챠·트레이드·도감이 통째로 빈다. 롤백 경로(v2.2 → v2.1 되돌리기)가 바로 그 상황이라
     * 여기서 못박는다.
     */
    @Test
    void legacySeedWithoutActiveFieldImportsEverythingAsActive() {
        Integer inactive = jdbcClient.sql("SELECT COUNT(*) FROM players WHERE active <> 1")
                .query(Integer.class).single();
        assertThat(inactive).as("active 필드가 없는 구 시드인데 비활성 행이 생겼다").isZero();
    }
}
