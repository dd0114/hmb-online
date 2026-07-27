package online.hmb.admin;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 어드민 유닛 카탈로그 API(#207 파트 A) — 유닛 목록/상세/추가/수정/비활성/시드복원/이력/export.
 *
 * <p><b>여기에도 권한 검사 코드가 한 줄도 없다</b>({@link AdminController} 와 같은 이유):
 * {@code /api/admin/} 접두사에 {@link AdminInterceptor} 가 걸려 있고, 접두사를 벗어난 매핑은
 * {@link AdminRouteGuard} 가 <b>부팅을 죽여서</b> 막는다. 컨트롤러가 가드를 복사하지 않으므로
 * 빠뜨릴 수도 없다.
 *
 * <p>{@code userId} attribute 는 {@code AuthInterceptor} 가 넣어준 <b>액터(admin 본인)</b>다 —
 * 감사 원장의 actor 로 쓰인다.
 *
 * <p><b>왜 {@link AdminController} 에 합치지 않았나</b>: 유닛 카탈로그는 유저 운영과 대상도
 * 원장 테이블도 다르다(각각 {@code admin_catalog_audit} / {@code admin_audit}). 한 클래스에 8개
 * 엔드포인트를 더 얹으면 두 도메인이 섞인다. 대신 {@link AdminErrorHandler} 의
 * {@code assignableTypes} 에 이 클래스를 등록해 <b>에러 소독(내부 SQL·스키마 비노출)은 동일하게</b> 받는다.
 */
@RestController
@RequestMapping("/api/admin/units")
public class AdminCatalogController {

    private final AdminCatalogService catalog;

    public AdminCatalogController(AdminCatalogService catalog) {
        this.catalog = catalog;
    }

    /** 목록 — 필터 q·grade·position·active + 페이징. 행마다 adminLocked·dataVersion 포함. */
    @GetMapping
    public AdminCatalogService.UnitPage list(
            @RequestParam(name = "q", required = false) String q,
            @RequestParam(name = "grade", required = false) String grade,
            @RequestParam(name = "position", required = false) String position,
            @RequestParam(name = "active", required = false) Boolean active,
            @RequestParam(name = "limit", required = false) Integer limit,
            @RequestParam(name = "offset", required = false) Integer offset) {
        return catalog.list(q, grade, position, active, limit, offset);
    }

    /**
     * 감사 이력 조회. <b>{@code /{playerId}} 보다 먼저 선언</b>돼야 하는 게 아니라 —
     * 스프링은 리터럴 경로를 경로변수보다 우선 매칭하므로 순서와 무관하게 {@code /audit} 이 이긴다.
     * 그래도 읽는 사람이 헷갈리지 않게 위에 둔다.
     */
    @GetMapping("/audit")
    public AdminCatalogService.AuditPage audit(
            @RequestParam(name = "playerId", required = false) String playerId,
            @RequestParam(name = "actor", required = false) String actor,
            @RequestParam(name = "action", required = false) String action,
            @RequestParam(name = "from", required = false) String from,
            @RequestParam(name = "to", required = false) String to,
            @RequestParam(name = "limit", required = false) Integer limit,
            @RequestParam(name = "offset", required = false) Integer offset) {
        return catalog.auditPage(playerId, actor, action, from, to, limit, offset);
    }

    /** 현재 카탈로그를 시드 발행 포맷(players.vX.json)으로 덤프 — data 도메인이 다음 시드로 승격한다. */
    @GetMapping("/export")
    public List<Map<String, Object>> export() {
        return catalog.export();
    }

    /** 상세 — 유닛 + 보유 규모(영향 범위) + 최근 감사 이력. */
    @GetMapping("/{playerId}")
    public AdminCatalogService.UnitDetail detail(@PathVariable("playerId") String playerId) {
        return catalog.detail(playerId);
    }

    /** 신규 유닛 추가 — id 는 서버가 채번한다(기존 최대 P번호 + 1). */
    @PostMapping
    public AdminCatalogService.MutationResult create(
            @RequestAttribute("userId") String actorUserId,
            @RequestBody(required = false) AdminCatalogService.CreateRequest body,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        return catalog.create(actorUserId, body, idempotencyKey);
    }

    /**
     * 부분 수정. 등급을 <b>낮추는</b> 경우 {@code confirmImpact:true} 가 없으면 409 —
     * 영향 규모(보유 유저 수·평균/최대 OVR 델타)가 응답 detail 에 담긴다.
     */
    @PatchMapping("/{playerId}")
    public AdminCatalogService.MutationResult update(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("playerId") String playerId,
            @RequestBody(required = false) AdminCatalogService.PatchRequest body,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        return catalog.update(actorUserId, playerId, body, idempotencyKey);
    }

    /** 비활성화 — 신규 획득 경로(가챠·트레이드·도감 미보유분)에서만 빠진다. 보유분은 그대로. */
    @PostMapping("/{playerId}/deactivate")
    public AdminCatalogService.MutationResult deactivate(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("playerId") String playerId,
            @RequestBody(required = false) AdminCatalogService.ReasonRequest body,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        return catalog.setActive(actorUserId, playerId, false, reasonOf(body, null), idempotencyKey);
    }

    /** 재활성화. */
    @PostMapping("/{playerId}/activate")
    public AdminCatalogService.MutationResult activate(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("playerId") String playerId,
            @RequestBody(required = false) AdminCatalogService.ReasonRequest body,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        return catalog.setActive(actorUserId, playerId, true, reasonOf(body, null), idempotencyKey);
    }

    /**
     * 시드 권위로 복원({@code admin_locked=0}) — 값을 되돌리는 게 아니라 <b>다음 부팅에 시드가 다시
     * 이기도록</b> 잠금만 푼다.
     *
     * <p>{@code reason} 은 바디({@code {"reason": …}})로 받되 <b>{@code ?reason=} 쿼리도 허용</b>한다 —
     * DELETE 에 바디를 싣는 건 HTTP 상 합법이지만 일부 클라이언트·프록시가 조용히 떨어뜨린다.
     * 사유 없는 변경을 막는 게 목적이지 특정 전송 형식을 강제하는 게 아니다.
     */
    @DeleteMapping("/{playerId}/override")
    public AdminCatalogService.MutationResult resetOverride(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("playerId") String playerId,
            @RequestBody(required = false) AdminCatalogService.ReasonRequest body,
            @RequestParam(name = "reason", required = false) String reasonParam,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        return catalog.resetOverride(actorUserId, playerId, reasonOf(body, reasonParam), idempotencyKey);
    }

    private static String reasonOf(AdminCatalogService.ReasonRequest body, String fallback) {
        if (body != null && body.reason() != null && !body.reason().isBlank()) {
            return body.reason();
        }
        return fallback;
    }
}
