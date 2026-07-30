package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * V32 — {@code admin_catalog_audit} 재작성(CHECK 에 {@code unit_purge} 추가).
 *
 * <p><b>이 테스트가 존재하는 이유</b>: 이 마이그레이션에는 <b>{@code DROP TABLE} 이 있다</b>
 * (SQLite 는 CHECK 를 ALTER 로 못 바꿔 표준 12단계 재작성이 유일한 방법이다). 감사 원장을
 * 재작성하는 것이므로 <b>잃을 수 있는 것이 있고</b>, 그 잃음은 조용하다 —
 * 행이 줄어도, 인덱스가 사라져도 다음 배포까지 아무 증상이 없다.
 *
 * <p>그래서 셋을 태운다: ①<b>기존 행이 내용까지</b> 살아남는가 ②<b>인덱스 셋</b>이 다시 생겼는가
 * (특히 V15 부분 유니크 — 빠지면 {@code unit_create} 멱등 백스톱이 조용히 사라져 같은 키 동시
 * 생성이 유닛을 둘 만들던 결함 #207 B1 이 되살아난다) ③새 action 은 되고 <b>오타는 여전히 거부</b>되는가.
 */
@SpringBootTest
class FlywayV32CatalogAuditRebuildTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Autowired
    private JdbcClient jdbcClient;

    /**
     * 재작성 후에도 <b>쓰고 읽은 값이 그대로</b>다. 마이그레이션이 이미 끝난 DB 에서 도는
     * 테스트라 "옛 행"을 직접 심을 수는 없으므로, <b>전 컬럼 왕복</b>으로 스키마가 손실 없이
     * 옮겨졌는지 확인한다(컬럼이 하나 빠졌다면 여기서 드러난다).
     */
    @Test
    void everyColumnSurvivesTheRebuildRoundTrip() {
        String actor = seedUser("v32-actor");
        String id = online.hmb.common.Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO admin_catalog_audit(id, actor_user_id, player_id, action, before_json,
                                                        after_json, changed_fields, reason, idem_key, created_at)
                        VALUES (?, ?, 'P999', 'unit_update', '{"a":1}', '{"a":2}', 'grade', '사유', 'K1',
                                '2026-07-30T00:00:00Z')
                        """)
                .params(id, actor)
                .update();

        Map<String, Object> row = jdbcClient.sql("SELECT * FROM admin_catalog_audit WHERE id = ?")
                .params(id).query().singleRow();

        assertThat(row).containsEntry("player_id", "P999")
                .containsEntry("action", "unit_update")
                .containsEntry("before_json", "{\"a\":1}")
                .containsEntry("after_json", "{\"a\":2}")
                .containsEntry("changed_fields", "grade")
                .containsEntry("reason", "사유")
                .containsEntry("idem_key", "K1")
                .containsEntry("created_at", "2026-07-30T00:00:00Z");
    }

    /**
     * ⚠️ <b>인덱스 셋이 전부 다시 생겼는가.</b> 표와 함께 사라지므로 재작성 마이그레이션이
     * 다시 만들어야 한다. 특히 {@code uq_catalog_audit_create_idem} 은 <b>부분 유니크</b>라
     * 이름만 있고 조건이 틀려도 동작이 달라진다 → 조건까지 본다.
     */
    @Test
    void allThreeIndexesAreRecreated() {
        List<String> names = jdbcClient.sql(
                        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admin_catalog_audit'"
                                + " AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .query(String.class).list();

        assertThat(names).containsExactlyInAnyOrder(
                "idx_catalog_audit_player", "idx_catalog_audit_actor", "uq_catalog_audit_create_idem");

        String sql = jdbcClient.sql(
                        "SELECT sql FROM sqlite_master WHERE name = 'uq_catalog_audit_create_idem'")
                .query(String.class).single();
        assertThat(sql).contains("UNIQUE")
                .contains("action = 'unit_create'")
                .contains("idem_key IS NOT NULL");
    }

    /** V15 백스톱이 **실제로 잠그는지** — 같은 키 두 번째 create 감사행은 거부돼야 한다. */
    @Test
    void theCreateIdempotencyBackstopStillLocks() {
        String actor = seedUser("v32-idem");
        insertAudit(actor, "P900", "unit_create", "SAMEKEY");

        assertThatThrownBy(() -> insertAudit(actor, "P901", "unit_create", "SAMEKEY"))
                .as("같은 키의 두 번째 create = 같은 요청의 재전송이므로 DB 가 막는다")
                .isInstanceOf(org.springframework.dao.DataAccessException.class);

        // 다른 액션은 같은 키를 공유할 수 있다(부분 인덱스라 그 액션만 잠긴다).
        insertAudit(actor, "P902", "unit_update", "SAMEKEY");
        insertAudit(actor, "P903", "unit_update", "SAMEKEY");
    }

    /** 새 action 은 수용되고, <b>오타는 여전히 거부</b>된다(CHECK 를 넓히면서 열어 두지 않았다). */
    @Test
    void purgeIsAcceptedButTyposAreStillRejected() {
        String actor = seedUser("v32-check");

        insertAudit(actor, "P910", "unit_purge", null);

        assertThatThrownBy(() -> insertAudit(actor, "P911", "unit_purged", null))
                .as("CHECK 를 넓힌 것이지 없앤 것이 아니다")
                .isInstanceOf(org.springframework.dao.DataAccessException.class);
        assertThatThrownBy(() -> insertAudit(actor, "P912", "whatever", null))
                .isInstanceOf(org.springframework.dao.DataAccessException.class);
    }

    /** {@code player_id} 에 FK 가 없다 — 회수된(=존재하지 않는) 유닛의 이력을 보존하는 전제다. */
    @Test
    void thereIsStillNoForeignKeyOnPlayerIdSoPurgedHistorySurvives() {
        String actor = seedUser("v32-fk");

        insertAudit(actor, "P_DOES_NOT_EXIST", "unit_purge", null);

        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM admin_catalog_audit WHERE player_id = ?")
                .params("P_DOES_NOT_EXIST").query(Integer.class).single()).isEqualTo(1);
    }

    private void insertAudit(String actor, String playerId, String action, String idemKey) {
        jdbcClient.sql("""
                        INSERT INTO admin_catalog_audit(id, actor_user_id, player_id, action,
                                                        reason, idem_key, created_at)
                        VALUES (?, ?, ?, ?, '사유', ?, '2026-07-30T00:00:00Z')
                        """)
                .params(online.hmb.common.Ulid.next(), actor, playerId, action, idemKey)
                .update();
    }

    private String seedUser(String nickname) {
        String id = online.hmb.common.Ulid.next();
        jdbcClient.sql("INSERT INTO users(id, nickname, created_at) VALUES (?, ?, ?)")
                .params(id, nickname, "2026-07-30T00:00:00Z")
                .update();
        return id;
    }
}
