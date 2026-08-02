package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 롤백 스위치 — {@code hmb.prewarm.enabled=false} 면 덱 저장이 AI 잡을 만들지 않는다 (#215 W2-B2).
 *
 * <p>운영에서 선실행이 문제를 일으키면(예: 예산·큐 폭주) 재배포 없이 env 하나로 #215 이전 동작
 * (매치 생성 시 프리페치만)으로 되돌릴 수 있어야 한다. 별도 스프링 컨텍스트가 필요해 클래스를 분리했다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class DeckPrewarmDisabledTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.prewarm.enabled", () -> "false");
    }

    @Test
    void deckSaveDoesNotWarmAnythingWhenDisabled() {
        String token = login("prewarm_off");

        assertThat(authPut("/api/deck", token, deckBody("4-4-2", starters11PlusBench()), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL")
                .query(Long.class).single()).isZero();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM deck_prewarm").query(Long.class).single())
                .isZero();
    }

    /**
     * 조회 경로의 상시 보증(#402 AC2)도 <b>같은 스위치</b> 뒤에 있다 — 롤백은 하나여야 한다.
     * (여기서 새는 경로가 있으면 "선실행을 껐는데 조회가 계속 큐를 채운다"가 된다.)
     */
    @Test
    void deckReadDoesNotWarmAnythingWhenDisabled() {
        String token = login("prewarm_off_get");
        assertThat(authPut("/api/deck", token, deckBody("4-4-2", starters11PlusBench()), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(authGet("/api/deck", token, Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL")
                .query(Long.class).single()).isZero();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM deck_prewarm").query(Long.class).single())
                .isZero();
    }

    private static List<Map<String, Object>> starters11PlusBench() {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        return slots;
    }
}
