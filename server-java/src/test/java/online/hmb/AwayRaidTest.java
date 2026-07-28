package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
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
 * #245 원정(피침공) 리포트·레이팅 — 계약.
 *
 * <p>hero 확정(2026-07-28): 별도 '원정' 모드 · 신규 rating 축 초기 0(하한 없음) ·
 * 공격자/수비자 <b>둘 다 ±10</b> · 수비자도 경기 관전.
 *
 * <p>이 클래스가 지키는 핵심 불변:
 * <ol>
 *   <li><b>상대는 진짜 실유저 팀이다</b> — 봇으로 조용히 대체하지 않는다. 대상이 없으면 매치를
 *       만들지 않는다(NO_OPPONENT). 여기서 봇 폴백을 허용하면 "원정 갔는데 사실 봇"이 되고
 *       요구 1·3(피원정 리포트)이 영영 발생하지 않는다.</li>
 *   <li><b>정산은 멱등</b> — 리포트는 매치당 1행, 레이팅은 매치당 1회. 원장 유니크가 최종 방어선.</li>
 *   <li><b>수비자에게 열리는 것은 읽기뿐</b> — 관전은 되고 쓰기는 404. 권한의 근거는 리포트 행이며
 *       리포트는 FINISHED 에서만 생기므로 <b>진행 중 매치는 애초에 볼 수 없다</b>.</li>
 * </ol>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class AwayRaidTest extends MatchTestBase {

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

    /**
     * 상대 <b>지목</b>은 공개 API 에 없다(MAJ-4: 부계정 반복 지목 = 레이팅 무한 생성). 테스트는
     * 서비스 시임으로 상대를 고정한다 — 이 클래스는 DB 를 공유해서 무작위로는 다른 메서드가 만든
     * 유저가 뽑힌다. 무작위 경로 자체는 randomOpponentIsSomeOtherRealUser 가 HTTP 로 검증한다.
     */
    @Resource
    private online.hmb.away.AwayService awayService;

    // ── AC1: 원정 상대 = 실유저 덱 고스트 ────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void awayMatchOpponentIsAnotherUsersDeck() {
        setupUserWithDeck("aw_def1");
        String defenderId = userIdOf("aw_def1");
        String attacker = setupUserWithDeck("aw_atk1");

        String matchId = awayService.start(userIdOf("aw_atk1"), defenderId).id();

        ResponseEntity<Map> res = authGet("/api/matches/" + matchId, attacker, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody().get("mode")).isEqualTo("away");
        // 상대 이름 = 수비자 닉네임(봇 이름이 아니다) — 공격자 화면이 "누구를 치러 가는지" 말해야 한다.
        assertThat(((Map<String, Object>) res.getBody().get("opponent")).get("name")).isEqualTo("aw_def1");

        // 도전장이 수비자 귀속을 소유한다(matches.user_id 는 공격자다).
        String recorded = jdbcClient.sql("SELECT defender_id FROM away_challenges WHERE match_id = ?")
                .param(matchId).query(String.class).single();
        assertThat(recorded).isEqualTo(defenderId);

        // 고스트 봇의 덱 = 수비자의 실제 덱. 선수별 지시(promptText)까지 그대로 넘어가야
        // 상대 AI 인풋이 "수비자가 써둔 지시"로 만들어진다(buildBotContext 가 그걸 읽는다).
        String ghostDeck = jdbcClient.sql("SELECT b.deck_json FROM bots b "
                        + "JOIN matches m ON m.bot_id = b.id WHERE m.id = ?")
                .param(matchId).query(String.class).single();
        assertThat(ghostDeck).contains("P001").contains("\"formation\":\"4-4-2\"");
    }

    /**
     * 고스트는 <b>내용 해시로 박제</b>된다 — 수비자가 덱을 바꾼 뒤 <b>다른 공격자가 같은 수비자에게
     * 원정을 와도</b>(= 재-bake 가 실제로 도는 경로) 진행 중인 매치의 상대는 변하지 않는다.
     *
     * <p>⚠️ 이전 버전의 이 테스트는 `PUT /api/deck` 만 호출했는데, bakeGhost 는 원정 생성에서만
     * 돌므로 "덱 저장이 bots 를 안 건드린다"는 <b>어차피 참인 명제</b>를 검증하고 있었다(독립검증 BL-2:
     * 박제를 통째로 제거해도 통과했다). 회귀를 잡으려면 재-bake 를 실제로 태워야 한다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void ghostIsFrozenByContentSoInFlightMatchKeepsItsOpponent() {
        setupUserWithDeck("aw_def_frozen");
        String defenderId = userIdOf("aw_def_frozen");
        setupUserWithDeck("aw_atk_frozen");
        setupUserWithDeck("aw_atk_frozen2");

        String matchId = awayService.start(userIdOf("aw_atk_frozen"), defenderId).id();
        String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        String deckBefore = jdbcClient.sql("SELECT deck_json FROM bots WHERE id = ?")
                .param(botId).query(String.class).single();

        // 수비자가 덱을 바꾼다.
        String defenderToken = login("aw_def_frozen");
        java.util.List<Map<String, Object>> slots = new java.util.ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, "완전히 다른 지시"));
        authPut("/api/deck", defenderToken, deckBody("4-4-2", slots), Map.class);

        // 두 번째 공격자가 같은 수비자에게 원정 → 여기서 bakeGhost 가 다시 돈다.
        String secondMatch = awayService.start(userIdOf("aw_atk_frozen2"), defenderId).id();
        String secondBotId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(secondMatch).query(String.class).single();

        // 바뀐 덱은 **새 행**이 된다(같은 행을 덮지 않는다).
        assertThat(secondBotId).isNotEqualTo(botId);
        assertThat(jdbcClient.sql("SELECT deck_json FROM bots WHERE id = ?")
                .param(secondBotId).query(String.class).single()).contains("완전히 다른 지시");

        // 그리고 진행 중이던 첫 매치의 상대는 그대로다 — 시뮬은 하프마다 봇 덱을 다시 읽으므로,
        // 덮어썼다면 전·후반 사이에 상대가 바뀌어 재현이 깨진다.
        assertThat(jdbcClient.sql("SELECT deck_json FROM bots WHERE id = ?")
                .param(botId).query(String.class).single()).isEqualTo(deckBefore);
    }

    /**
     * 고스트는 수비자의 <b>성장·강화 유효스탯</b>으로 선다(MAJ-3). 원본 카탈로그 스탯으로 세우면
     * "상대는 실유저 팀"이라면서 그 유저가 키운 것이 빠진 약화판이 서고, 그 결과로 수비자가 −10 을
     * 먹는다. 그리고 그 값은 덱에 <b>얼려</b> 들어가야 한다 — 시뮬 때 조회하면 수비자가 전·후반
     * 사이 강화로 후반 스탯만 올릴 수 있다(#217 이 잠금으로 막는 그 버그).
     */
    @Test
    void ghostCarriesDefenderGrowthAndFreezesIt() {
        setupUserWithDeck("aw_def_growth");
        String defenderId = userIdOf("aw_def_growth");
        setupUserWithDeck("aw_atk_growth");

        String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(awayService.start(userIdOf("aw_atk_growth"), defenderId).id())
                .query(String.class).single();
        String deckJson = jdbcClient.sql("SELECT deck_json FROM bots WHERE id = ?")
                .param(botId).query(String.class).single();

        // 스탯이 덱에 실려 있다(= 시뮬이 조회하지 않고 이 값을 쓴다).
        assertThat(deckJson).contains("\"attributes\"");
        // 시드 봇에는 없다 — 원정 고스트에만 붙는 필드다(무회귀).
        assertThat(jdbcClient.sql("SELECT deck_json FROM bots WHERE id = 'BOT_BAL'")
                .query(String.class).single()).doesNotContain("\"attributes\"");
    }

    /** 공개 API 는 무작위만 연다 — 상대는 **다른 실유저**다(봇도, 자기 자신도 아니다). */
    @SuppressWarnings("unchecked")
    @Test
    void randomOpponentIsSomeOtherRealUser() {
        setupUserWithDeck("aw_pool1");
        setupUserWithDeck("aw_pool2");
        String attacker = setupUserWithDeck("aw_atk_rand");
        String attackerId = userIdOf("aw_atk_rand");

        ResponseEntity<Map> res = authPost("/api/away/matches", attacker, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) res.getBody().get("id");

        String defenderId = jdbcClient.sql("SELECT defender_id FROM away_challenges WHERE match_id = ?")
                .param(matchId).query(String.class).single();
        assertThat(defenderId).isNotEqualTo(attackerId);
        // 실유저다 — 고스트 봇은 그 유저의 덱에서 구워진 행이어야 한다.
        long isRealUser = jdbcClient.sql("SELECT COUNT(*) FROM users WHERE id = ?")
                .param(defenderId).query(Long.class).single();
        assertThat(isRealUser).isEqualTo(1);
        String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(botId).startsWith("GHOST_" + defenderId);
    }

    // ── AC2: 대상이 없으면 봇으로 대체하지 않는다 ─────────────────────────────

    @Test
    void noOpponentWhenNobodyElseHasADeck() {
        // 이 유저 말고는 활성 덱을 가진 상대가 없도록 다른 덱을 잠시 비활성화한다.
        String lonely = setupUserWithDeck("aw_lonely");
        String lonelyId = userIdOf("aw_lonely");
        jdbcClient.sql("UPDATE decks SET is_active = 0 WHERE user_id <> ?").param(lonelyId).update();
        try {
            ResponseEntity<String> res = authPost("/api/away/matches", lonely, Map.of(), String.class);
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(res.getBody()).contains("NO_OPPONENT");
        } finally {
            jdbcClient.sql("UPDATE decks SET is_active = 1 WHERE user_id <> ?").param(lonelyId).update();
        }
    }

    // ── AC3/AC4: 정산 — 리포트 + 양쪽 레이팅 ±10, 멱등 ────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void finishedAwayMatchWritesReportAndRatesBothSidesOnce() {
        setupUserWithDeck("aw_def2");
        String defenderId = userIdOf("aw_def2");
        String attacker = setupUserWithDeck("aw_atk2");
        String attackerId = userIdOf("aw_atk2");

        String matchId = driveAwayToFinishedAgainst(attacker, attackerId, defenderId);

        // 매치 관점(공격자) 결과.
        String attackerResult = jdbcClient.sql("SELECT result FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        int scoreHome = jdbcClient.sql("SELECT score_home FROM matches WHERE id = ?")
                .param(matchId).query(Integer.class).single();
        int scoreAway = jdbcClient.sql("SELECT score_away FROM matches WHERE id = ?")
                .param(matchId).query(Integer.class).single();

        // 리포트 = 수비자 관점(스코어 반전).
        Map<String, Object> report = jdbcClient.sql("""
                        SELECT defender_id, attacker_id, attacker_name, goals_for, goals_against,
                               result, rating_delta, seen_at
                        FROM away_reports WHERE match_id = ?
                        """)
                .param(matchId)
                .query((rs, n) -> {
                    Map<String, Object> m = new java.util.LinkedHashMap<>();
                    m.put("defenderId", rs.getString("defender_id"));
                    m.put("attackerId", rs.getString("attacker_id"));
                    m.put("attackerName", rs.getString("attacker_name"));
                    m.put("goalsFor", rs.getInt("goals_for"));
                    m.put("goalsAgainst", rs.getInt("goals_against"));
                    m.put("result", rs.getString("result"));
                    m.put("ratingDelta", rs.getInt("rating_delta"));
                    m.put("seenAt", rs.getString("seen_at"));
                    return m;
                })
                .single();

        assertThat(report.get("defenderId")).isEqualTo(defenderId);
        assertThat(report.get("attackerId")).isEqualTo(attackerId);
        assertThat(report.get("attackerName")).isEqualTo("aw_atk2");
        assertThat(report.get("goalsFor")).isEqualTo(scoreAway);      // 수비자 = away 사이드
        assertThat(report.get("goalsAgainst")).isEqualTo(scoreHome);
        assertThat(report.get("seenAt")).isNull();                     // 아직 미확인 = 팝업 대상
        assertThat(report.get("result")).isEqualTo(mirror(attackerResult));

        // 레이팅: 승 +10 / 패 −10 / 무 0 — 양쪽 대칭.
        int expectedAttacker = expectedDelta(attackerResult);
        assertThat(rating(attackerId)).isEqualTo(expectedAttacker);
        assertThat(rating(defenderId)).isEqualTo(-expectedAttacker);
        assertThat(report.get("ratingDelta")).isEqualTo(-expectedAttacker);

        // 멱등: **정산을 실제로 재호출**한다. 이전 버전은 clockSweeper.sweep() 을 불렀지만
        // advanceAllDue 는 FINISHED(phase_ends_at=NULL)를 고르지 않아 settle 이 두 번째로 불리는
        // 일 자체가 없었다 = 단언이 no-op(독립검증 BL-2: 멱등을 제거해도 전 스위트가 통과했다).
        // 재정산·경합에서 두 번 반영되지 않는 것이 계약이므로 그 경로를 직접 태운다.
        awayService.settle(matchId, attackerId, attackerResult, scoreHome, scoreAway);
        awayService.settle(matchId, attackerId, "WIN", 9, 0);   // 다른 스코어로도 덮이지 않는다
        assertThat(countReports(matchId)).isEqualTo(1);
        assertThat(countLedger(matchId)).isEqualTo(attackerResult.equals("DRAW") ? 0 : 2);
        assertThat(rating(attackerId)).isEqualTo(expectedAttacker);
        assertThat(rating(defenderId)).isEqualTo(-expectedAttacker);
    }

    // ── AC5: 로비 팝업 조회 + ack 멱등 ────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void unseenReportsExposeSummaryAndAckIsIdempotent() {
        String defenderToken = setupUserWithDeck("aw_def3");
        String defenderId = userIdOf("aw_def3");
        String attacker = setupUserWithDeck("aw_atk3");

        String attackerId = userIdOf("aw_atk3");
        driveAwayToFinishedAgainst(attacker, attackerId, defenderId);
        releaseActiveMatches();
        driveAwayToFinishedAgainst(attacker, attackerId, defenderId);

        ResponseEntity<Map> res = authGet("/api/me/away-reports", defenderToken, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> reports = (List<Map<String, Object>>) res.getBody().get("reports");
        // 이 수비자에게 온 리포트만(다른 유저 것이 섞이지 않는다).
        assertThat(reports).isNotEmpty();

        Map<String, Object> summary = (Map<String, Object>) res.getBody().get("summary");
        int matches = (Integer) summary.get("matches");
        assertThat(matches).isEqualTo(reports.size());
        // 요구 3: "몇 팀과 · 몇 승 몇 패 · 득실" — 서버가 계산해서 준다(클라 복제 금지).
        assertThat((Integer) summary.get("wins") + (Integer) summary.get("draws")
                + (Integer) summary.get("losses")).isEqualTo(matches);
        // ⚠️ isNotNull() 은 int 에 대해 아무것도 막지 않는다(독립검증 MAJ-2: 집계 4필드를 전부 0 으로
        // 만들어도 전 스위트가 통과했다). 리포트에서 직접 계산한 값과 대조한다.
        assertThat(summary.get("opponents")).isEqualTo(
                (int) reports.stream().map(r -> r.get("attackerName")).distinct().count());
        assertThat(summary.get("goalsFor")).isEqualTo(
                reports.stream().mapToInt(r -> (Integer) r.get("goalsFor")).sum());
        assertThat(summary.get("goalsAgainst")).isEqualTo(
                reports.stream().mapToInt(r -> (Integer) r.get("goalsAgainst")).sum());
        assertThat(summary.get("ratingDelta")).isEqualTo(
                reports.stream().mapToInt(r -> (Integer) r.get("ratingDelta")).sum());
        assertThat(res.getBody().get("rating")).isEqualTo(rating(defenderId));

        // ack → 미확인 0.
        ResponseEntity<Map> ack = authPost("/api/me/away-reports/ack", defenderToken, Map.of(), Map.class);
        assertThat(ack.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ack.getBody().get("acked")).isEqualTo(matches);
        assertThat(unseenCount(defenderId)).isZero();

        // 재확인(두 번째 탭)은 실패가 아니라 0건 처리다.
        ResponseEntity<Map> again = authPost("/api/me/away-reports/ack", defenderToken, Map.of(), Map.class);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(again.getBody().get("acked")).isEqualTo(0);

        // 확인 뒤에는 팝업 대상이 아니지만 기록은 남는다(status=all).
        ResponseEntity<Map> all = authGet("/api/me/away-reports?status=all", defenderToken, Map.class);
        assertThat((List<?>) all.getBody().get("reports")).hasSize(matches);
        ResponseEntity<Map> unseen = authGet("/api/me/away-reports", defenderToken, Map.class);
        assertThat((List<?>) unseen.getBody().get("reports")).isEmpty();
    }

    // ── AC6/AC7: 수비자는 관전 가능, 쓰기는 불가. 제3자는 아무것도 못 본다 ──────

    @SuppressWarnings("unchecked")
    @Test
    void defenderCanWatchButNeverWriteAndStrangersSeeNothing() {
        String defenderToken = setupUserWithDeck("aw_def4");
        String attacker = setupUserWithDeck("aw_atk4");
        String stranger = setupUserWithDeck("aw_stranger");

        String matchId = driveAwayToFinishedAgainst(attacker, userIdOf("aw_atk4"), userIdOf("aw_def4"));

        // 읽기 — 허용(요구: 요약도 보고 경기도 본다).
        ResponseEntity<Map> detail = authGet("/api/matches/" + matchId, defenderToken, Map.class);
        assertThat(detail.getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<String> log = authGet("/api/matches/" + matchId + "/halves/1/log",
                defenderToken, String.class);
        assertThat(log.getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<Map> result = authGet("/api/matches/" + matchId + "/result",
                defenderToken, Map.class);
        assertThat(result.getStatusCode()).isEqualTo(HttpStatus.OK);

        // 쓰기 — 전부 차단. 관전 권한이 조작 권한으로 새면 안 된다.
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", defenderToken, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authPost("/api/matches/" + matchId + "/abandon", defenderToken, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authPost("/api/matches/" + matchId + "/retry", defenderToken, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // 무관한 유저 — 읽기조차 404(소유권 비노출).
        assertThat(authGet("/api/matches/" + matchId, stranger, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authGet("/api/matches/" + matchId + "/halves/1/log", stranger, String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * 관전은 <b>무엇을 읽는지</b>까지 좁힌다(독립검증 BL-1). 수비자에게 GET 을 연 순간 그 응답의
     * {@code userDeckSnapshot} 이 <b>공격자의 선수별 지시·팀 전술</b>을 통째로 넘겨주고 있었다 —
     * 반대 방향은 {@code opponent.deck} 이 hasPrompt 불리언뿐이라 <b>수비자만</b> 상대의 전술을 읽는
     * 일방적 스카우팅이 된다. 프롬프트가 이 게임의 차별점인 이상(루트 §1) 레이팅이 걸린 대전에서
     * 이건 정보 유출이다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void watchingDoesNotLeakTheAttackersPrompts() {
        setupUserWithDeck("aw_def5");
        String defenderToken = login("aw_def5");
        String attacker = setupUserWithDeck("aw_atk5");
        String attackerId = userIdOf("aw_atk5");

        // 공격자가 선수에게 비밀 지시를 적는다.
        java.util.List<Map<String, Object>> slots = new java.util.ArrayList<>();
        slots.add(slot("P001", "starter", 0, "TOP-SECRET-ATTACKER-PROMPT"));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1));
        authPut("/api/deck", attacker, deckBody("4-4-2", slots), Map.class);

        String matchId = driveAwayToFinishedAgainst(attacker, attackerId, userIdOf("aw_def5"));

        // 수비자: 경기는 본다(허용) — 그러나 상대의 지시는 못 본다.
        ResponseEntity<String> asDefender = authGet("/api/matches/" + matchId, defenderToken, String.class);
        assertThat(asDefender.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(asDefender.getBody()).doesNotContain("TOP-SECRET-ATTACKER-PROMPT");
        assertThat(asDefender.getBody()).doesNotContain("userDeckSnapshot\":{");

        // 소유자 본인에게는 그대로 보인다(기존 기능 #98 무회귀).
        ResponseEntity<String> asOwner = authGet("/api/matches/" + matchId, attacker, String.class);
        assertThat(asOwner.getBody()).contains("TOP-SECRET-ATTACKER-PROMPT");
    }

    // ── AC8: 레이팅은 GET /api/me 로 노출되고 하한이 없다 ──────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void ratingIsExposedOnMeAndHasNoFloor() {
        String token = setupUserWithDeck("aw_rating");
        String userId = userIdOf("aw_rating");

        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        assertThat(me.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(me.getBody().get("rating")).isEqualTo(0);   // 초기 0 (hero Q2)

        // 방어에 계속 실패하면 0 아래로 내려간다 — wallets.points 와 달리 CHECK(>=0) 이 없다.
        // 행은 첫 정산 때 생긴다(RatingService.apply 가 upsert) — 프로덕션과 같은 문장으로 심는다.
        jdbcClient.sql("""
                        INSERT INTO user_ratings(user_id, rating, updated_at) VALUES (?, -30, ?)
                        ON CONFLICT(user_id) DO UPDATE SET rating = -30
                        """)
                .params(userId, java.time.Instant.now().toString()).update();
        ResponseEntity<Map> after = authGet("/api/me", token, Map.class);
        assertThat(after.getBody().get("rating")).isEqualTo(-30);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────────

    /**
     * 원정 매치를 FINISHED 까지 민다(GrowthSettlementFlowTest.driveToFinished 와 같은 패턴 —
     * 킥오프 → 가짜 서번트 → 시계 강제만료 → 스위퍼).
     */
    private String driveAwayToFinishedAgainst(String attackerToken, String attackerId, String defenderId) {
        String matchId = awayService.start(attackerId, defenderId).id();

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

    private static String mirror(String result) {
        return switch (result) {
            case "WIN" -> "LOSS";
            case "LOSS" -> "WIN";
            default -> "DRAW";
        };
    }

    private static int expectedDelta(String result) {
        return switch (result) {
            case "WIN" -> 10;
            case "LOSS" -> -10;
            default -> 0;
        };
    }

    private int rating(String userId) {
        return jdbcClient.sql("SELECT rating FROM user_ratings WHERE user_id = ?")
                .param(userId).query(Integer.class).single();
    }

    private long countReports(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE match_id = ?")
                .param(matchId).query(Long.class).single();
    }

    private long countLedger(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM rating_ledger WHERE ref_id = ?")
                .param(matchId).query(Long.class).single();
    }

    private long unseenCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE defender_id = ? AND seen_at IS NULL")
                .param(userId).query(Long.class).single();
    }
}
