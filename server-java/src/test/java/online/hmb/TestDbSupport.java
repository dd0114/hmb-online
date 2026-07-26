package online.hmb;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.test.context.DynamicPropertyRegistry;

/**
 * §8: "임시 SQLite 파일 per test class". 각 테스트 클래스가 @DynamicPropertySource 에서
 * registerTempDb(registry)를 호출해 격리된 DB 파일 + 픽스처 데이터 파일을 가리키게 한다.
 */
final class TestDbSupport {

    private TestDbSupport() {
    }

    static void registerTempDb(DynamicPropertyRegistry registry) {
        try {
            Path dbFile = Files.createTempFile("hmb-test-", ".db");
            Files.deleteIfExists(dbFile); // SQLite/Flyway가 새로 생성하게 함
            registry.add("hmb.db.path", () -> dbFile.toAbsolutePath().toString());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        registry.add("hmb.data.players-file", () -> "src/test/resources/fixtures/players.v1.json");
        registry.add("hmb.data.economy-file", () -> "src/test/resources/fixtures/economy.v1.json");
        registry.add("hmb.data.bots-file", () -> "src/test/resources/fixtures/bots.v1.json");
    }

    /**
     * P4 시계를 끈 상태로 고정한다(= 롤백 경로, LLD-e2-flow-clock §7.7).
     *
     * <p>시계가 켜지면 전반 시뮬 직후가 FIRST_HALF(라이브 재생 창)이고 FINISHED 는 후반 창이 끝나야
     * 온다. 시계와 무관한 것(A/B 분기·교체·리그 정산·잡 재시도 등)을 검증하는 기존 흐름 테스트는
     * 시계를 꺼서 <b>자기 주제만</b> 보게 한다. 시계 동작 자체는 MatchClockFlowTest(켜짐) +
     * MatchClockDisabledTest(꺼짐)가 전담한다.
     */
    static void disableMatchClock(DynamicPropertyRegistry registry) {
        registry.add("hmb.match.clock.enabled", () -> "false");
    }

    /** 시드 임포트 파일이 아예 없는 시나리오(부팅 warn-and-continue 확인용). */
    static void registerTempDbWithMissingData(DynamicPropertyRegistry registry) {
        try {
            Path dbFile = Files.createTempFile("hmb-test-", ".db");
            Files.deleteIfExists(dbFile);
            registry.add("hmb.db.path", () -> dbFile.toAbsolutePath().toString());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        registry.add("hmb.data.players-file", () -> "src/test/resources/fixtures/does-not-exist.json");
        registry.add("hmb.data.economy-file", () -> "src/test/resources/fixtures/does-not-exist.json");
        registry.add("hmb.data.bots-file", () -> "src/test/resources/fixtures/does-not-exist.json");
    }
}
