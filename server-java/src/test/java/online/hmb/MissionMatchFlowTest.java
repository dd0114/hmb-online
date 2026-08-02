package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
import online.hmb.mission.MissionService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 원정 데일리 미션 — <b>배선</b> 계약 (#408).
 *
 * <p>{@code MissionDailyTest} 는 판정 규칙을 서비스 단위로 태운다. 이 클래스는 그것만으로는 절대
 * 관측되지 않는 것 하나를 본다: <b>실제 원정 경기를 끝내면 아무도 서비스를 부르지 않는 상태</b>.
 * 훅({@code MatchOrchestrator.finishMatch})을 지우면 서비스 계약은 전부 green 인데 게임에서는
 * 미션이 영원히 0/N 이다 — #368 이 같은 이유로 이 자리에 계약을 하나 세웠다.
 *
 * <p>그리고 훅이 <b>거기에만</b> 있다는 사실이 §6.5(포기는 진행도를 올리지 않는다)를 구조적으로
 * 보장하므로, 그 사실도 여기서 표본으로 확인한다 — 훅을 {@code awayService.settle} 안으로 옮기는
 * 변이는 "출전 3회"를 포기 3번으로 여는 문이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MissionMatchFlowTest extends MatchTestBase {

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

    @Resource
    private MatchClockSweeper clockSweeper;

    @Resource
    private online.hmb.away.AwayService awayService;

    @Resource
    private MissionService missionService;

    /** 제시 목록을 서버가 소유하므로(#245 E2), 프로덕션과 같은 상태를 만들어 두고 상대를 고정한다. */
    private String startAwayPinned(String attackerId, String defenderId) {
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(attackerId, "[\"" + defenderId + "\"]", Instant.now().toString())
                .update();
        return awayService.start(attackerId, defenderId).id();
    }

    private String driveAwayToFinished(String attackerToken, String attackerId, String defenderId) {
        String matchId = startAwayPinned(attackerId, defenderId);
        authPost("/api/matches/" + matchId + "/kickoff", attackerToken, Map.of(), Map.class);
        fakeServants.drain();
        for (int i = 0; i < 6 && !"FINISHED".equals(matchState(matchId)); i++) {
            jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                    .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                    .update();
            clockSweeper.sweep();
            fakeServants.drain();
        }
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        return matchId;
    }

    private long progressRows(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM daily_mission_progress WHERE match_id = ?")
                .param(matchId).query(Long.class).single();
    }

    private long totalProgress(String userId) {
        return jdbcClient.sql("SELECT COALESCE(SUM(progress), 0) FROM daily_missions WHERE user_id = ?")
                .param(userId).query(Long.class).single();
    }

    /**
     * <b>훅 계약</b> — 실제 원정 한 판이 HTTP·엔진·시계를 전부 지나 미션을 민다.
     *
     * <p>어떤 미션이 뽑혔는지에 의존하지 않는다(추첨 시드가 ULID 유저 id 라 실행마다 다르다).
     * 대신 "이 경기가 <b>오늘의 두 미션 모두</b>에 대해 진행 기록을 남겼다"를 본다 — 픽스처 경기는
     * 1:0 승리라 14종 중 어떤 조합이 나와도 최소 1은 오른다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void finishingARealAwayMatchAdvancesTodaysMissionsThroughTheWholeFlow() {
        setupOpponentWithDeck("msn_def1");
        String attacker = setupUserWithDeck("msn_atk1");
        String attackerId = userIdOf("msn_atk1");

        String matchId = driveAwayToFinished(attacker, attackerId, userIdOf("msn_def1"));

        assertThat(progressRows(matchId))
                .as("훅이 없으면 이 행이 0 이다 — 서비스 단위 계약은 전부 green 인 채로")
                .isEqualTo(2L);
        List<MissionService.MissionView> missions =
                missionService.daily(attackerId).missions();
        assertThat(missions).hasSize(2);
        assertThat(missions).allSatisfy(m ->
                assertThat(m.progress()).as("%s 이 안 움직였다", m.missionId()).isPositive());

        // 결과 화면 additive — "이 경기가 미션을 얼마나 밀었나"(§8).
        ResponseEntity<Map> result = authGet("/api/matches/" + matchId + "/result", attacker, Map.class);
        assertThat(result.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> carried = (List<Map<String, Object>>) result.getBody().get("missions");
        assertThat(carried).hasSize(2);
        for (Map<String, Object> m : carried) {
            assertThat(m).containsKeys("id", "missionId", "title", "tier", "currency", "amount",
                    "progress", "target", "completedNow");
            assertThat((String) m.get("title")).isNotBlank();
            assertThat(((Number) m.get("amount")).intValue())
                    .as("재화와 금액은 항상 같이 온다(#232)").isPositive();
            assertThat(m.get("currency")).isEqualTo("GEM");
        }

        // 같은 GET 을 다시 불러도 같은 답이다(델타를 행으로 남기지 않으면 두 번째가 달라진다).
        ResponseEntity<Map> again = authGet("/api/matches/" + matchId + "/result", attacker, Map.class);
        assertThat(again.getBody().get("missions")).isEqualTo(carried);
    }

    /**
     * §6.5 — <b>포기는 진행도를 올리지 않는다.</b> 자발 포기는 몰수 정산({@code awayService.settle})은
     * 지나지만 {@code finishMatch} 는 지나지 않는다. 훅을 원정 정산 안으로 옮긴 변이체가 여기서 죽는다
     * (그 문이 열리면 "원정 3회"를 만들고 무르기 3번으로 끝낼 수 있다).
     */
    @Test
    void abandoningAnAwayMatchInBriefingDoesNotAdvanceAnyMission() {
        setupOpponentWithDeck("msn_def2");
        String attacker = setupUserWithDeck("msn_atk2");
        String attackerId = userIdOf("msn_atk2");
        missionService.daily(attackerId);   // 오늘 미션 2개를 미리 세워 둔다

        String matchId = startAwayPinned(attackerId, userIdOf("msn_def2"));
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
        assertThat(authPost("/api/matches/" + matchId + "/abandon", attacker, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(matchState(matchId)).isEqualTo("ABANDONED");

        // 몰수 정산은 실제로 돌았다(리포트가 있다) — 그런데도 미션은 0 이어야 한다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE match_id = ?")
                .param(matchId).query(Long.class).single()).isEqualTo(1L);
        assertThat(progressRows(matchId)).isZero();
        assertThat(totalProgress(attackerId)).isZero();
    }

    /** 미션은 <b>원정 축</b>이다 — 연습 경기는 진행도를 올리지 않는다. */
    @Test
    void practiceMatchesDoNotAdvanceAwayMissions() {
        String token = setupUserWithDeck("msn_practice");
        String userId = userIdOf("msn_practice");
        missionService.daily(userId);

        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        for (int i = 0; i < 6 && !"FINISHED".equals(matchState(matchId)); i++) {
            jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                    .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                    .update();
            clockSweeper.sweep();
            fakeServants.drain();
        }
        assertThat(matchState(matchId)).isEqualTo("FINISHED");

        assertThat(progressRows(matchId)).isZero();
        assertThat(totalProgress(userId)).isZero();
    }

    /**
     * ⚠️ <b>수비자는 공격자의 미션을 못 본다.</b> {@code GET /result} 는 원정 수비자에게도 열려
     * 있으므로(#245 {@code getViewable}) 미션을 매치 축으로만 조회하면 상대의 진행도가 그대로 샌다.
     * "권한 확대는 읽기냐 쓰기냐만이 아니라 무엇을 읽느냐도 좁혀야 한다"(#245 BL-1).
     */
    @Test
    @SuppressWarnings("unchecked")
    void aDefenderWatchingTheResultDoesNotSeeTheAttackersMissions() {
        setupOpponentWithDeck("msn_def3");
        String defenderToken = login("msn_def3");
        String attacker = setupUserWithDeck("msn_atk3");
        String attackerId = userIdOf("msn_atk3");

        String matchId = driveAwayToFinished(attacker, attackerId, userIdOf("msn_def3"));
        assertThat(progressRows(matchId)).isEqualTo(2L);

        ResponseEntity<Map> asDefender =
                authGet("/api/matches/" + matchId + "/result", defenderToken, Map.class);
        assertThat(asDefender.getStatusCode()).as("관전 자체는 허용된다").isEqualTo(HttpStatus.OK);
        assertThat((List<Map<String, Object>>) asDefender.getBody().get("missions")).isEmpty();
    }

    /** API 3종이 인증 없이는 닿지 않는다 — 미션은 정의상 <b>내 것</b>이다(공지와 다르다). */
    @Test
    void missionEndpointsRequireAuth() {
        assertThat(rest.getForEntity(baseUrl("/api/missions/daily"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(postJson("/api/missions/does-not-exist/claim", Map.of()).status())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(postJson("/api/missions/does-not-exist/reroll", Map.of()).status())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /** HTTP 계약 왕복 — 조회 → 리롤 → 수령이 문서의 모양 그대로 나간다(web 웨이브가 소비하는 형태). */
    @Test
    @SuppressWarnings("unchecked")
    void theDailyEndpointCarriesTheDocumentedShape() {
        String token = setupUserWithDeck("msn_shape");

        ResponseEntity<Map> res = authGet("/api/missions/daily", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        assertThat(body).containsKeys("day", "resetAtKst", "missions", "claimableCount", "claimableAmount");
        List<Map<String, Object>> missions = (List<Map<String, Object>>) body.get("missions");
        assertThat(missions).hasSize(2);
        assertThat(missions.get(0)).containsKeys("id", "missionId", "title", "tier", "currency",
                "amount", "progress", "target", "state", "rerollable");
        assertThat(missions.get(0).get("state")).isEqualTo("IN_PROGRESS");
        assertThat(missions.get(0).get("rerollable")).isEqualTo(true);
        assertThat((String) body.get("resetAtKst")).matches("\\d{4}-\\d{2}-\\d{2}T00:00:00\\+09:00");

        String id = (String) missions.get(0).get("id");
        ResponseEntity<Map> rerolled =
                authPost("/api/missions/" + id + "/reroll", token, Map.of(), Map.class);
        assertThat(rerolled.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> fresh = (Map<String, Object>) rerolled.getBody().get("mission");
        assertThat(fresh.get("rerollable")).isEqualTo(false);
        assertThat(fresh.get("missionId")).isNotEqualTo(missions.get(0).get("missionId"));

        // 미달성 수령은 409 + 문서의 코드.
        var early = postJsonAuth("/api/missions/" + fresh.get("id") + "/claim", token);
        assertThat(early.status()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(asMap(early).get("code")).isEqualTo("MISSION_NOT_COMPLETED");
    }

    /** 인증 헤더를 실은 POST — 4xx 본문을 읽어야 하는 곳에서 쓴다(TestRestTemplate 은 본문을 안 준다). */
    private HttpResult postJsonAuth(String path, String token) {
        try {
            java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl(path)))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token)
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString("{}"))
                    .build();
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient()
                    .send(req, java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
