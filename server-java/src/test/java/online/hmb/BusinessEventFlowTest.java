package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.core.type.TypeReference;
import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
 * <b>#492 AC2</b> — 실 HTTP 로 가입 → 튜토리얼 → 덱 → 뽑기 → 연습매치 시작·종료 → 리그 시즌 →
 * 원정 을 태우면 <b>7종이 기대 props 와 함께 정확한 건수</b>로 기록된다.
 *
 * <p>가장 중요한 단정은 총량이 아니라 <b>세어지면 안 되는 것이 0 이라는 쪽</b>이다:
 * <ul>
 *   <li>리그 시즌 <b>재진입</b>(이미 ACTIVE 인 시즌으로 돌아옴) → {@code league_season_start} 0건</li>
 *   <li>리그 픽스처 <b>재사용</b>(진행 중 매치로 재입장) → {@code match_start} 0건</li>
 *   <li>튜토리얼 완료가 <b>내부적으로</b> 부르는 덱 지급 → {@code deck_save} 0건
 *       (= 훅이 서비스가 아니라 컨트롤러에 있다는 관측 가능한 증거. 훅을 {@code DeckService} 로
 *       옮기면 이 0 이 깨지고, 동시에 그 훅은 트랜잭션 안이 된다)</li>
 * </ul>
 *
 * <p>매치 <b>종료</b>는 시뮬을 돌리지 않고 SECOND_HALF 상태를 만들어 정산 진입점을 직접 부른다
 * (MatchClockFlowTest 와 같은 규율 — 타이밍 비의존). 검증 대상은 시뮬이 아니라 <b>정산 커밋 후에
 * 이벤트가 나가는가</b>이므로 그 경계를 그대로 지난다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class BusinessEventFlowTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        // 배경 스위퍼가 강제로 만든 상태를 앞질러 가지 않게 사실상 끈다(판정이 흔들린다).
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.abandon.sweep-interval-ms", () -> "3600000");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private online.hmb.match.MatchOrchestrator orchestrator;

    // ── AC2: 7종 전부 · 기대 props · 정확한 건수 ─────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void everyBusinessEventIsRecordedWithItsPropsAcrossTheRealHttpFlow() {
        // ① 가입 (guest provider = 목업 OAuth 경로)
        String token = login("evt_flow");
        String userId = userIdOf("evt_flow");
        assertThat(countOf(userId, "user_signup")).isEqualTo(1);
        Map<String, Object> signup = propsOf(userId, "user_signup");
        assertThat(signup.get("provider")).isEqualTo("guest");
        assertThat(signup.get("nickname")).isEqualTo("evt_flow");

        // ② 튜토리얼 완료(= 덱 지급)
        ResponseEntity<Map> tutorial = authPost("/api/me/tutorial-complete", token, null, Map.class);
        assertThat(tutorial.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(countOf(userId, "tutorial_complete")).isEqualTo(1);
        assertThat(propsOf(userId, "tutorial_complete").get("grantedDeck")).isEqualTo(true);

        // ⚠️ 그 지급은 DeckService.replaceDeck 을 **트랜잭션 안에서** 부른다. 훅이 서비스에 있었다면
        //    여기서 deck_save 가 1건 생기고(그리고 그 기록은 tx 안이다). 0 이어야 한다.
        assertThat(countOf(userId, "deck_save"))
                .as("덱 저장 훅은 컨트롤러에 있다 — 튜토리얼 내부 지급은 이벤트가 아니다")
                .isZero();

        // ③ 덱 저장 (PUT /api/deck)
        String deckToken = setupUserWithDeck("evt_flow");   // 같은 계정으로 PUT /api/deck
        assertThat(deckToken).isNotBlank();
        assertThat(countOf(userId, "deck_save")).isEqualTo(1);
        Map<String, Object> deckSave = propsOf(userId, "deck_save");
        assertThat(deckSave.get("source")).isEqualTo("deck");
        assertThat(deckSave.get("formation")).isEqualTo("4-4-2");
        assertThat(((Number) deckSave.get("slotCount")).intValue()).isEqualTo(13);
        assertThat(deckSave.get("created")).as("튜토리얼이 이미 덱을 만들었다").isEqualTo(false);

        // ④ 뽑기 (POST /api/shop/gacha)
        ResponseEntity<Map> gacha =
                authPost("/api/shop/gacha", token, Map.of("kind", "single"), Map.class);
        assertThat(gacha.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(countOf(userId, "gacha_pull")).isEqualTo(1);
        Map<String, Object> pull = propsOf(userId, "gacha_pull");
        assertThat(pull.get("kind")).isEqualTo("single");
        assertThat(((Number) pull.get("count")).intValue()).isEqualTo(1);
        assertThat(((Number) pull.get("cost")).intValue()).isEqualTo(300);   // 픽스처 economy
        assertThat(pull.get("currency")).isEqualTo("GEM");
        assertThat((List<String>) pull.get("grades")).hasSize(1);

        // ⑤ 연습 매치 시작
        String practiceId = createMatch(token, null);
        assertThat(countOf(userId, "match_start")).isEqualTo(1);
        Map<String, Object> start = propsOf(userId, "match_start");
        assertThat(start.get("mode")).isEqualTo("practice");
        assertThat(start.get("matchId")).isEqualTo(practiceId);
        assertThat((String) start.get("botId")).isNotBlank();

        // ⑥ 연습 매치 종료 — 정산 커밋 **후** 훅
        settleAsWin(practiceId, 2, 0, 1, 0);
        assertThat(countOf(userId, "match_finish")).isEqualTo(1);
        Map<String, Object> finish = propsOf(userId, "match_finish");
        assertThat(finish.get("mode")).isEqualTo("practice");
        assertThat(finish.get("matchId")).isEqualTo(practiceId);
        assertThat(finish.get("result")).isEqualTo("WIN");
        assertThat(((Number) finish.get("goalsFor")).intValue()).isEqualTo(3);
        assertThat(((Number) finish.get("goalsAgainst")).intValue()).isZero();
        assertThat(((Number) finish.get("pointsAwarded")).longValue()).isEqualTo(500); // 픽스처 practice.win

        // ⑦ 리그 시즌 시작 + **재진입은 0건**
        ResponseEntity<Map> season = authPost("/api/league/start", token, null, Map.class);
        assertThat(season.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(countOf(userId, "league_season_start")).isEqualTo(1);
        Map<String, Object> seasonProps = propsOf(userId, "league_season_start");
        assertThat((String) seasonProps.get("seasonId")).isNotBlank();
        assertThat(((Number) seasonProps.get("seasonNo")).intValue()).isEqualTo(1);
        assertThat(seasonProps.get("division")).isNotNull();

        authPost("/api/league/start", token, null, Map.class);
        authPost("/api/league/start", token, null, Map.class);
        assertThat(countOf(userId, "league_season_start"))
                .as("재진입 분기(이미 ACTIVE 인 시즌 반환)는 시즌 시작이 아니다")
                .isEqualTo(1);

        // ⑧ 리그 매치 시작 + **픽스처 재사용은 0건**
        ResponseEntity<Map> next = authPost("/api/league/next-match", token, null, Map.class);
        assertThat(next.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String leagueMatchId = (String) ((Map<String, Object>) next.getBody().get("match")).get("id");
        assertThat(countOf(userId, "match_start")).isEqualTo(2);
        Map<String, Object> leagueStart = lastPropsOf(userId, "match_start");
        assertThat(leagueStart.get("mode")).isEqualTo("league");
        assertThat(leagueStart.get("matchId")).isEqualTo(leagueMatchId);
        assertThat((String) leagueStart.get("leagueFixtureId")).isNotBlank();
        assertThat(((Number) leagueStart.get("round")).intValue()).isPositive();
        assertThat((String) leagueStart.get("botId")).isNotBlank().isNotEqualTo("USER");

        authPost("/api/league/next-match", token, null, Map.class);
        assertThat(countOf(userId, "match_start"))
                .as("픽스처 재사용(진행 중 매치로 재입장)은 매치 시작이 아니다")
                .isEqualTo(2);

        // ⑨ 원정 매치 시작
        releaseActiveMatches();
        setupOpponentWithDeck("evt_defender");
        String defenderId = userIdOf("evt_defender");
        offerCandidate(userId, defenderId);
        ResponseEntity<Map> away =
                authPost("/api/away/matches", token, Map.of("defenderId", defenderId), Map.class);
        assertThat(away.getStatusCode()).as(String.valueOf(away.getBody())).isEqualTo(HttpStatus.CREATED);
        assertThat(countOf(userId, "match_start")).isEqualTo(3);
        Map<String, Object> awayStart = lastPropsOf(userId, "match_start");
        assertThat(awayStart.get("mode")).isEqualTo("away");
        assertThat(awayStart.get("matchId")).isEqualTo(away.getBody().get("id"));
        assertThat(awayStart.get("defenderId")).isEqualTo(defenderId);
        assertThat(awayStart.get("revenge")).isEqualTo(false);

        // ── 7종이 전부 실제로 관측됐다(하나라도 빠지면 이 웨이브가 헛돈 것이다) ──
        assertThat(distinctEventsOf(userId)).containsExactlyInAnyOrder(
                "user_signup", "tutorial_complete", "deck_save", "gacha_pull",
                "match_start", "match_finish", "league_season_start");
    }

    // ── created 플래그와 프리셋 경로(같은 이벤트, source 로 갈린다) ────────

    @SuppressWarnings("unchecked")
    @Test
    void deckSaveDistinguishesFirstCreationAndPresetApply() {
        // 튜토리얼을 지나지 않고 곧바로 덱을 저장한 유저 = 이번에 처음 만든 것이다.
        setupUserWithDeck("evt_deck_new");
        String userId = userIdOf("evt_deck_new");
        assertThat(propsOf(userId, "deck_save").get("created")).isEqualTo(true);

        String token = login("evt_deck_new");
        ResponseEntity<Map> saved = authPut("/api/deck", token,
                deckBody("4-4-2", starterSlots()), Map.class);
        assertThat(saved.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(lastPropsOf(userId, "deck_save").get("created"))
                .as("두 번째 저장은 교체다").isEqualTo(false);

        // 프리셋 저장 → 적용. 적용은 **같은 이벤트**(deck_save)이고 source 만 다르다.
        Map<String, Object> snapshot = (Map<String, Object>) authGet("/api/deck", token, Map.class).getBody();
        Map<String, Object> presetBody = new HashMap<>();
        presetBody.put("name", "p1");
        presetBody.put("formation", snapshot.get("formation"));
        presetBody.put("starters", ((List<Map<String, Object>>) snapshot.get("slots")).stream()
                .filter(s -> "starter".equals(s.get("role"))).toList());
        presetBody.put("bench", ((List<Map<String, Object>>) snapshot.get("slots")).stream()
                .filter(s -> "bench".equals(s.get("role"))).toList());
        assertThat(authPut("/api/presets/team/1", token, presetBody, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        ResponseEntity<Map> applied =
                authPost("/api/presets/team/1/apply", token, null, Map.class);
        assertThat(applied.getStatusCode()).as(String.valueOf(applied.getBody())).isEqualTo(HttpStatus.OK);
        Map<String, Object> presetSave = lastPropsOf(userId, "deck_save");
        assertThat(presetSave.get("source")).isEqualTo("preset");
        assertThat(presetSave.get("created")).isEqualTo(false);
        assertThat(countOf(userId, "deck_save")).isEqualTo(3);
    }

    // ── 가입 이벤트는 **계정이 생긴 순간**에만 (재로그인은 가입이 아니다) ──

    @Test
    void signupIsRecordedOncePerAccountNotPerLogin() {
        login("evt_relogin");
        String userId = userIdOf("evt_relogin");
        login("evt_relogin");
        login("evt_relogin");
        assertThat(countOf(userId, "user_signup")).isEqualTo(1);

        // local provider(회원가입 엔드포인트)도 같은 이벤트를 남긴다 — provider 로 갈린다.
        Map<String, Object> body = new HashMap<>();
        body.put("nickname", "evt_local");
        body.put("password", "evt-local-pw-1234");
        assertThat(postJson("/api/auth/register", body).status()).isEqualTo(HttpStatus.OK);
        String localId = userIdOf("evt_local");
        assertThat(countOf(localId, "user_signup")).isEqualTo(1);
        assertThat(propsOf(localId, "user_signup").get("provider")).isEqualTo("local");
    }

    // ── AC3-③ 성능: 매치 시작·종료 경로에 붙은 지연 델타(실측) ────────────

    /**
     * 이 웨이브가 매치 경로에 <b>추가한 일</b>은 트랜잭션 밖 단일 INSERT 한 행뿐이다(시작 1 · 종료 1).
     * 그래서 델타는 그 INSERT 의 비용이고, 그것을 직접 잰다 — 켬/끔 두 컨텍스트를 띄워 비교하면
     * JVM 웜업·DB 파일 차이가 신호보다 커서 오히려 덜 정직해진다.
     *
     * <p>단정은 느슨하게(절대 임계 기반 타이밍 단정은 CI 에서 플래키하다) 두고 <b>수치를 로그로</b>
     * 남긴다 — AC3-③ 의 증빙은 판정이 아니라 실측치다.
     */
    @Test
    void measuresTheLatencyTheHooksAddToMatchStartAndFinish() {
        String token = setupUserWithDeck("evt_perf");
        String userId = userIdOf("evt_perf");

        // 웜업(첫 요청은 라우팅·프리페어드 스테이트먼트 초기화가 섞인다)
        for (int i = 0; i < 3; i++) {
            releaseActiveMatches();
            createMatch(token, null);
        }

        int matchIterations = 12;
        List<String> matchIds = new java.util.ArrayList<>();
        long startNanos = 0;
        for (int i = 0; i < matchIterations; i++) {
            releaseActiveMatches();
            long t0 = System.nanoTime();
            matchIds.add(createMatch(token, null));
            startNanos += System.nanoTime() - t0;
        }

        long finishNanos = 0;
        for (String matchId : matchIds) {
            forceSecondHalf(matchId, 1, 0, 0, 0);
            long t0 = System.nanoTime();
            assertThat(orchestrator.settleFinishedIfDue(matchId, null)).isTrue();
            finishNanos += System.nanoTime() - t0;
        }

        // 훅 자체(= 델타)의 비용: 실제 프로덕션 경로와 같은 INSERT 를 같은 커넥션 풀로 200회.
        online.hmb.events.BusinessEventRecorder recorder = recorder();
        for (int i = 0; i < 20; i++) {
            recorder.record("perf_warmup", userId, Map.of("i", i));
        }
        int hookIterations = 200;
        long hookT0 = System.nanoTime();
        for (int i = 0; i < hookIterations; i++) {
            recorder.record("perf_probe", userId, Map.of("i", i, "mode", "practice"));
        }
        long hookNanos = System.nanoTime() - hookT0;

        double startMs = startNanos / 1e6 / matchIterations;
        double finishMs = finishNanos / 1e6 / matchIterations;
        double hookMs = hookNanos / 1e6 / hookIterations;

        System.out.printf("[#492 AC3-3] match_start avg = %.3f ms/req · match_finish avg = %.3f ms/req "
                        + "· hook(insert) avg = %.3f ms/event → 델타 = 시작 %.2f%% · 종료 %.2f%%%n",
                startMs, finishMs, hookMs, 100 * hookMs / startMs, 100 * hookMs / finishMs);

        assertThat(recorder.enabled()).isTrue();
        assertThat(hookMs)
                .as("훅 1건이 밀리초 단위로 비싸면 그건 tx 밖 단일 INSERT 가 아니라는 뜻이다")
                .isLessThan(20.0);
        // 실제로 기록됐는지도 확인한다 — 0건이면 위 수치는 "아무 일도 안 한 비용"이다.
        assertThat(countOf(userId, "perf_probe")).isEqualTo(hookIterations);
        assertThat(countOf(userId, "match_start")).isEqualTo(matchIterations + 3);
        assertThat(countOf(userId, "match_finish")).isEqualTo(matchIterations);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private online.hmb.events.BusinessEventRecorder recorder() {
        return recorderBean;
    }

    @Resource
    private online.hmb.events.BusinessEventRecorder recorderBean;

    private static List<Map<String, Object>> starterSlots() {
        List<Map<String, Object>> slots = new java.util.ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, "벤치 프롬프트"));
        return slots;
    }

    /** 정산 진입점이 볼 수 있는 상태(SECOND_HALF + 하프 스코어)를 만든다. */
    private void forceSecondHalf(String matchId, int h1Home, int h1Away, int h2Home, int h2Away) {
        jdbcClient.sql("""
                        UPDATE matches SET state = 'SECOND_HALF', score_h1_home = ?, score_h1_away = ?,
                               score_h2_home = ?, score_h2_away = ?, phase_start_at = ?, phase_ends_at = NULL
                        WHERE id = ?
                        """)
                .params(h1Home, h1Away, h2Home, h2Away, Instant.now().toString(), matchId)
                .update();
    }

    private void settleAsWin(String matchId, int h1Home, int h1Away, int h2Home, int h2Away) {
        forceSecondHalf(matchId, h1Home, h1Away, h2Home, h2Away);
        assertThat(orchestrator.settleFinishedIfDue(matchId, null)).isTrue();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    /** 서버가 이 상대를 제시했다는 상태를 만든다(2택 계약: 제시 밖의 id 는 거부된다, AwayRaidTest 선례). */
    private void offerCandidate(String attackerId, String defenderId) {
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(attackerId, "[\"" + defenderId + "\"]", Instant.now().toString())
                .update();
    }

    private long countOf(String userId, String event) {
        return jdbcClient.sql("SELECT COUNT(*) FROM business_events WHERE user_id = ? AND event = ?")
                .params(userId, event).query(Long.class).single();
    }

    private List<String> distinctEventsOf(String userId) {
        return jdbcClient.sql("SELECT DISTINCT event FROM business_events WHERE user_id = ?")
                .param(userId).query(String.class).list();
    }

    private Map<String, Object> propsOf(String userId, String event) {
        return parse(jdbcClient.sql(
                        "SELECT props_json FROM business_events WHERE user_id = ? AND event = ? ORDER BY id ASC LIMIT 1")
                .params(userId, event).query(String.class).single());
    }

    private Map<String, Object> lastPropsOf(String userId, String event) {
        return parse(jdbcClient.sql(
                        "SELECT props_json FROM business_events WHERE user_id = ? AND event = ? ORDER BY id DESC LIMIT 1")
                .params(userId, event).query(String.class).single());
    }

    private static Map<String, Object> parse(String json) {
        try {
            return MAPPER.readValue(json, new TypeReference<>() {
            });
        } catch (Exception e) {
            throw new IllegalStateException("bad props json: " + json, e);
        }
    }
}
