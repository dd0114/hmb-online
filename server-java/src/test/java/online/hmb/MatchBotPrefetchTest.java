package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #1 봇 프리페치 — 봇(away) 잡을 크리티컬 패스 밖에서 미리 enqueue.
 * h1 = 브리핑(매치 생성) 시점, h2 = H1_BREAK 진입 시점. 봇 컨텍스트는 유저 입력 무관(페르소나 기반)
 * 이라 프리페치 promptHash 가 킥오프/재개 때 enqueueHalf 와 동일 → 멱등(중복 잡 없음).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchBotPrefetchTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    private long jobCount(String matchId, int half, String side) {
        return jdbcClient.sql(
                        "SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND side = ?")
                .params(matchId, half, side).query(Long.class).single();
    }

    @Test
    void botH1EnqueuedAtBriefingBeforeKickoff() {
        String token = setupUserWithDeck("m_prefetch_h1");
        String matchId = createMatch(token, "BOT_BAL");

        // 프리페치(#1): 브리핑 진입 직후 봇(away) h1 잡이 이미 큐에 있어야 한다(유저 프롬프트·킥오프 전).
        assertThat(jobCount(matchId, 1, "away")).isEqualTo(1L);
        // home 은 유저 프롬프트 의존 → 아직 없음(킥오프 때 enqueue).
        assertThat(jobCount(matchId, 1, "home")).isEqualTo(0L);
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
    }

    @Test
    void kickoffIsIdempotentWithPrefetchedBotJob() {
        String token = setupUserWithDeck("m_prefetch_idem");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(jobCount(matchId, 1, "away")).isEqualTo(1L); // 프리페치됨

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        // 킥오프의 enqueueHalf(1) 이 away 를 다시 enqueue 해도 동일 promptHash → 중복 없음(정확히 1행).
        assertThat(jobCount(matchId, 1, "away")).isEqualTo(1L);
        assertThat(jobCount(matchId, 1, "home")).isEqualTo(1L); // home 은 이제 enqueue

        // 정상 진행: 드레인 → H1_BREAK
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("H1_BREAK");
    }

    @Test
    void botH2EnqueuedAtH1BreakBeforeResume() {
        String token = setupUserWithDeck("m_prefetch_h2");
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("H1_BREAK");

        // 프리페치(#1): H1_BREAK 진입 시 봇 h2 잡이 이미 큐에 있어야 한다(재개 전).
        assertThat(jobCount(matchId, 2, "away")).isEqualTo(1L);
        // home h2 는 하프타임 프롬프트/교체 의존 → 재개 때 enqueue.
        assertThat(jobCount(matchId, 2, "home")).isEqualTo(0L);

        // 재개 멱등: away h2 재-enqueue 해도 1행 유지, 정상 FINISHED.
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        assertThat(jobCount(matchId, 2, "away")).isEqualTo(1L);
        assertThat(jobCount(matchId, 2, "home")).isEqualTo(1L);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    @Test
    void prefetchedBotFullFlowStillReachesFinished() {
        // 프리페치가 켜진 상태에서도 전체 플로우가 FINISHED + 정상 스코어에 도달(회귀 가드).
        String token = setupUserWithDeck("m_prefetch_full");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();

        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }
}
