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
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * A+B 오케스트레이션 분기 (#95) — Java 측.
 *
 * <p>A(덱 베이스) 프리컴퓨트·캐시 + 킥오프/재개 분기: 프롬프트 없음→A 재사용(콜0) / 있음→B 패치 /
 * A 미완→풀 생성 폴백. h2 는 h1 최종 인풋 재사용 또는 하프타임 프롬프트 시 B. FakeServants 가 patch kind 를
 * 완전 TacticalInput 으로 반환(실행기 계약)한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchAbBranchTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // 이 테스트의 주제는 시계가 아니다 — 레거시(즉시 전개) 흐름으로 고정한다(§7.7 롤백 경로).
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    // A(베이스) 잡 = 큐 라우팅 메타 NULL(크로스매치). 프리페치된 유저 A + 봇 A.
    private long baseJobCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL AND side IS NULL AND half IS NULL")
                .query(Long.class).single();
    }

    // B(패치) 잡 — context.kind='team-input-patch' (canonicalJson: "kind":"team-input-patch").
    // 경로 판정이므로 **유효 잡**만 센다 — 갈아탄 옛 행은 멱등 캐시로 남는다(#193 검증 B-2).
    private long patchJobCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND effective = 1
                          AND context_json LIKE '%"kind":"team-input-patch"%'
                        """)
                .params(matchId, half).query(Long.class).single();
    }

    // materialize 된 재사용 done 행(콜0).
    private long materializedCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND status = 'done'
                          AND effective = 1 AND context_json = '{"kind":"materialized"}'
                        """)
                .params(matchId, half).query(Long.class).single();
    }

    // 풀 생성(team-input) side 잡 — kind='team-input' 이면서 side 지정.
    private long fullTeamInputCount(String matchId, int half) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND side IS NOT NULL
                          AND effective = 1
                          AND context_json LIKE '%"kind":"team-input"%'
                          AND context_json NOT LIKE '%"kind":"team-input-patch"%'
                        """)
                .params(matchId, half).query(Long.class).single();
    }

    private void submitPre(String token, String matchId, String text) {
        authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", text), Map.class);
    }

    // ── A 프리페치 ───────────────────────────────────────────────────────

    @Test
    void aPrefetchedAtBriefing() {
        String token = setupUserWithDeck("m_ab_pref");
        String matchId = createMatch(token, "BOT_BAL");

        // 브리핑 진입 즉시 유저 A + 봇 A 2개(크로스매치 캐시). 아직 side 잡·B 없음.
        assertThat(baseJobCount()).isEqualTo(2L);
        assertThat(fullTeamInputCount(matchId, 1)).isZero();
        assertThat(patchJobCount(matchId, 1)).isZero();
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
    }

    // ── h1 분기 3종 ──────────────────────────────────────────────────────

    @Test
    void h1_noPrompt_reusesA_call0() {
        String token = setupUserWithDeck("m_ab_reuse");
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain(); // A(유저+봇) done — 킥오프 전 캐시 준비.

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        // 프롬프트 없음 → B 미생성, 풀생성 없음, 양측 materialize(콜0), 즉시 H1_BREAK.
        assertThat(patchJobCount(matchId, 1)).isZero();
        assertThat(fullTeamInputCount(matchId, 1)).isZero();
        assertThat(materializedCount(matchId, 1)).isEqualTo(2L);
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    @Test
    void h1_withPrompt_takesBPath() {
        String token = setupUserWithDeck("m_ab_bpath");
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain(); // A done.
        submitPre(token, matchId, "전원 압박, 라인 올려");

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        // 유저(home) B 패치 1개(base=A), 봇(away) materialize(프롬프트 무관). 풀생성 없음.
        assertThat(patchJobCount(matchId, 1)).isEqualTo(1L);
        assertThat(materializedCount(matchId, 1)).isEqualTo(1L); // 봇만 재사용
        assertThat(fullTeamInputCount(matchId, 1)).isZero();

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    @Test
    void h1_aIncomplete_fallsBackToFull() {
        String token = setupUserWithDeck("m_ab_fallback");
        String matchId = createMatch(token, "BOT_BAL");
        // A 미완(드레인 안 함) 상태에서 곧바로 킥오프.
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        // 양측 풀 생성(team-input) 폴백, B·materialize 없음.
        assertThat(fullTeamInputCount(matchId, 1)).isEqualTo(2L);
        assertThat(patchJobCount(matchId, 1)).isZero();
        assertThat(materializedCount(matchId, 1)).isZero();

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    // ── h2 분기 2종 ──────────────────────────────────────────────────────

    private String toH1Break(String token, String matchId) {
        fakeServants.drain(); // A done
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain(); // h1 sim(재사용이면 즉시였지만 안전하게)
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        return matchId;
    }

    @Test
    void h2_noInput_reusesH1Input_call0() {
        String token = setupUserWithDeck("m_ab_h2reuse");
        String matchId = createMatch(token, "BOT_BAL");
        toH1Break(token, matchId);

        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);

        // 하프타임 프롬프트·교체 없음 → h1 인풋 재사용(콜0), B 미생성, 즉시 FINISHED.
        assertThat(patchJobCount(matchId, 2)).isZero();
        assertThat(fullTeamInputCount(matchId, 2)).isZero();
        assertThat(materializedCount(matchId, 2)).isEqualTo(2L);
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    @Test
    void h2_halftimePrompt_takesBPath() {
        String token = setupUserWithDeck("m_ab_h2b");
        String matchId = createMatch(token, "BOT_BAL");
        toH1Break(token, matchId);

        authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "halftime", "scope", "team", "text", "리드 지켜, 라인 내려"), Map.class);
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);

        // 하프타임 프롬프트 → 유저(home) h2 B 패치(base=h1 인풋), 봇 재사용.
        assertThat(patchJobCount(matchId, 2)).isEqualTo(1L);
        assertThat(materializedCount(matchId, 2)).isEqualTo(1L); // 봇만
        assertThat(fullTeamInputCount(matchId, 2)).isZero();

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    // ── 크로스매치 캐시: 같은 봇 덱 재경기는 봇 A 를 재생성하지 않는다(id 멱등) ──

    @Test
    void botBaseIsCrossMatchCached() {
        String token = setupUserWithDeck("m_ab_cache");
        String m1 = createMatch(token, "BOT_BAL");
        long afterFirst = baseJobCount(); // 유저 A + 봇 A = 2

        String m2 = createMatch(token, "BOT_BAL"); // 같은 덱·같은 봇 → 유저 A·봇 A 모두 캐시 히트(멱등)
        long afterSecond = baseJobCount();

        assertThat(afterFirst).isEqualTo(2L);
        assertThat(afterSecond).isEqualTo(2L); // 동일 덱/봇 → 새 A 없음(크로스매치 재사용)
        assertThat(m1).isNotEqualTo(m2);
    }
}
