package online.hmb.config;

import java.util.Arrays;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;

/**
 * CORS 설정 (오픈 blocker B1, 이슈 #128). web 은 Cloudflare Pages(정적), 백엔드는 Cloudflare Tunnel
 * 뒤 별도 오리진 — 브라우저 입장에서 <b>교차 오리진</b>이므로 preflight 를 통과시켜야 한다(PRD-v4 §G/P3-D1).
 *
 * <p><b>왜 {@link CorsFilter}(CorsConfigurationSource) 이고 {@code addCorsMappings} 가 아닌가</b>:
 * 이 스택엔 Spring Security 가 없다. {@code CorsFilter} 는 서블릿 필터라 {@code DispatcherServlet} 보다
 * <b>먼저</b> 돌고, preflight(OPTIONS + Access-Control-Request-Method)를 자기 선에서 처리한 뒤
 * 필터체인을 <b>이어가지 않고 반환</b>한다. 따라서 preflight 는 {@link online.hmb.auth.AuthInterceptor}
 * 에 도달하지 않는다 — {@code /api/me} 같은 인증 경로의 preflight 가 Authorization 헤더가 없어 401 로
 * 막히는 함정을 <b>구조적으로</b> 없앤다(MVC 인터셉터-스킵 내부동작에 의존하지 않는다).
 * {@code HIGHEST_PRECEDENCE} 로 등록해 인증 필터/인터셉터보다 앞에 둔다.
 *
 * <p><b>스코프</b>: {@code /api/**} 에만 CORS 를 연다. {@code /internal/**}(서번트 전용 X-Servant-Token,
 * 브라우저 비노출)에는 CorsConfiguration 을 등록하지 않는다 → 그 경로엔 Access-Control-Allow-* 가 붙지 않는다.
 *
 * <p><b>allowCredentials=false</b>: 쿠키 미사용(Bearer 토큰, localStorage). 켜면 스프링이 와일드카드
 * 오리진과 충돌 예외를 던지므로 끈다.
 *
 * <p><b>허용 오리진은 env</b>: {@code hmb.cors.allowed-origins}(콤마 구분) → {@code HMB_CORS_ALLOWEDORIGINS}.
 * quick tunnel/Pages URL 이 바뀌어도 재빌드 없이 교체 가능. 기본값은 로컬 dev 오리진 하나뿐(와일드카드
 * 아님) — 미설정 시 아무 데서나 열리지 않는다(무회귀).
 */
@Configuration
public class CorsConfig {

    /** {@code /api/**} 가 실제 쓰는 메서드 + preflight 용 OPTIONS. */
    private static final List<String> ALLOWED_METHODS = List.of("GET", "POST", "PUT", "DELETE", "OPTIONS");

    /** web 은 {@code Authorization: Bearer} + JSON 본문을 보낸다. */
    private static final List<String> ALLOWED_HEADERS = List.of("Authorization", "Content-Type");

    private final List<String> allowedOrigins;

    public CorsConfig(@Value("${hmb.cors.allowed-origins:http://localhost:5173}") String allowedOriginsCsv) {
        this.allowedOrigins = Arrays.stream(allowedOriginsCsv.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(allowedOrigins);
        config.setAllowedMethods(ALLOWED_METHODS);
        config.setAllowedHeaders(ALLOWED_HEADERS);
        config.setAllowCredentials(false);
        config.setMaxAge(3600L);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        // /internal/** 은 의도적으로 미등록 — 서번트 전용, 브라우저에 CORS 로 열지 않는다.
        return source;
    }

    @Bean
    FilterRegistrationBean<CorsFilter> corsFilterRegistration(CorsConfigurationSource corsConfigurationSource) {
        FilterRegistrationBean<CorsFilter> registration =
                new FilterRegistrationBean<>(new CorsFilter(corsConfigurationSource));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        registration.setName("corsFilter");
        return registration;
    }
}
