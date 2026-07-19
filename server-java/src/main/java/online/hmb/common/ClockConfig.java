package online.hmb.common;

import java.time.Clock;
import java.time.ZoneId;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 시계 빈 — 게임 '당일'(컨디션 날짜시드 등) 판정 존은 config({@code hmb.match.condition.zone},
 * 기본 Asia/Seoul)이 SoT다(하드코딩 금지). 테스트는 {@code @TestConfiguration} 에서
 * {@code @Primary Clock}(Clock.fixed)로 교체해 자정 경계를 재현한다(TradeSeedSource 와 동일 패턴).
 */
@Configuration
public class ClockConfig {

    @Bean
    public Clock systemClock(@Value("${hmb.match.condition.zone}") String zone) {
        return Clock.system(ZoneId.of(zone));
    }
}
