package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#207 파트 A</b>: 어드민 유닛 카탈로그 API — CRUD · 원장 · 멱등 · 등급하향 가드 · export.
 *
 * <p>단정은 {@link AdminPointsTest} 규약을 그대로 따른다: 상태코드만 보지 않고 <b>players 행 ·
 * admin_catalog_audit 행 · admin_locked 플래그</b> 세 값을 함께 본다. 거부 케이스는 그 셋이
 * <b>전부 불변</b>임을 단정한다 — "409 는 났는데 값은 이미 바뀌었다"가 가장 위험한 실패다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminUnitCatalogTest extends ApiTestBase {

    private static final String ADMIN_NICK = "unit_admin";
    private static final String ADMIN_PW = "unit-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    // ───────────────────────── 조회 ─────────────────────────

    @Test
    void listExposesAdminLockedAndDataVersionAndSupportsFilters() {
        String admin = adminToken();

        HttpResult all = req("GET", "/api/admin/units?limit=200", admin, null, null);
        assertThat(all.status()).as(all.body()).isEqualTo(HttpStatus.OK);
        Map<String, Object> page = asMap(all);
        // 기대값은 DB 에서 유도한다 — 같은 클래스의 다른 테스트가 유닛을 만들 수 있어(공유 DB)
        // 리터럴 17 을 박으면 실행 순서에 따라 깨진다. 검증의 요점은 "필터가 DB 와 일치하는가"다.
        assertThat(((Number) page.get("total")).longValue()).isEqualTo(unitCount());

        List<Map<String, Object>> items = items(page);
        assertThat(items).hasSize((int) unitCount());
        Map<String, Object> first = items.get(0);
        assertThat(first.get("id")).isEqualTo("P001");
        // 행마다 운영 판단에 필요한 두 값이 반드시 실린다(#207 §1.3).
        assertThat(first).containsKeys("adminLocked", "dataVersion", "active", "attributes", "personality");
        // 두 플래그가 DB 실측과 일치해야 한다(하드코딩하면 다른 테스트가 P001 을 잠갔을 때 깨진다).
        assertThat(first.get("adminLocked"))
                .isEqualTo(((Number) playerRow("P001").get("admin_locked")).intValue() != 0);
        assertThat(first.get("active"))
                .isEqualTo(((Number) playerRow("P001").get("active")).intValue() != 0);
        assertThat(first.get("dataVersion")).isEqualTo(playerRow("P001").get("data_version"));

        // grade 필터
        assertThat(total(req("GET", "/api/admin/units?grade=GOLD", admin, null, null)))
                .isEqualTo(countWhere("grade = 'GOLD'"));
        // position 필터
        assertThat(total(req("GET", "/api/admin/units?position=GK", admin, null, null)))
                .isEqualTo(countWhere("position = 'GK'"));
        // active 필터
        assertThat(total(req("GET", "/api/admin/units?active=false", admin, null, null)))
                .isEqualTo(countWhere("active = 0"));
        // q 는 id·이름 양쪽에 걸린다
        assertThat(total(req("GET", "/api/admin/units?q=P016", admin, null, null))).isEqualTo(1L);
        assertThat(total(req("GET", "/api/admin/units?q=Keeper", admin, null, null)))
                .isEqualTo(countWhere("name LIKE '%Keeper%'"));
        // 조합 필터
        assertThat(total(req("GET", "/api/admin/units?grade=GOLD&position=MF", admin, null, null)))
                .isEqualTo(countWhere("grade = 'GOLD' AND position = 'MF'"));
        // 알 수 없는 열거값은 조용히 무시하지 않고 400(오타가 '전체 조회'로 둔갑하면 안 된다)
        assertThat(req("GET", "/api/admin/units?grade=MYTH", admin, null, null).status())
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * LIKE 와일드카드가 <b>리터럴</b>로 처리된다 — 검색어 {@code %} 하나로 전량이 매칭되면
     * 페이징·필터가 무의미해진다({@code AdminUserQueryService} 와 같은 규약).
     */
    @Test
    void searchWildcardsAreTreatedAsLiterals() {
        String admin = adminToken();
        assertThat(total(req("GET", "/api/admin/units?q=%25", admin, null, null))).isZero();
        assertThat(total(req("GET", "/api/admin/units?q=_", admin, null, null))).isZero();
    }

    @Test
    void detailReportsOwnerCountAndRecentAudit() {
        String admin = adminToken();
        login("unit_owner_a");
        login("unit_owner_b");   // 스타터팩으로 둘 다 P010 보유

        HttpResult res = req("GET", "/api/admin/units/P010", admin, null, null);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = asMap(res);

        Map<?, ?> holdings = (Map<?, ?>) body.get("holdings");
        // "영향 규모" — 이 유닛을 실제로 몇 명이 들고 있는가. 등급 변경 전에 운영자가 보는 값이다.
        // 공유 DB 라 절대 수는 다른 테스트의 로그인에 좌우되므로 DB 실측과 일치하는지로 본다.
        long owners = jdbcClient.sql("SELECT COUNT(*) FROM user_players WHERE player_id = 'P010'")
                .query(Long.class).single();
        assertThat(owners).as("스타터팩 보유자가 없어 검사가 공허하다").isGreaterThanOrEqualTo(2L);
        assertThat(((Number) holdings.get("owners")).longValue()).isEqualTo(owners);
        assertThat(((Number) holdings.get("copies")).longValue()).isGreaterThanOrEqualTo(owners);
        assertThat(body.get("recentAudit")).isInstanceOf(List.class);
    }

    @Test
    void unknownUnitIsNotFound() {
        assertThat(req("GET", "/api/admin/units/NOPE", adminToken(), null, null).status())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ───────────────────────── 생성 ─────────────────────────

    @Test
    void createAssignsNextIdAndWritesLedgerAndLocksTheRow() {
        String admin = adminToken();
        long auditBefore = auditCount();
        // 기존 최대 P번호 + 1 이어야 한다. 기존 번호 재사용은 user_players 가 그 id 를 가리키므로
        // **기보유 유저의 카드가 다른 선수로 바뀐다** — 절대 금지다.
        String expectedId = String.format("P%03d", maxPlayerNumber() + 1);

        HttpResult res = req("POST", "/api/admin/units", admin, createBody("보날두", "FW", "LEGEND"), "unit-create-1");
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);

        Map<String, Object> body = asMap(res);
        assertThat(body.get("applied")).isEqualTo(true);
        Map<?, ?> unit = (Map<?, ?>) body.get("unit");
        assertThat(unit.get("id")).isEqualTo(expectedId);
        assertThat(unit.get("name")).isEqualTo("보날두");
        assertThat(unit.get("grade")).isEqualTo("LEGEND");
        assertThat(unit.get("active")).isEqualTo(true);
        // 어드민이 만든 행은 **잠긴다** — 안 그러면 다음 부팅의 시드 임포트에 조용히 사라진다.
        assertThat(unit.get("adminLocked")).isEqualTo(true);

        Map<String, Object> row = playerRow(expectedId);
        assertThat(row.get("name")).isEqualTo("보날두");
        assertThat(((Number) row.get("admin_locked")).intValue()).isEqualTo(1);

        // 원장: before 는 NULL(생성), after 는 전체 스냅샷
        Map<String, Object> audit = auditRow("unit-create-1");
        assertThat(audit.get("action")).isEqualTo("unit_create");
        assertThat(audit.get("player_id")).isEqualTo(expectedId);
        assertThat(audit.get("actor_user_id")).isEqualTo(userIdOf(ADMIN_NICK));
        assertThat(audit.get("before_json")).isNull();
        assertThat((String) audit.get("after_json")).contains("\"grade\":\"LEGEND\"").contains("보날두");
        assertThat(audit.get("reason")).isEqualTo("신규 유닛 투입");
        assertThat(auditCount()).isEqualTo(auditBefore + 1);
    }

    @Test
    void createRejectsMissingReasonAndInvalidFieldsWithNoSideEffects() {
        String admin = adminToken();
        long unitsBefore = unitCount();
        long auditBefore = auditCount();

        Map<String, Object> noReason = createBody("무사유", "FW", "GOLD");
        noReason.remove("reason");
        assertThat(req("POST", "/api/admin/units", admin, noReason, null).status())
                .as("reason 없는 변경이 통과했다").isEqualTo(HttpStatus.BAD_REQUEST);

        Map<String, Object> badPos = createBody("잘못된포지션", "ST", "GOLD");
        assertThat(req("POST", "/api/admin/units", admin, badPos, null).status()).isEqualTo(HttpStatus.BAD_REQUEST);

        Map<String, Object> badGrade = createBody("잘못된등급", "FW", "MYTH");
        assertThat(req("POST", "/api/admin/units", admin, badGrade, null).status()).isEqualTo(HttpStatus.BAD_REQUEST);

        Map<String, Object> partialAttrs = createBody("모자란스탯", "FW", "GOLD");
        partialAttrs.put("attributes", Map.of("shooting", 70));
        assertThat(req("POST", "/api/admin/units", admin, partialAttrs, null).status())
                .as("9종이 아닌 attributes 가 통과했다").isEqualTo(HttpStatus.BAD_REQUEST);

        Map<String, Object> outOfRange = createBody("범위밖", "FW", "GOLD");
        outOfRange.put("attributes", attrs(140));
        assertThat(req("POST", "/api/admin/units", admin, outOfRange, null).status()).isEqualTo(HttpStatus.BAD_REQUEST);

        Map<String, Object> longReason = createBody("사유초과", "FW", "GOLD");
        longReason.put("reason", "x".repeat(501));
        assertThat(req("POST", "/api/admin/units", admin, longReason, null).status()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(unitCount()).as("400 인데 유닛이 늘었다").isEqualTo(unitsBefore);
        assertThat(auditCount()).as("400 인데 감사가 늘었다").isEqualTo(auditBefore);
    }

    // ───────────────────────── 수정 ─────────────────────────

    @Test
    void patchMergesAttributesAndRecordsBeforeAfterSnapshots() {
        String admin = adminToken();

        Map<String, Object> patch = new HashMap<>();
        patch.put("name", "Renamed Keeper");
        patch.put("attributes", Map.of("shooting", 11));   // 9종 중 1개만 — 나머지는 보존돼야 한다
        patch.put("reason", "이름·슈팅 보정");
        HttpResult res = req("PATCH", "/api/admin/units/P001", admin, patch, "unit-patch-1");
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);

        Map<?, ?> unit = (Map<?, ?>) asMap(res).get("unit");
        assertThat(unit.get("name")).isEqualTo("Renamed Keeper");
        Map<?, ?> attributes = (Map<?, ?>) unit.get("attributes");
        assertThat(((Number) attributes.get("shooting")).intValue()).isEqualTo(11);
        // 병합이지 전체 교체가 아니다 — 지정하지 않은 8종은 원본 그대로(P001 technical=40).
        assertThat(((Number) attributes.get("technical")).intValue()).isEqualTo(40);
        assertThat(unit.get("adminLocked")).isEqualTo(true);

        assertThat((List<String>) asMap(res).get("changedFields"))
                .contains("name", "attributes", "adminLocked");

        Map<String, Object> audit = auditRow("unit-patch-1");
        assertThat(audit.get("action")).isEqualTo("unit_update");
        // before/after **전체 스냅샷**(§1.4) — 한 행만 보고 그 시점 상태를 복원할 수 있어야 한다.
        assertThat((String) audit.get("before_json")).contains("Test Keeper").contains("\"shooting\":44");
        assertThat((String) audit.get("after_json")).contains("Renamed Keeper").contains("\"shooting\":11");
        assertThat((String) audit.get("changed_fields")).contains("name").contains("attributes");
    }

    @Test
    void patchWithNoFieldsOrUnknownAttributeIsRejected() {
        String admin = adminToken();
        Map<String, Object> row = playerRow("P002");

        assertThat(req("PATCH", "/api/admin/units/P002", adminToken(), Map.of("reason", "무변경"), null).status())
                .isEqualTo(HttpStatus.BAD_REQUEST);

        Map<String, Object> unknownAttr = new HashMap<>();
        unknownAttr.put("attributes", Map.of("charisma", 50));
        unknownAttr.put("reason", "없는 능력치");
        assertThat(req("PATCH", "/api/admin/units/P002", admin, unknownAttr, null).status())
                .isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(playerRow("P002")).as("400 인데 행이 변했다").isEqualTo(row);
    }

    // ───────────────────────── 등급 하향 가드 (#207 §1.6-1) ─────────────────────────

    /**
     * <b>등급 하향은 기보유 카드의 유효스탯을 깎는다</b>({@code cap_i = base_i + starFrac[star] ×
     * (band.hi − base_i)} — 성을 올린 카드일수록 크게). 그래서 영향 규모를 계산해 돌려주고
     * {@code confirmImpact:true} 없이는 <b>409</b> 로 거절한다. 운영자가 모르고 누르는 걸 막는 게 목적이다.
     *
     * <p>4★ + 스탯레벨 투자 카드를 세팅해 <b>실제로 음수 델타가 계산되는지</b>까지 본다 —
     * 가드만 있고 계산이 죽어 있으면(항상 0) 운영자는 "영향 없음"으로 읽고 그대로 누른다.
     */
    @Test
    void gradeDowngradeIsBlockedUntilImpactIsConfirmed() {
        String admin = adminToken();
        String owner = userIdOf(login("unit_downgrade") == null ? "unit_downgrade" : "unit_downgrade");
        giveInvestedCard(owner, "P016", 4, 10);

        Map<String, Object> downgrade = new HashMap<>();
        downgrade.put("grade", "DIA");
        downgrade.put("reason", "등급 재조정");

        HttpResult blocked = req("PATCH", "/api/admin/units/P016", admin, downgrade, null);
        assertThat(blocked.status()).as(blocked.body()).isEqualTo(HttpStatus.CONFLICT);
        Map<String, Object> err = asMap(blocked);
        assertThat(err.get("code")).isEqualTo("CONFLICT");
        Map<?, ?> detail = (Map<?, ?>) err.get("detail");
        assertThat(((Number) detail.get("affectedUsers")).longValue()).isEqualTo(1L);
        assertThat(detail.get("capLowered")).isEqualTo(true);
        assertThat(detail.get("computed")).isEqualTo(true);
        assertThat(((Number) detail.get("avgOvrDelta")).doubleValue())
                .as("영향 계산이 죽어 있다 — 4★ 투자 카드인데 손실이 0으로 보고됐다").isLessThan(0.0);
        assertThat(((Number) detail.get("worstOvrDelta")).doubleValue()).isLessThan(0.0);

        // 409 면 아무것도 바뀌지 않았어야 한다.
        assertThat(playerRow("P016").get("grade")).as("409 인데 등급이 이미 바뀌었다").isEqualTo("LEGEND");
        assertThat(((Number) playerRow("P016").get("admin_locked")).intValue()).isZero();
        assertThat(auditCountFor("P016")).isZero();

        // confirmImpact 를 주면 진행된다.
        downgrade.put("confirmImpact", true);
        HttpResult ok = req("PATCH", "/api/admin/units/P016", admin, downgrade, null);
        assertThat(ok.status()).as(ok.body()).isEqualTo(HttpStatus.OK);
        assertThat(playerRow("P016").get("grade")).isEqualTo("DIA");
        assertThat(auditCountFor("P016")).isEqualTo(1L);
        // 응답에 실측 영향이 함께 실린다(운영 기록용).
        assertThat(((Map<?, ?>) asMap(ok).get("impact")).get("toGrade")).isEqualTo("DIA");
    }

    /** <b>상향</b>은 손실이 없으므로 확인 없이 통과한다(가드가 등급 변경 전체를 막아버리면 운영이 죽는다). */
    @Test
    void gradeUpgradeNeedsNoConfirmation() {
        String admin = adminToken();
        Map<String, Object> upgrade = new HashMap<>();
        upgrade.put("grade", "DIA");
        upgrade.put("reason", "상향 조정");
        HttpResult res = req("PATCH", "/api/admin/units/P011", admin, upgrade, null);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        assertThat(playerRow("P011").get("grade")).isEqualTo("DIA");
    }

    // ───────────────────────── 비활성 / 시드 복원 ─────────────────────────

    @Test
    void deactivateAndActivateAreSeparateAuditActions() {
        String admin = adminToken();

        HttpResult off = req("POST", "/api/admin/units/P014/deactivate", admin,
                Map.of("reason", "레거시 정리"), "unit-off-1");
        assertThat(off.status()).as(off.body()).isEqualTo(HttpStatus.OK);
        assertThat(((Map<?, ?>) asMap(off).get("unit")).get("active")).isEqualTo(false);
        assertThat(((Number) playerRow("P014").get("active")).intValue()).isZero();
        assertThat(((Number) playerRow("P014").get("admin_locked")).intValue()).isEqualTo(1);
        assertThat(auditRow("unit-off-1").get("action")).isEqualTo("unit_deactivate");

        HttpResult on = req("POST", "/api/admin/units/P014/activate", admin,
                Map.of("reason", "복구"), "unit-on-1");
        assertThat(on.status()).as(on.body()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) playerRow("P014").get("active")).intValue()).isEqualTo(1);
        assertThat(auditRow("unit-on-1").get("action")).isEqualTo("unit_activate");
    }

    @Test
    void deactivateRequiresReason() {
        String admin = adminToken();
        assertThat(req("POST", "/api/admin/units/P013/deactivate", admin, Map.of(), null).status())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(((Number) playerRow("P013").get("active")).intValue()).isEqualTo(1);
    }

    /**
     * 시드 복원은 <b>잠금만 푼다</b> — 값을 되돌리지 않는다. 되돌림은 다음 부팅의 시드 임포트가 한다
     * (그 경로는 {@code PlayerCatalogAdminLockTest} 가 박제한다).
     */
    @Test
    void overrideResetUnlocksTheRowWithoutRevertingValues() {
        String admin = adminToken();
        assertThat(req("PATCH", "/api/admin/units/P015", admin,
                Map.of("name", "Locked Keeper", "reason", "선점"), null).status()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) playerRow("P015").get("admin_locked")).intValue()).isEqualTo(1);

        HttpResult res = req("DELETE", "/api/admin/units/P015/override", admin,
                Map.of("reason", "시드 권위 복귀"), "unit-reset-1");
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) playerRow("P015").get("admin_locked")).intValue()).isZero();
        assertThat(playerRow("P015").get("name")).as("복원은 값을 되돌리지 않는다").isEqualTo("Locked Keeper");
        assertThat(auditRow("unit-reset-1").get("action")).isEqualTo("unit_override_reset");
    }

    /** DELETE 바디를 떨어뜨리는 클라이언트를 위해 {@code ?reason=} 쿼리도 받는다. */
    @Test
    void overrideResetAcceptsReasonAsQueryParam() {
        String admin = adminToken();
        assertThat(req("PATCH", "/api/admin/units/P017", admin,
                Map.of("name", "Locked Diamond", "reason", "선점"), null).status()).isEqualTo(HttpStatus.OK);

        assertThat(req("DELETE", "/api/admin/units/P017/override?reason=쿼리사유", admin, null, null).status())
                .isEqualTo(HttpStatus.OK);
        assertThat(((Number) playerRow("P017").get("admin_locked")).intValue()).isZero();

        // 사유가 아예 없으면 거절한다(바디도 쿼리도 없을 때).
        assertThat(req("DELETE", "/api/admin/units/P017/override", admin, null, null).status())
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ───────────────────────── 멱등 ─────────────────────────

    @Test
    void sameIdempotencyKeyReplaysWithoutDuplicatingAudit() {
        String admin = adminToken();
        Map<String, Object> body = createBody("권씨", "FW", "LEGEND");

        HttpResult first = req("POST", "/api/admin/units", admin, body, "unit-idem-dup");
        HttpResult second = req("POST", "/api/admin/units", admin, body, "unit-idem-dup");
        HttpResult third = req("POST", "/api/admin/units", admin, body, "unit-idem-dup");

        assertThat(first.status()).as(first.body()).isEqualTo(HttpStatus.OK);
        assertThat(second.status()).as(second.body()).isEqualTo(HttpStatus.OK);
        assertThat(third.status()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(first).get("applied")).isEqualTo(true);
        assertThat(asMap(second).get("applied")).as("재전송이 또 적용됐다 — 유닛이 두 개 생긴다").isEqualTo(false);
        assertThat(asMap(third).get("applied")).isEqualTo(false);

        // 3번 보냈지만 유닛 1개, 감사 1행. (생성 멱등이 대상별 스코프면 여기서 3개가 생긴다.)
        assertThat(unitCount("권씨")).isEqualTo(1L);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM admin_catalog_audit WHERE idem_key = 'unit-idem-dup'")
                .query(Long.class).single()).isEqualTo(1L);
        // 재전송 응답도 대상 유닛을 그대로 돌려준다(클라가 id 를 잃지 않게).
        assertThat(((Map<?, ?>) asMap(second).get("unit")).get("id"))
                .isEqualTo(((Map<?, ?>) asMap(first).get("unit")).get("id"));
    }

    /**
     * <b>같은 키 다른 내용 = 409</b>. 조용히 삼키면 운영자는 정정 요청이 성공했다고 믿는데 값은
     * 안 바뀐다 — 포인트 API 가 실제로 당했던 함정({@link AdminPointsService})을 여기서도 막는다.
     */
    @Test
    void sameKeyWithDifferentContentIsRejectedWhileSameContentStaysIdempotent() {
        String admin = adminToken();
        assertThat(req("PATCH", "/api/admin/units/P012", admin,
                Map.of("name", "First Name", "reason", "최초"), "unit-conflict").status())
                .isEqualTo(HttpStatus.OK);
        Map<String, Object> rowAfterFirst = playerRow("P012");
        long auditAfterFirst = auditCountFor("P012");

        // ① 같은 키 + 같은 내용 = 재전송 → 200 applied:false, 부수효과 0
        HttpResult replay = req("PATCH", "/api/admin/units/P012", admin,
                Map.of("name", "First Name", "reason", "문구만 다른 메모"), "unit-conflict");
        assertThat(replay.status()).as(replay.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(replay).get("applied")).isEqualTo(false);
        assertThat(playerRow("P012")).isEqualTo(rowAfterFirst);
        assertThat(auditCountFor("P012")).isEqualTo(auditAfterFirst);

        // ② 같은 키 + 다른 내용 = 다른 요청 → 409, 부수효과 0
        HttpResult conflict = req("PATCH", "/api/admin/units/P012", admin,
                Map.of("name", "Second Name", "reason", "정정 시도"), "unit-conflict");
        assertThat(conflict.status()).as("같은 키에 다른 내용인데 삼켰다: " + conflict.body())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(asMap(conflict).get("code")).isEqualTo("CONFLICT");
        assertThat(playerRow("P012")).as("409 인데 행이 변했다").isEqualTo(rowAfterFirst);
        assertThat(auditCountFor("P012")).as("409 인데 감사가 늘었다").isEqualTo(auditAfterFirst);
    }

    /**
     * <b>멱등 스코프는 대상별</b>(V5→V6 이 포인트 감사에서 겪은 실패를 반복하지 않는다).
     * 멱등키는 클라이언트가 정하므로 서로 다른 유닛에 같은 키가 오는 건 정상 시나리오다.
     */
    @Test
    void sameKeyOnDifferentUnitsIsTwoIndependentChanges() {
        String admin = adminToken();
        HttpResult a = req("POST", "/api/admin/units/P002/deactivate", admin, Map.of("reason", "A"), "shared-unit-key");
        HttpResult b = req("POST", "/api/admin/units/P003/deactivate", admin, Map.of("reason", "B"), "shared-unit-key");

        assertThat(a.status()).as(a.body()).isEqualTo(HttpStatus.OK);
        assertThat(b.status()).as("다른 유닛에 같은 키인데 실패했다: " + b.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(a).get("applied")).isEqualTo(true);
        assertThat(asMap(b).get("applied")).isEqualTo(true);
        assertThat(((Number) playerRow("P002").get("active")).intValue()).isZero();
        assertThat(((Number) playerRow("P003").get("active")).intValue()).isZero();
    }

    /** 키를 안 주면 서버가 채번한다 = 재전송 보호 없음. 계약이므로 박제한다(포인트 API 와 동일). */
    @Test
    void withoutIdempotencyKeyEachRequestIsDistinct() {
        String admin = adminToken();
        HttpResult a = req("POST", "/api/admin/units", adminToken(), createBody("무키1", "FW", "GOLD"), null);
        HttpResult b = req("POST", "/api/admin/units", admin, createBody("무키2", "FW", "GOLD"), null);
        assertThat(a.status()).isEqualTo(HttpStatus.OK);
        assertThat(b.status()).isEqualTo(HttpStatus.OK);
        assertThat((String) asMap(a).get("idempotencyKey")).isNotBlank();
        assertThat(asMap(a).get("idempotencyKey")).isNotEqualTo(asMap(b).get("idempotencyKey"));
        assertThat(unitCount("무키1")).isEqualTo(1L);
        assertThat(unitCount("무키2")).isEqualTo(1L);
    }

    // ───────────────────────── 감사 조회 / export ─────────────────────────

    @Test
    void auditEndpointFiltersByPlayerActorAndAction() {
        String admin = adminToken();
        req("POST", "/api/admin/units/P009/deactivate", admin, Map.of("reason", "감사필터-1"), "audit-f-1");
        req("PATCH", "/api/admin/units/P009", admin, Map.of("name", "Audited", "reason", "감사필터-2"), "audit-f-2");
        req("POST", "/api/admin/units/P008/deactivate", admin, Map.of("reason", "감사필터-3"), "audit-f-3");

        assertThat(total(req("GET", "/api/admin/units/audit?playerId=P009", admin, null, null))).isEqualTo(2L);
        assertThat(total(req("GET", "/api/admin/units/audit?playerId=P009&action=unit_update", admin, null, null)))
                .isEqualTo(1L);
        assertThat(total(req("GET", "/api/admin/units/audit?actor=" + userIdOf(ADMIN_NICK), admin, null, null)))
                .isGreaterThanOrEqualTo(3L);
        // 미래 시각 이후로 필터하면 0 — 기간 필터가 실제로 걸린다.
        assertThat(total(req("GET", "/api/admin/units/audit?from=2999-01-01T00:00:00Z", admin, null, null))).isZero();
        // 알 수 없는 action 은 조용히 무시하지 않고 400
        assertThat(req("GET", "/api/admin/units/audit?action=nope", admin, null, null).status())
                .isEqualTo(HttpStatus.BAD_REQUEST);

        // 이력 항목은 before/after 를 **객체**로 준다(운영 UI 가 문자열을 다시 파싱하지 않게).
        Map<String, Object> page = asMap(req("GET", "/api/admin/units/audit?playerId=P009", admin, null, null));
        Map<String, Object> latest = items(page).get(0);
        assertThat(latest.get("after")).isInstanceOf(Map.class);
        assertThat(latest).containsKeys("actorUserId", "action", "reason", "changedFields", "createdAt");
    }

    /**
     * export 는 <b>시드 발행 포맷</b>이어야 한다 — 최상위 배열 + {@code players.v2.1.json} 과 같은 키 순서
     * (+ {@code active}). 이게 어긋나면 data 도메인이 승격할 수 없어 개편이 이 DB 한 대에만 남는다(§1.2).
     */
    @Test
    void exportEmitsSeedShapedArray() {
        String admin = adminToken();
        req("POST", "/api/admin/units/P016/deactivate", admin, Map.of("reason", "export 확인"), "exp-1");

        HttpResult res = req("GET", "/api/admin/units/export", admin, null, null);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> dump = readList(res.body());

        assertThat(dump).hasSize((int) unitCount());
        assertThat(dump.get(0).keySet())
                .containsExactly("id", "name", "position", "grade", "attributes", "personality", "active");
        assertThat(dump.get(0).get("id")).isEqualTo("P001");
        // 어드민 변경이 덤프에 실제로 반영된다.
        Map<String, Object> legend = dump.stream().filter(m -> "P016".equals(m.get("id"))).findFirst().orElseThrow();
        assertThat(legend.get("active")).isEqualTo(false);
        assertThat(((Map<?, ?>) legend.get("attributes"))).hasSize(9);
        // admin_locked·dataVersion 은 **런타임 상태**지 시드 데이터가 아니다 — 덤프에 나가면 안 된다.
        assertThat(dump.get(0)).doesNotContainKeys("adminLocked", "dataVersion");
    }

    // ───────────────────────── 에러 노출 ─────────────────────────

    /** admin 에러 응답에 내부 SQL·스키마가 새지 않는다(AdminErrorHandler 가 이 컨트롤러에도 붙는다). */
    @Test
    void catalogErrorResponsesNeverLeakSqlOrSchema() {
        String admin = adminToken();
        List<String> bodies = List.of(
                req("GET", "/api/admin/units/NO_SUCH", admin, null, null).body(),
                req("PATCH", "/api/admin/units/NO_SUCH", admin, Map.of("name", "x", "reason", "y"), null).body(),
                req("POST", "/api/admin/units", admin, Map.of("reason", "불완전"), null).body(),
                rawPost("/api/admin/units", admin, "{\"grade\": +5}").body(),
                req("GET", "/api/admin/units?limit=abc", admin, null, null).body());

        for (String body : bodies) {
            assertThat(body).as("응답에 내부 구현이 노출됐다: " + body)
                    .doesNotContain("INSERT").doesNotContain("SELECT").doesNotContain("UPDATE")
                    .doesNotContain("UNIQUE constraint").doesNotContain("CHECK constraint")
                    .doesNotContain("SQLITE_").doesNotContain("admin_catalog_audit")
                    .doesNotContain("attributes_json").doesNotContain("admin_locked")
                    .doesNotContain("com.fasterxml").doesNotContain("org.springframework").doesNotContain("org.sqlite");
        }
    }

    // ───────────────────────── helpers ─────────────────────────

    private static Map<String, Object> attrs(int value) {
        Map<String, Object> a = new HashMap<>();
        for (String k : List.of("technical", "mental", "physical", "passing", "shooting",
                "tackling", "pace", "stamina", "positioning")) {
            a.put(k, value);
        }
        return a;
    }

    private static Map<String, Object> createBody(String name, String position, String grade) {
        Map<String, Object> body = new HashMap<>();
        body.put("name", name);
        body.put("position", position);
        body.put("grade", grade);
        body.put("attributes", attrs(85));
        body.put("personality", "CALM");
        body.put("reason", "신규 유닛 투입");
        return body;
    }

    /** 성 4★ + 전 스탯 레벨 투자 카드 — 등급 하향 손실이 실제로 계산되는 조건(§1.6-1). */
    private void giveInvestedCard(String userId, String playerId, int star, int lv) {
        StringBuilder json = new StringBuilder("{");
        List<String> keys = List.of("technical", "mental", "physical", "passing", "shooting",
                "tackling", "pace", "stamina", "positioning");
        for (int i = 0; i < keys.size(); i++) {
            json.append(i == 0 ? "" : ",").append('"').append(keys.get(i))
                    .append("\":{\"lv\":").append(lv).append(",\"xp\":0}");
        }
        json.append('}');
        jdbcClient.sql("""
                        INSERT INTO user_players(user_id, player_id, count, acquired_at, star, stat_levels_json)
                        VALUES (?, ?, 1, ?, ?, ?)
                        ON CONFLICT(user_id, player_id) DO UPDATE SET star = excluded.star,
                                                                      stat_levels_json = excluded.stat_levels_json
                        """)
                .params(userId, playerId, java.time.Instant.now().toString(), star, json.toString())
                .update();
    }

    private HttpResult req(String method, String path, String token, Object body, String idemKey) {
        try {
            java.net.http.HttpRequest.Builder builder = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl(path)))
                    .header("Content-Type", "application/json");
            if (token != null) {
                builder.header("Authorization", "Bearer " + token);
            }
            if (idemKey != null) {
                builder.header("Idempotency-Key", idemKey);
            }
            if ("GET".equals(method)) {
                builder.GET();
            } else if (body == null) {
                builder.method(method, java.net.http.HttpRequest.BodyPublishers.noBody());
            } else {
                builder.method(method, java.net.http.HttpRequest.BodyPublishers
                        .ofString(MAPPER.writeValueAsString(body)));
            }
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient()
                    .send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private HttpResult rawPost(String path, String token, String rawBody) {
        try {
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder()
                            .uri(java.net.URI.create(baseUrl(path)))
                            .header("Content-Type", "application/json")
                            .header("Authorization", "Bearer " + token)
                            .POST(java.net.http.HttpRequest.BodyPublishers.ofString(rawBody))
                            .build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> items(Map<String, Object> page) {
        return (List<Map<String, Object>>) page.get("items");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> readList(String json) {
        try {
            return MAPPER.readValue(json, List.class);
        } catch (Exception e) {
            throw new IllegalStateException("bad json: " + json, e);
        }
    }

    private long total(HttpResult res) {
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        return ((Number) asMap(res).get("total")).longValue();
    }

    private String adminToken() {
        Map<String, Object> body = new HashMap<>();
        body.put("provider", "local");
        body.put("nickname", ADMIN_NICK);
        body.put("password", ADMIN_PW);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        return (String) asMap(res).get("token");
    }

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
    }

    private Map<String, Object> playerRow(String playerId) {
        return jdbcClient.sql("""
                        SELECT id, name, position, grade, attributes_json, personality, active,
                               admin_locked, data_version
                        FROM players WHERE id = ?
                        """)
                .param(playerId).query(new org.springframework.jdbc.core.ColumnMapRowMapper()).single();
    }

    private Map<String, Object> auditRow(String idemKey) {
        return jdbcClient.sql("""
                        SELECT actor_user_id, player_id, action, before_json, after_json,
                               changed_fields, reason, idem_key
                        FROM admin_catalog_audit WHERE idem_key = ?
                        """)
                .param(idemKey).query(new org.springframework.jdbc.core.ColumnMapRowMapper()).single();
    }

    private long auditCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_catalog_audit").query(Long.class).single();
    }

    private long auditCountFor(String playerId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_catalog_audit WHERE player_id = ?")
                .param(playerId).query(Long.class).single();
    }

    private long unitCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single();
    }

    private long countWhere(String predicate) {
        return jdbcClient.sql("SELECT COUNT(*) FROM players WHERE " + predicate).query(Long.class).single();
    }

    private int maxPlayerNumber() {
        return jdbcClient.sql("SELECT id FROM players WHERE id LIKE 'P%'").query(String.class).list()
                .stream()
                .map(id -> id.substring(1))
                .filter(s -> !s.isEmpty() && s.chars().allMatch(Character::isDigit))
                .map(Integer::parseInt)
                .max(Integer::compareTo).orElse(0);
    }

    private long unitCount(String name) {
        return jdbcClient.sql("SELECT COUNT(*) FROM players WHERE name = ?").param(name)
                .query(Long.class).single();
    }
}
