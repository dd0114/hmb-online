package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** 부팅 시 catalog/PlayerCatalogService가 fixture players.v1.json을 임포트하는지 검증. */
@SpringBootTest
class PlayerCatalogSeedImportTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void bootImportsFixturePlayersAndRecordsVersion() {
        long playerCount = jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single();
        assertThat(playerCount).isEqualTo(17);

        String version = jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'players_version'")
                .query(String.class)
                .single();
        assertThat(version).isEqualTo("v1");

        String grade = jdbcClient.sql("SELECT grade FROM players WHERE id = 'P016'")
                .query(String.class)
                .single();
        assertThat(grade).isEqualTo("LEGEND");
    }

    @Test
    void bootRecordsEconomyAndBotsVersionsWhenFixturesPresent() {
        String economyVersion = jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'economy_version'")
                .query(String.class)
                .single();
        String botsVersion = jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'bots_version'")
                .query(String.class)
                .single();

        assertThat(economyVersion).isEqualTo("v1");
        assertThat(botsVersion).isEqualTo("v1");
    }
}
