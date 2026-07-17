package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 시드 파일이 아예 없을 때(data 에픽 미착수 시점) 부팅이 죽지 않고 경고만 남기는지 검증
 * (W0 태스크 명세: "파일이 없으면 경고 로그 후 계속").
 */
@SpringBootTest
class PlayerCatalogMissingFileTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void bootSucceedsAndCatalogStaysEmptyWhenDataFilesAreMissing() {
        long playerCount = jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single();
        assertThat(playerCount).isZero();

        long metaCount = jdbcClient.sql("SELECT COUNT(*) FROM meta_kv WHERE key = 'players_version'")
                .query(Long.class)
                .single();
        assertThat(metaCount).isZero();
    }
}
