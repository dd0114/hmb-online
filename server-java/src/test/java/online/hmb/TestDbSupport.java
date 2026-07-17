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
