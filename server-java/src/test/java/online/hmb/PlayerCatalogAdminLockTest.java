package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import online.hmb.catalog.PlayerCatalogService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#207 부팅 재임포트 보호</b> — 어드민이 만진 행({@code admin_locked=1})은 재시작에도 살아남고,
 * 만지지 않은 행({@code admin_locked=0})은 시드가 이긴다.
 *
 * <p>이게 이 에픽 전체에서 가장 조용히 깨지는 지점이다: 보호가 없으면 어드민 API 는 <b>정상 동작하는
 * 것처럼 보이는데</b>(200 도 나고 값도 바뀐다) 다음 배포·재시작에 전부 되돌아간다. 운영자는
 * "저장했는데 왜 원래대로냐"를 겪고, 로그에도 아무 흔적이 없다. 그래서 <b>양방향</b>으로 박제한다 —
 * 잠긴 행이 보존되는 것만 보면 {@code WHERE} 절을 {@code WHERE 1=0} 으로 바꿔도 통과한다(시드가
 * 아무것도 못 덮게 되지만 테스트는 green). 잠기지 않은 행은 반드시 시드가 이겨야 한다.
 */
@SpringBootTest
class PlayerCatalogAdminLockTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private PlayerCatalogService playerCatalogService;

    /**
     * 두 테스트가 같은 DB 를 공유하므로(클래스 단위) 매 메서드 시작 시 <b>시드 상태로 되돌린다</b> —
     * 잠금을 전부 풀고 재임포트하면 값·행이 시드와 같아진다. 이게 없으면 실행 순서에 따라
     * 한쪽이 남긴 잠금이 다른 쪽의 전제를 무너뜨린다(순서 의존 = 재현 안 되는 실패).
     */
    @org.junit.jupiter.api.BeforeEach
    void resetToSeedState() {
        jdbcClient.sql("UPDATE players SET admin_locked = 0").update();
        playerCatalogService.run(null);
    }

    @Test
    void adminLockedRowsSurviveReimportWhileUnlockedRowsAreOverwrittenBySeed() {
        // ── 잠긴 행: 시드와 **전부 다른** 값으로 바꿔 둔다(한 필드만 보면 부분 덮어쓰기를 놓친다) ──
        jdbcClient.sql("""
                        UPDATE players
                        SET name = 'Admin Renamed', position = 'FW', grade = 'LEGEND',
                            attributes_json = '{"technical":99,"mental":99,"physical":99,"passing":99,
                                                "shooting":99,"tackling":99,"pace":99,"stamina":99,
                                                "positioning":99}',
                            personality = 'FIERY', active = 0, admin_locked = 1
                        WHERE id = 'P001'
                        """).update();

        // ── 잠기지 않은 행: 값을 흔들어 둔다. 재임포트가 시드로 되돌려야 한다 ──
        jdbcClient.sql("""
                        UPDATE players
                        SET name = 'Should Be Reverted', grade = 'LEGEND', active = 0, admin_locked = 0
                        WHERE id = 'P002'
                        """).update();

        long before = count();

        // 부팅 임포트를 그대로 재실행(= 서버 재시작).
        playerCatalogService.run(null);

        assertThat(count()).as("재임포트가 행 수를 바꿨다").isEqualTo(before);

        // ⓐ 잠긴 행은 어드민 값 그대로.
        assertThat(str("P001", "name")).as("잠긴 행을 시드가 덮었다 — 어드민 변경이 재시작마다 사라진다")
                .isEqualTo("Admin Renamed");
        assertThat(str("P001", "position")).isEqualTo("FW");
        assertThat(str("P001", "grade")).isEqualTo("LEGEND");
        assertThat(str("P001", "personality")).isEqualTo("FIERY");
        assertThat(num("P001", "active")).isZero();
        assertThat(str("P001", "attributes_json")).contains("99");
        assertThat(num("P001", "admin_locked")).as("잠금이 풀렸다").isEqualTo(1);

        // ⓑ 잠기지 않은 행은 시드가 이긴다(보호가 과잉으로 번지면 여기서 깨진다).
        assertThat(str("P002", "name")).as("잠기지 않은 행인데 시드가 못 덮었다 — 보호가 전 행에 걸렸다")
                .isEqualTo("Test Defender 1");
        assertThat(str("P002", "grade")).isEqualTo("BRONZE");
        assertThat(num("P002", "active")).as("시드에 active 가 없으면 1(활성)로 복귀해야 한다").isEqualTo(1);
        assertThat(num("P002", "admin_locked")).isZero();
    }

    /** 시드에 <b>새 유닛이 추가</b>되면 잠금과 무관하게 INSERT 된다(보호는 UPDATE 에만 걸린다). */
    @Test
    void seedCanStillInsertNewUnitsWhileOtherRowsAreLocked() {
        jdbcClient.sql("UPDATE players SET admin_locked = 1").update();
        jdbcClient.sql("DELETE FROM players WHERE id = 'P016'").update();
        long before = count();

        playerCatalogService.run(null);

        assertThat(count()).as("전 행이 잠겼다고 신규 INSERT 까지 막혔다").isEqualTo(before + 1);
        assertThat(str("P016", "name")).isEqualTo("Test Legend");
        // 새로 들어온 행은 잠기지 않는다(어드민이 만진 적 없으므로 시드가 계속 권위).
        assertThat(num("P016", "admin_locked")).isZero();
    }

    private long count() {
        return jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single();
    }

    private String str(String id, String column) {
        return jdbcClient.sql("SELECT " + column + " FROM players WHERE id = ?")
                .param(id).query(String.class).single();
    }

    private int num(String id, String column) {
        return jdbcClient.sql("SELECT " + column + " FROM players WHERE id = ?")
                .param(id).query(Integer.class).single();
    }
}
