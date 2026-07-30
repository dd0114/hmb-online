package online.hmb.chars;

import online.hmb.common.ApiException;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.HandlerMapping;

/**
 * 아트 번들 <b>공개 서빙</b> (#309 W2) — `/api/chars/**`.
 *
 * <p><b>왜 {@code /api/} 아래인가</b>: 매니페스트는 {@code <img>} 가 아니라 {@code fetch} 로 읽는다 →
 * <b>CORS 가 실제로 필요하다</b>. {@code CorsConfig} 는 {@code /api/**} 에만 등록돼 있으므로,
 * {@code /chars/**} 로 내면 CORS 를 새로 열어야 하고 그 결정이 조용히 잊힌다. 경로를 규칙 안에 둔다.
 *
 * <p><b>인증 제외</b>({@code WebMvcConfig}): 아트는 로그인 화면·가입 연출에서도 그려지고, 유저별
 * 데이터가 0인 공개 카탈로그다. 여기에 401 을 두면 그 화면들이 통째로 이니셜 폴백이 된다.
 *
 * <p><b>캐시</b>: 파일은 <b>리비전 디렉토리</b>에 담기고 새 아트는 새 리비전이 되지만, URL 에는
 * 리비전이 들어 있지 않다(구운 폴백과 경로 모양을 맞춰야 {@code assetUrl} 이 한 벌로 돌아간다).
 * 그래서 <b>장기 캐시를 걸지 않는다</b> — 걸면 아트를 갈아끼워도 유저 브라우저가 옛 그림을 계속
 * 그리고, 그건 이 웨이브가 없애려는 "배포해도 안 바뀐다"와 같은 증상이다.
 */
@RestController
public class CharBundleController {

    private final CharBundleService bundles;

    public CharBundleController(CharBundleService bundles) {
        this.bundles = bundles;
    }

    /**
     * 활성 번들이 있는지. <b>web 의 폴백 판정 트리거</b> — 404 면 구운 `/chars` 를 쓴다.
     */
    @GetMapping("/api/chars/index")
    public CharBundleService.BundleIndex index() {
        return bundles.index()
                .orElseThrow(() -> ApiException.notFound("활성 아트 번들이 없습니다"));
    }

    /**
     * 번들 안의 파일 하나. 경로가 여러 세그먼트({@code units/art-bonaldo.png})라 와일드카드로 받는다.
     *
     * <p>⚠️ {@code @PathVariable} 은 슬래시를 못 받으므로 매칭된 패턴에서 직접 꺼낸다. 그 값은
     * <b>사용자 입력</b>이므로 {@link CharBundleStorage#read} 가 엔트리 이름 규칙(`..` 거부 ·
     * 확장자 화이트리스트)으로 다시 자른다 — 조작된 경로는 "없다"로 답한다.
     */
    @GetMapping("/api/chars/**")
    public ResponseEntity<byte[]> file(jakarta.servlet.http.HttpServletRequest request) {
        String path = (String) request.getAttribute(HandlerMapping.PATH_WITHIN_HANDLER_MAPPING_ATTRIBUTE);
        String rel = path == null ? "" : path.replaceFirst("^/api/chars/", "");
        CharBundleStorage.Served served = rel.isEmpty() ? null : bundles.read(rel);
        if (served == null) {
            throw ApiException.notFound("아트 파일을 찾을 수 없습니다: " + rel);
        }
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(served.contentType()))
                .header("X-Content-Type-Options", "nosniff")
                // 짧은 캐시 — 트래픽은 줄이되 갈아끼운 아트가 몇 분 안에 반영된다.
                .cacheControl(CacheControl.maxAge(java.time.Duration.ofMinutes(5)).cachePublic())
                .body(served.bytes());
    }
}
