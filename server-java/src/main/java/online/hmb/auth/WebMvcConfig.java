package online.hmb.auth;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 인증 인터셉터 등록:
 * - AuthInterceptor: /api/** 전체(로그인 /api/auth/** 제외) — Bearer 세션.
 * - ServantTokenInterceptor: /internal/** 전체(health 포함) — X-Servant-Token(AC-Q3, W4).
 */
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;
    private final ServantTokenInterceptor servantTokenInterceptor;

    public WebMvcConfig(AuthInterceptor authInterceptor, ServantTokenInterceptor servantTokenInterceptor) {
        this.authInterceptor = authInterceptor;
        this.servantTokenInterceptor = servantTokenInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/auth/**");
        registry.addInterceptor(servantTokenInterceptor)
                .addPathPatterns("/internal/**");
    }
}
