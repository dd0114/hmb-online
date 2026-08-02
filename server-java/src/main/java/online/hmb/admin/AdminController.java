package online.hmb.admin;

import java.util.List;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * admin 운영 API(PRD-v4 §C). <b>이 클래스에 권한 검사 코드가 한 줄도 없다</b>는 게 설계의 핵심이다 —
 * {@code /api/admin/} 접두사에 걸린 {@link AdminInterceptor} 가 이미 걸렀고, 접두사를 벗어난 매핑은
 * {@link AdminRouteGuard} 가 부팅을 막는다. 컨트롤러가 가드를 "복사"하지 않으므로 빠뜨릴 수도 없다.
 *
 * <p>{@code userId} attribute 는 {@code AuthInterceptor} 가 넣어준 <b>액터(admin 본인)</b>다 —
 * 감사 로그의 actor 로 쓰인다.
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final AdminUserQueryService users;
    private final AdminPointsService points;
    private final AdminEconomyService economy;
    private final AdminNoticeService notices;
    private final AdminNoticeAssetService noticeAssets;
    private final AdminMailService mails;
    private final AdminEngineConfigService engineConfig;
    private final AdminGrowthConfigService growthConfig;

    public AdminController(AdminUserQueryService users, AdminPointsService points,
                           AdminEconomyService economy, AdminNoticeService notices,
                           AdminNoticeAssetService noticeAssets, AdminMailService mails,
                           AdminEngineConfigService engineConfig,
                           AdminGrowthConfigService growthConfig) {
        this.users = users;
        this.points = points;
        this.economy = economy;
        this.notices = notices;
        this.noticeAssets = noticeAssets;
        this.mails = mails;
        this.engineConfig = engineConfig;
        this.growthConfig = growthConfig;
    }

    // ── 성장 계수 무배포 운영 (#405 W2a) ─────────────────────────────────
    //
    // engine-config(#383)와 형태는 같지만 **검증 주체와 적용 시점이 다르다**: 엔진 계수는 러너가
    // 판정하고 매치 생성 시점에 pin 되지만, 성장 계수는 **이 서버가 소비자**라 검증도 여기서 하고
    // pin 없이 다음 정산·조회부터 즉시 걸린다(설계 §2.8.3). 그래서 응답에 그 문장을 실어 보낸다.

    /** 지금 성장 계산에 쓰이는 오버레이 + 유효 계수 전체 + 출처. */
    @GetMapping("/growth-config")
    public Object growthConfig() {
        return growthConfig.current();
    }

    /** 리비전 이력(누가·언제·왜·무엇을). 원장은 append-only 라 과거가 지워지지 않는다. */
    @GetMapping("/growth-config/history")
    public List<online.hmb.growth.LiveGrowthConfigService.Row> growthConfigHistory(
            @RequestParam(name = "limit", required = false, defaultValue = "20") int limit) {
        return growthConfig.history(limit);
    }

    /** 오버레이 가능한 경로 전수 + 타입·범위·현재값 — 경로 이름을 추측하지 않게 한다. */
    @GetMapping("/growth-config/knobs")
    public Object growthConfigKnobs() {
        return growthConfig.knobs();
    }

    /** 드라이런 — 원장을 만들지 않는다. 무효 노브는 {@code issues[]} 에 이유가 항목별로 온다. */
    @PostMapping("/growth-config/validate")
    public Object validateGrowthConfig(@RequestAttribute("userId") String actorUserId,
                                       @RequestBody(required = false) GrowthConfigRequest body) {
        return growthConfig.validate(actorUserId, body == null ? null : body.overrides());
    }

    /**
     * 오버레이 <b>전체 교체</b>. {@code Idempotency-Key} 를 항상 보내라 — 같은 키 + 같은 내용은
     * 재전송으로 흡수되고, 같은 키 + <b>다른</b> 내용은 409 다. 기본값 복귀는 {@code overrides:{}}.
     */
    @PutMapping("/growth-config")
    public Object replaceGrowthConfig(@RequestAttribute("userId") String actorUserId,
                                      @RequestBody GrowthConfigRequest body,
                                      @RequestHeader(name = "Idempotency-Key", required = false)
                                      String idempotencyKey) {
        if (body == null) {
            throw online.hmb.common.ApiException.validation("요청 바디가 비어 있습니다");
        }
        return growthConfig.replace(actorUserId, body.overrides(), body.reason(), idempotencyKey);
    }

    /** 성장 계수 오버레이 요청 — 점경로 맵 + 사유. 경로 유효성은 서버가 판정한다(소비자가 서버라서). */
    public record GrowthConfigRequest(java.util.Map<String, Object> overrides, String reason) {
    }

    // ── 계수 무배포 운영 (#383) ───────────────────────────────────────────
    //
    // economy(#209)와 형태는 닮았지만 **적용 시점이 다르다**: economy 는 리로드 즉시 전 유저에게
    // 걸리고, 계수는 **이 호출 이후 생성되는 매치부터** 걸린다(진행 중 매치는 시작 시점 스냅샷으로
    // 끝까지 돈다 — #241 재발 방지). 그래서 응답에 그 문장을 실어 보낸다.

    /** 지금 새 매치에 실릴 오버레이 + 출처 + 적용 시점. */
    @GetMapping("/engine-config")
    public Object engineConfig() {
        return engineConfig.current().value();
    }

    /** 리비전 이력(누가·언제·왜·무엇을). 원장은 append-only 라 과거가 지워지지 않는다. */
    @GetMapping("/engine-config/history")
    public List<online.hmb.engine.LiveEngineConfigService.Row> engineConfigHistory(
            @RequestParam(name = "limit", required = false, defaultValue = "20") int limit) {
        return engineConfig.history(limit);
    }

    /** 오버레이 가능한 경로 전수 + 현재 기본값 — 경로 이름을 추측하지 않게 한다. */
    @GetMapping("/engine-config/knobs")
    public Object engineConfigKnobs() {
        return engineConfig.knobs();
    }

    /** 드라이런 — 원장을 만들지 않는다. 400 이면 사유가 그대로 온다. */
    @PostMapping("/engine-config/validate")
    public Object validateEngineConfig(@RequestAttribute("userId") String actorUserId,
                                       @RequestBody(required = false) EngineConfigRequest body) {
        return engineConfig.validate(actorUserId, body == null ? null : body.overrides());
    }

    /**
     * 오버레이 <b>전체 교체</b>. {@code Idempotency-Key} 를 항상 보내라 — 같은 키 + 같은 내용은
     * 재전송으로 흡수되고, 같은 키 + <b>다른</b> 내용은 409 다. 기본값 복귀는 {@code overrides:{}}.
     */
    @PutMapping("/engine-config")
    public Object replaceEngineConfig(@RequestAttribute("userId") String actorUserId,
                                      @RequestBody EngineConfigRequest body,
                                      @RequestHeader(name = "Idempotency-Key", required = false)
                                      String idempotencyKey) {
        if (body == null) {
            throw online.hmb.common.ApiException.validation("요청 바디가 비어 있습니다");
        }
        return engineConfig.replace(actorUserId, body.overrides(), body.reason(), idempotencyKey).value();
    }

    /** 계수 오버레이 요청 — 점경로 맵 + 사유. 경로 유효성 판정은 러너가 한다(서버가 흉내내지 않는다). */
    public record EngineConfigRequest(java.util.Map<String, Object> overrides, String reason) {
    }

    /** 유저 목록·닉네임 검색·페이징. 비번은 조회 SQL 에도 DTO 에도 없다. */
    @GetMapping("/users")
    public AdminUserQueryService.UserPage listUsers(@RequestParam(name = "q", required = false) String q,
                                                     @RequestParam(name = "limit", required = false) Integer limit,
                                                     @RequestParam(name = "offset", required = false) Integer offset) {
        return users.list(q, limit, offset);
    }

    /** 유저 상태 — 지갑·보유 선수·덱/프리셋 요약·전적. */
    @GetMapping("/users/{id}")
    public AdminUserQueryService.UserDetail userDetail(@PathVariable("id") String id) {
        return users.detail(id);
    }

    /**
     * 포인트 지급(+)/차감(-). 바디 = {@code {delta, reason}}(web 과 확정된 계약).
     * {@code Idempotency-Key} 헤더를 주면 재전송이 중복 지급되지 않는다({@link AdminPointsService} 참조).
     */
    @PostMapping("/users/{id}/points")
    public AdminPointsService.GrantResult grantPoints(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("id") String targetUserId,
            @RequestBody GrantPointsRequest body,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        return points.grant(actorUserId, targetUserId,
                body == null ? null : body.delta(),
                body == null ? null : body.reason(),
                idempotencyKey);
    }

    /** 확정 계약 바디 — {@code memo} 가 아니라 {@code reason} 이다(web 세션 합의). */
    public record GrantPointsRequest(Long delta, String reason) {
    }

    // ── economy 무배포 운영 (#209 B안) ────────────────────────────────────
    // 재배포 없이 스타터 최상위 후보를 갈아끼운다. 값이 **어디서 왔는지**(BAKED/OVERRIDE)를 항상 함께
    // 돌려주는 게 중요하다 — 운영이 "바꿨는데 반영됐나"를 화면에서 확신할 수 있어야 한다.

    /** 현재 유효한 economy 요약 + 출처. */
    @GetMapping("/economy")
    public AdminEconomyService.EconomyView economy() {
        return economy.current();
    }

    /** 운영 이력(감사 원장) — 성공/실패 모두. */
    @GetMapping("/economy/history")
    public List<AdminEconomyService.AuditEntry> economyHistory(
            @RequestParam(name = "limit", required = false, defaultValue = "20") int limit) {
        return economy.history(limit);
    }

    /** 디스크 재읽기(내용 변경 없음). 볼륨의 override 를 바깥에서 바꾼 뒤 반영할 때. */
    @PostMapping("/economy/reload")
    public AdminEconomyService.EconomyView reloadEconomy(@RequestAttribute("userId") String actorUserId,
                                                          @RequestBody(required = false) OpsRequest body) {
        return economy.reload(actorUserId, body == null ? null : body.reason());
    }

    /** 스타터 최상위 후보 교체 — 배포 없이 카드 조정의 실제 경로. */
    @PutMapping("/economy/starter-top")
    public AdminEconomyService.EconomyView replaceStarterTop(@RequestAttribute("userId") String actorUserId,
                                                              @RequestBody StarterTopRequest body) {
        if (body == null) {
            throw online.hmb.common.ApiException.validation("요청 바디가 비어 있습니다");
        }
        return economy.replaceStarterTop(actorUserId, body.pool(), body.count(), body.reason());
    }

    /** override 제거 = 배포 발행물로 롤백. */
    @DeleteMapping("/economy/override")
    public AdminEconomyService.EconomyView clearEconomyOverride(@RequestAttribute("userId") String actorUserId,
                                                                 @RequestParam(name = "reason", required = false)
                                                                 String reason) {
        return economy.clearOverride(actorUserId, reason);
    }

    /** 운영 액션 공통 바디 — 사유는 필수다(원장에 남는다). */
    public record OpsRequest(String reason) {
    }

    public record StarterTopRequest(List<String> pool, Integer count, String reason) {
    }

    // ── 공지 운영 (#248) ─────────────────────────────────────────────────
    // economy 와 달리 override 파일도 reload 도 없다 — DB 가 SoT 라 쓰면 곧 다음 조회에 반영된다.
    // 유저 쪽 읽기는 게이트 밖 공개 엔드포인트(GET /api/notices/active, NoticeController)다.

    /** 전체 목록(중지·만료·삭제 포함) + 서버가 판정한 상태(LIVE|SCHEDULED|OFF|EXPIRED|DELETED). */
    @GetMapping("/notices")
    public NoticeListResponse notices() {
        return new NoticeListResponse(notices.list());
    }

    /** 공지 운영 이력(감사 원장) — 성공/실패 모두. economy 이력과 같은 모양이다. */
    @GetMapping("/notices/history")
    public List<AdminEconomyService.AuditEntry> noticeHistory(
            @RequestParam(name = "limit", required = false, defaultValue = "20") int limit) {
        return notices.history(limit);
    }

    @PostMapping("/notices")
    public AdminNoticeService.NoticeAdminView createNotice(
            @RequestAttribute("userId") String actorUserId,
            @RequestBody(required = false) AdminNoticeService.UpsertRequest body) {
        return notices.create(actorUserId, body);
    }

    /** 내용 전체 치환. 제목·본문이 실제로 바뀔 때만 revision 이 오른다(클라 억제 키). */
    @PutMapping("/notices/{id}")
    public AdminNoticeService.NoticeAdminView updateNotice(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("id") String id,
            @RequestBody(required = false) AdminNoticeService.UpsertRequest body) {
        return notices.update(actorUserId, id, body);
    }

    /** 노출 ON/OFF — 기간을 건드리지 않는다(원장이 거짓말하지 않게). */
    @PostMapping("/notices/{id}/active")
    public AdminNoticeService.NoticeAdminView setNoticeActive(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("id") String id,
            @RequestBody(required = false) AdminNoticeService.ActiveRequest body) {
        return notices.setActive(actorUserId, id, body);
    }

    /** soft delete — 행은 남는다(감사 원장이 참조한다). 사유는 economy override 와 같은 쿼리 파라미터. */
    @DeleteMapping("/notices/{id}")
    public AdminNoticeService.NoticeAdminView deleteNotice(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("id") String id,
            @RequestParam(name = "reason", required = false) String reason) {
        return notices.delete(actorUserId, id, reason);
    }

    public record NoticeListResponse(List<AdminNoticeService.NoticeAdminView> notices) {
    }

    // ── 공지 이미지 (#309 W1) ─────────────────────────────────────────────
    // 공지 텍스트는 이미 무배포인데(#248) **그림만 웹 배포에 묶여 있었다**. 여기서 끊는다.
    // 공개 읽기는 게이트 밖(GET /api/notices/assets/{id}, NoticeController)이다.
    //
    // ⚠️ **삭제 엔드포인트가 없는 것이 설계다**(hero 확정 2026-07-30). 내리기는 노출 스위치로만 —
    //    삭제는 오조작이 곧 영구 소실이고 참조하던 공지의 그림을 되살릴 방법이 없다.
    //    "정리 기능"을 이유로 DELETE 를 추가하지 마라.

    /** 자산 목록(노출 OFF 포함) + `usedBy`(이 그림을 쓰는 살아 있는 공지 수). */
    @GetMapping("/notices/assets")
    public NoticeAssetListResponse noticeAssets() {
        return new NoticeAssetListResponse(noticeAssets.list());
    }

    /**
     * 이미지 업로드(multipart, 파트명 {@code file}). 응답 {@code url} 은 <b>상대경로</b>다 —
     * 절대 URL 을 본문에 굽는 순간 터널 주소가 바뀔 때 과거 공지 이미지가 전부 깨진다.
     */
    @PostMapping("/notices/assets")
    @org.springframework.web.bind.annotation.ResponseStatus(org.springframework.http.HttpStatus.CREATED)
    public AdminNoticeAssetService.AssetView uploadNoticeAsset(
            @RequestAttribute("userId") String actorUserId,
            @org.springframework.web.bind.annotation.RequestPart(name = "file", required = false)
            org.springframework.web.multipart.MultipartFile file,
            @RequestParam(name = "reason", required = false) String reason) {
        return noticeAssets.upload(actorUserId, file, reason);
    }

    /** 노출 ON/OFF = 내리기의 전부. 끄면 서빙 404, 켜면 같은 바이트가 돌아온다. */
    @PostMapping("/notices/assets/{id}/active")
    public AdminNoticeAssetService.AssetView setNoticeAssetActive(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("id") String id,
            @RequestBody(required = false) AdminNoticeAssetService.ActiveRequest body) {
        return noticeAssets.setActive(actorUserId, id, body);
    }

    public record NoticeAssetListResponse(List<AdminNoticeAssetService.AssetView> assets) {
    }

    // ── 우편함 (#323) ─────────────────────────────────────────────────────
    // 패치 보상·이벤트 지급을 **배포 없이** 보낸다. 지급은 우편함이 새로 만들지 않는다 —
    // 유저가 [받기]를 누를 때 기존 경로(지갑·원장·보유풀)가 돈다(MailService).

    /** 발송 이력 + 수령 통계 — "보냈나 / 몇 명이 받았나"가 운영의 첫 질문이다. */
    @GetMapping("/mails")
    public MailCampaignListResponse mails(@RequestParam(name = "limit", defaultValue = "50") int limit) {
        return new MailCampaignListResponse(mails.list(limit));
    }

    /** 액션 이력(성공·실패 모두) — `mail_send` / `mail_revoke`. */
    @GetMapping("/mails/history")
    public List<AdminMailService.AuditEntry> mailHistory(
            @RequestParam(name = "limit", defaultValue = "50") int limit) {
        return mails.history(limit);
    }

    @GetMapping("/mails/{id}")
    public AdminMailService.CampaignView mailDetail(@PathVariable("id") String id) {
        return mails.detail(id);
    }

    /**
     * 발송. {@code Idempotency-Key} 헤더를 <b>항상</b> 보내라 — 없으면 서버가 채번하므로 그 요청은
     * 재전송 보호를 받지 못한다(응답에 채번된 키가 나와 그 사실이 관측된다). 같은 키 + 같은 내용은
     * 200 재생, 같은 키 + <b>다른 내용은 409</b>(조용히 삼키면 운영자가 정정에 성공했다고 믿는다).
     */
    @PostMapping("/mails")
    public org.springframework.http.ResponseEntity<AdminMailService.SendResult> sendMail(
            @RequestAttribute("userId") String actorUserId,
            @RequestBody(required = false) AdminMailService.SendRequest body,
            @RequestHeader(name = "Idempotency-Key", required = false) String idemKey) {
        AdminMailService.SendResult result = mails.send(actorUserId, body, idemKey);
        // 201 = 이번에 보냈다 / 200 = 같은 키의 재전송이라 **아무것도 더 보내지 않았다**.
        // 코드로 구분하는 이유: 운영 화면이 "또 보냈나?"를 응답 바디를 파싱하지 않고 알 수 있어야 한다.
        return org.springframework.http.ResponseEntity
                .status(result.applied() ? org.springframework.http.HttpStatus.CREATED
                        : org.springframework.http.HttpStatus.OK)
                .body(result);
    }

    /** 회수(오발송 수습) — <b>미수령분만</b> 막는다. 이미 받은 건 건드리지 않는다. */
    @PostMapping("/mails/{id}/revoke")
    public AdminMailService.RevokeResult revokeMail(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("id") String id,
            @RequestBody(required = false) OpsRequest body) {
        return mails.revoke(actorUserId, id, body == null ? null : body.reason());
    }

    public record MailCampaignListResponse(List<AdminMailService.CampaignView> campaigns) {
    }
}
