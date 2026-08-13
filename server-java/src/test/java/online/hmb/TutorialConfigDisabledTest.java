package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #493 W9 — {@code GET /api/config} 의 {@code tutorial.starterCardId} <b>폴백 분기</b>.
 *
 * <p>튜토리얼 재료 지급이 꺼진 배포({@code hmb.tutorial.starter.enabled=false} — 이 웨이브 이전
 * 동작으로 되돌리는 롤백 스위치)엔 <b>고정 카드가 없다</b>. 설정값을 그대로 흘리면 클라가 유저가
 * 갖고 있지도 않은 카드로 온레일 가이드를 걸고, 그건 "모른다"보다 나쁜 거짓말이다.
 *
 * <p>이 클래스가 따로 있는 이유는 {@code enabled} 가 <b>클래스 단위 프로퍼티</b>라서다. 그리고
 * 이런 폴백 분기에 표본을 안 두면 변이체가 그대로 살아남는다 — server-java CLAUDE.md 가
 * "폴백 분기에 계약이 없었다"로 이미 기록해 둔 함정이다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class TutorialConfigDisabledTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableTutorialStarter(registry);
    }

    @Test
    void theCardIdIsNullWhenTheTutorialStarterIsOff() {
        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/config"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        Map<String, Object> tutorial = (Map<String, Object>) res.getBody().get("tutorial");
        assertThat(tutorial).as("키 자체는 있어야 한다 — 클라가 '없음'과 '모름'을 구분한다").isNotNull();
        assertThat(tutorial.get("starterCardId"))
                .as("지급이 꺼진 배포엔 고정 카드가 없다").isNull();
    }
}
