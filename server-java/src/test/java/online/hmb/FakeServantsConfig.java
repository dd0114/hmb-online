package online.hmb;

import com.fasterxml.jackson.databind.ObjectMapper;
import online.hmb.jobs.AiJobQueue;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

/** 매치플로우 테스트 공용 — FakeServants 빈 (@Import(FakeServantsConfig.class)로 사용). */
@TestConfiguration
public class FakeServantsConfig {

    @Bean
    public FakeServants fakeServants(AiJobQueue jobQueue, ObjectMapper objectMapper) {
        return new FakeServants(jobQueue, objectMapper);
    }
}
