package online.hmb.auth;

import online.hmb.admin.AdminInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 인증/인가 인터셉터 등록:
 * <ul>
 *   <li><b>order 0</b> {@link AuthInterceptor}: /api/** 전체(로그인 /api/auth/** 제외) — Bearer 세션 → 401.</li>
 *   <li><b>order 10</b> {@link AdminInterceptor}: /api/admin/** — 인증된 요청의 admin 인가 → 403 (P3 §C, AC-C2).</li>
 *   <li>{@link ServantTokenInterceptor}: /internal/** 전체(health 포함) — X-Servant-Token(AC-Q3, W4).</li>
 * </ul>
 *
 * <p><b>순서와 중복</b>: {@code /api/admin/**} 은 {@code /api/**} 의 부분집합이라 두 인터셉터가 모두
 * 매칭된다. 이는 의도된 것이다 — 인증(401)과 인가(403)를 각각 <b>한 번씩</b> 수행하며 토큰 검증이
 * 중복되지는 않는다({@code AdminInterceptor} 는 세션을 다시 조회하지 않고 앞 단계가 넣은 attribute 만 읽는다).
 * 순서는 등록 순서에 의존하지 않도록 <b>명시적 order</b> 로 고정한다: 인증이 반드시 먼저다
 * (그래야 미인증 요청이 403 이 아니라 401 을 받는다).
 */
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;
    private final AdminInterceptor adminInterceptor;
    private final ServantTokenInterceptor servantTokenInterceptor;

    public WebMvcConfig(AuthInterceptor authInterceptor,
                        AdminInterceptor adminInterceptor,
                        ServantTokenInterceptor servantTokenInterceptor) {
        this.authInterceptor = authInterceptor;
        this.adminInterceptor = adminInterceptor;
        this.servantTokenInterceptor = servantTokenInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/api/**")
                // /api/config(#232) = 재화 표기·상점 가격 부트스트랩. **인증 이전에 필요하다** —
                // 로그인 화면·가입 연출도 금액을 그리고, 무엇보다 클라가 앱 부팅 시 한 번 받아
                // 트리에 내리는 값이라 여기서 401 을 내면 그 세션 전체가 표기 없이 굴러간다
                // (독립검증 BL-1: 로그아웃 콜드 부팅 유저가 세션 내내 "62,000 POINT" 를 봤다).
                // 내용은 공개 카탈로그(심볼·이름·공시 가격)라 감출 것이 없다 — 유저별 데이터 0.
                // /api/notices/active(#248) = 홈 팝업이 읽는 공지 피드. 같은 이유로 공개다 —
                // 유저별 데이터가 0인 전체 브로드캐스트이고, 무엇보다 **점검 공지는 로그인이
                // 안 될 때 가장 필요하다**. 여기에 401 을 두면 정확히 그 순간에 안 보인다.
                // 계약 = NoticeActiveApiTest.activeNoticesAreReachableWithoutAuth(되돌리면 깨진다).
                // /api/notices/{id}(#297) = 공유 딥링크가 읽는 단건. **공유 링크는 정의상 미로그인
                // 상태에서 열린다** — 카톡으로 받은 링크가 로그인 벽부터 보여 주면 공지는 도달하지 않는다.
                // 내용은 피드와 같은 전체 브로드캐스트이고, 아직 공개 전(SCHEDULED)·삭제된 공지는
                // 인증과 무관하게 404 로 숨긴다(존재 누출 차단은 컨트롤러 결정표가 한다).
                // 계약 = NoticeByIdApiTest.reachableWithoutAuth.
                // /api/notices/assets/{id}(#309) = 그 본문이 가리키는 **이미지**. 같은 이유다 —
                // 여기에만 401 을 두면 점검 공지가 글은 뜨고 그림만 깨진 채로 보인다. 유저별 데이터 0.
                // 계약 = NoticeAssetApiTest.assetsAreReachableWithoutAuth.
                // /api/chars/**(#309 W2) = 유닛 아트 번들. 아트는 로그인 화면·가입 연출에서도
                // 그려지는 **공개 카탈로그**(유저별 데이터 0)라, 401 을 두면 그 화면들이 통째로
                // 이니셜 폴백이 된다. 계약 = CharBundleApiTest.artIsReachableWithoutAuth.
                // ⚠️ 여기만 `**` 인 이유: 그 엔드포인트 **자체가 파일 트리**다(`units/manifest.json`,
                //    `units/avatars-64.png` … 다중 세그먼트). 즉 이건 목록을 뭉친 게 아니라 엔드포인트
                //    하나의 실제 모양이고, `/api/notices` 와 달리 유저 스코프 경로가 섞일 접두사가 아니다.
                //
                // ⚠️ 공지 패턴들은 서로 겹친다({id} 는 'active'·'assets' 세그먼트도 매칭한다). 목록을
                //    줄이지 마라 — 공개 대상을 **엔드포인트 단위로 열거**하는 것이 이 목록의 존재
                //    이유다. /api/notices/** 로 뭉치면 나중에 유저 스코프 하위경로가 생겨도 조용히
                //    공개된다. 같은 이유로 자산도 `assets/**` 가 아니라 `assets/{id}` 로 적는다 —
                //    그 엔드포인트가 실제로 받는 모양이 그것뿐이고, 하위경로가 생기면 여기에 한 줄
                //    더 적는 편이 낫다.
                .excludePathPatterns(
                        "/api/auth/**", "/api/config", "/api/notices/active", "/api/notices/{id}",
                        "/api/notices/assets/{id}", "/api/chars/**")
                .order(0);
        registry.addInterceptor(adminInterceptor)
                .addPathPatterns(AdminInterceptor.ADMIN_PATH_PATTERN)
                .order(10);
        registry.addInterceptor(servantTokenInterceptor)
                .addPathPatterns("/internal/**");
    }
}
