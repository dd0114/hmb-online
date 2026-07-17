package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * AC-S1(스타터 팩 + /api/me) + AC-S3(owned 플래그) + 스타터 팩 멱등(재로그인 무재지급).
 * fixture economy: initialPoints=3000, starterPack=P001..P014 (GK1/DF5/MF5/FW3 미러).
 * fixture players: 17명(P015/P016/P017은 미보유 확인용).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class StarterPackAndMeTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void firstLoginGrantsStarterPackExactlyOnce() {
        String token = login("packuser");

        // /api/me — 포인트=economy.initialPoints, 전적 0/0/0
        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        assertThat(me.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<?, ?> wallet = (Map<?, ?>) me.getBody().get("wallet");
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(3000L);
        Map<?, ?> records = (Map<?, ?>) me.getBody().get("records");
        assertThat(((Number) records.get("wins")).longValue()).isZero();
        assertThat(((Number) records.get("draws")).longValue()).isZero();
        assertThat(((Number) records.get("losses")).longValue()).isZero();

        // /api/players — 카탈로그 17명 전원 + owned 정확(스타터 14명만 owned)
        ResponseEntity<List> players = authGet("/api/players", token, List.class);
        assertThat(players.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> list = players.getBody();
        assertThat(list).hasSize(17);
        long ownedCount = list.stream().filter(p -> (Boolean) p.get("owned")).count();
        assertThat(ownedCount).isEqualTo(14);

        Map<String, Object> p001 = byId(list, "P001");
        assertThat((Boolean) p001.get("owned")).isTrue();
        assertThat(((Number) p001.get("ownedCount")).intValue()).isEqualTo(1);
        assertThat(p001.get("attributes")).isInstanceOf(Map.class);

        Map<String, Object> p016 = byId(list, "P016");
        assertThat((Boolean) p016.get("owned")).isFalse();
        assertThat(((Number) p016.get("ownedCount")).intValue()).isZero();

        // 재로그인 — 재지급 금지(멱등): 포인트·보유·원장 모두 그대로
        ResponseEntity<Map> second = rest.postForEntity(
                baseUrl("/api/auth/login"), Map.of("nickname", "packuser"), Map.class);
        assertThat((Boolean) second.getBody().get("isNew")).isFalse();

        String userId = (String) ((Map<?, ?>) second.getBody().get("user")).get("id");
        long walletPoints = jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single();
        long ledgerRows = jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE user_id = ?")
                .param(userId).query(Long.class).single();
        long ownedRows = jdbcClient.sql("SELECT COUNT(*) FROM user_players WHERE user_id = ?")
                .param(userId).query(Long.class).single();

        assertThat(walletPoints).isEqualTo(3000L);
        assertThat(ledgerRows).isEqualTo(1L);
        assertThat(ownedRows).isEqualTo(14L);

        String ledgerReason = jdbcClient.sql("SELECT reason FROM point_ledger WHERE user_id = ?")
                .param(userId).query(String.class).single();
        assertThat(ledgerReason).isEqualTo("starter");
    }

    @Test
    void myMatchesIsEmptyForNewUser() {
        String token = login("nomatches");
        ResponseEntity<List> response = authGet("/api/me/matches", token, List.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isEmpty();
    }

    private static Map<String, Object> byId(List<Map<String, Object>> list, String id) {
        return list.stream().filter(p -> id.equals(p.get("id"))).findFirst().orElseThrow();
    }
}
