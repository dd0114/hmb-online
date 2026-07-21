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
                .excludePathPatterns("/api/auth/**")
                .order(0);
        registry.addInterceptor(adminInterceptor)
                .addPathPatterns(AdminInterceptor.ADMIN_PATH_PATTERN)
                .order(10);
        registry.addInterceptor(servantTokenInterceptor)
                .addPathPatterns("/internal/**");
    }
}
