package online.hmb.meta;

import online.hmb.common.ApiException;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /internal/ai-mode} — AI 실행기의 실효 모드 자기신고 (#471 AC3).
 *
 * <p>인증은 별도 배선이 없다 — {@code WebMvcConfig} 가 {@code ServantTokenInterceptor} 를
 * {@code /internal/**} 전체에 붙이므로 {@code X-Servant-Token} 없이는 401 이다(잡 큐와 같은 문).
 *
 * <p>모드 어휘는 {@code live}/{@code stub} 둘뿐이다. {@code unknown} 은 <b>서버가</b> 붙이는 상태이지
 * 실행기가 신고할 수 있는 값이 아니다 — 받아 주면 "모르겠다"가 신고로 박제돼 TTL 만료와 구분이 사라진다.
 */
@RestController
public class InternalAiModeController {

    private final AiModeService aiModeService;

    public InternalAiModeController(AiModeService aiModeService) {
        this.aiModeService = aiModeService;
    }

    @PostMapping("/internal/ai-mode")
    public AiModeService.AiModeView report(@RequestBody AiModeReportRequest req) {
        String mode = req == null ? null : req.mode();
        if (!AiModeService.MODE_LIVE.equals(mode) && !AiModeService.MODE_STUB.equals(mode)) {
            throw ApiException.validation("mode 는 live 또는 stub 이어야 합니다: " + mode);
        }
        aiModeService.report(mode, req.reason(), req.wanted(), req.effective());
        return aiModeService.current();
    }

    /** 실행기 {@code java-client.ts:AiModeReport} 와 짝. {@code workerId} 는 진단용이라 저장하지 않는다. */
    public record AiModeReportRequest(String mode, String reason, String wanted, String effective, String workerId) {
    }
}
