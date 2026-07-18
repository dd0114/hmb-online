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
 * A(베이스) 프리페치 — 크리티컬 패스 밖. (#95 A+B 로 재정의: 구 봇-only 프리페치 → 유저 A + 봇 A.)
 *
 * 브리핑(매치 생성) 진입 즉시 유저팀 A + 봇 A 를 크로스매치 캐시(match_id/side/half=NULL)로 enqueue한다.
 * 유저가 프롬프트를 쓰는 동안 A 가 생성돼 킥오프 크리티컬 패스에서 콜을 줄인다(콜0 재사용 또는 가벼운 B).
 * A-id 는 덱 스냅샷 재료의 sha256 이라 재-enqueue·재경기가 멱등(중복 잡 없음).
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

    /** A(베이스) 잡 = 크로스매치 캐시(라우팅 메타 NULL). */
    private long baseJobCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL AND side IS NULL AND half IS NULL")
                .query(Long.class).single();
    }

    /** 특정 매치의 (half, side) side-잡(풀생성/B/materialize 모두 side 지정) 수. */
    private long sideJobCount(String matchId, int half, String side) {
        return jdbcClient.sql(
                        "SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND side = ?")
                .params(matchId, half, side).query(Long.class).single();
    }

    @Test
    void baseInputsEnqueuedAtBriefingBeforeKickoff() {
        String token = setupUserWithDeck("m_prefetch_h1");
        String matchId = createMatch(token, "BOT_BAL");

        // 프리페치: 브리핑 진입 직후 유저 A + 봇 A 2개가 이미 큐에(킥오프 전, 유저 프롬프트 전).
        assertThat(baseJobCount()).isEqualTo(2L);
        // 아직 이 매치의 per-side 잡은 없음(킥오프 때 재사용/B/폴백으로 결정).
        assertThat(sideJobCount(matchId, 1, "home")).isZero();
        assertThat(sideJobCount(matchId, 1, "away")).isZero();
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
    }

    @Test
    void kickoffReusesPrefetchedBaseWithoutExtraCall() {
        String token = setupUserWithDeck("m_prefetch_idem");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(baseJobCount()).isEqualTo(2L);
        fakeServants.drain(); // A 완료(캐시 준비) — 이후 킥오프는 콜0.

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        // 프롬프트 없음 → 양측 재사용(materialize) 각 1행, 정상 H1_BREAK.
        assertThat(sideJobCount(matchId, 1, "home")).isEqualTo(1L);
        assertThat(sideJobCount(matchId, 1, "away")).isEqualTo(1L);
        assertThat(matchState(matchId)).isEqualTo("H1_BREAK");
    }

    @Test
    void fullFlowStillReachesFinished() {
        // 프리페치·A+B 분기가 켜진 상태에서도 전체 플로우가 FINISHED 에 도달(회귀 가드).
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
