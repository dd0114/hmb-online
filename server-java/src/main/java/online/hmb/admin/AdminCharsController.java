package online.hmb.admin;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * 유닛 아트 번들 운영 API (#309 W2) — {@code /api/admin/chars/**}.
 *
 * <p><b>여기에도 권한 검사 코드가 한 줄도 없다</b>({@link AdminController} 와 같은 이유):
 * {@code /api/admin/} 접두사에 {@link AdminInterceptor} 가 걸려 있고, 접두사 밖 매핑은
 * {@link AdminRouteGuard} 가 <b>부팅을 죽여서</b> 막는다.
 *
 * <p><b>왜 별도 컨트롤러인가</b>({@link AdminCatalogController} 와 같은 판단): 아트 번들은 유저
 * 운영·공지와 대상도 원장 액션 접두사({@code chars_})도 다르다. 다만 {@link AdminErrorHandler} 의
 * {@code assignableTypes} 에 등록해 <b>에러 소독은 동일하게</b> 받는다.
 *
 * <p><b>삭제 동사가 없다</b>: 롤백은 활성 포인터를 옮기는 것이고, 전부 끄면 web 이 구운 폴백으로
 * 돌아간다. 리비전을 지우면 되돌릴 것이 사라진다(W1 공지 이미지와 같은 철학).
 */
@RestController
@RequestMapping("/api/admin/chars")
public class AdminCharsController {

    private final AdminCharBundleService bundles;

    public AdminCharsController(AdminCharBundleService bundles) {
        this.bundles = bundles;
    }

    /** 리비전 목록 + 지금 활성인 것 + 보관소 경로(운영 진단). */
    @GetMapping("/bundles")
    public BundleListResponse list() {
        return new BundleListResponse(bundles.list(), bundles.activeRevision(), bundles.storageRoot());
    }

    /** 아트 운영 이력(성공·실패 모두). */
    @GetMapping("/bundles/history")
    public List<AdminEconomyService.AuditEntry> history(
            @RequestParam(name = "limit", required = false, defaultValue = "20") int limit) {
        return bundles.history(limit);
    }

    /**
     * 번들(zip) 업로드 — <b>활성화하지 않는다</b>. 올리는 것과 켜는 것을 나눈 이유는
     * {@link AdminCharBundleService#upload} 주석 참조(잘못된 아트가 확인 전에 라이브로 나가지 않게).
     */
    @PostMapping("/bundles")
    @org.springframework.web.bind.annotation.ResponseStatus(org.springframework.http.HttpStatus.CREATED)
    public AdminCharBundleService.BundleView upload(
            @RequestAttribute("userId") String actorUserId,
            @RequestPart(name = "file", required = false) MultipartFile file,
            @RequestParam(name = "note", required = false) String note,
            @RequestParam(name = "reason", required = false) String reason) {
        return bundles.upload(actorUserId, file, note, reason);
    }

    /**
     * 활성 리비전 전환. 바디의 {@code revisionId} 가 <b>비어 있으면 전부 끈다</b> =
     * 웹 빌드에 구운 아트로 롤백(= 이 기능이 없던 상태). 그게 이 API 의 안전장치다.
     */
    @PostMapping("/bundles/active")
    public AdminCharBundleService.ActiveResult setActive(
            @RequestAttribute("userId") String actorUserId,
            @RequestBody(required = false) AdminCharBundleService.ActivateRequest body) {
        return bundles.setActive(actorUserId,
                body == null ? null : body.revisionId(),
                body == null ? null : body.reason());
    }

    public record BundleListResponse(List<AdminCharBundleService.BundleView> bundles,
                                     String activeRevision, String storageRoot) {
    }
}
