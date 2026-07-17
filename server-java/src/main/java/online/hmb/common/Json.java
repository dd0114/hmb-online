package online.hmb.common;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

/**
 * Jackson 설정: camelCase 고정(웹·서번트와 동일 계약), snake_case 금지.
 * *_json 컬럼(JSON-in-TEXT)의 직렬화/역직렬화에도 이 ObjectMapper를 재사용한다.
 */
@Configuration
public class Json {

    @Bean
    @Primary
    public ObjectMapper objectMapper() {
        return new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
        // PropertyNamingStrategy 기본값 = LOWER_CAMEL_CASE (Java 필드명 그대로) — 별도 전략 불필요.
    }
}
