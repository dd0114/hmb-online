package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import online.hmb.away.AwayService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #286 W4 (#319) — <b>원정 복수 큐의 자물쇠</b>.
 *
 * <p>⚠️ 이 파일이 지키는 것은 편의 기능이 아니다. V22 가 {@code away_offers} 주석에서 지목 원정을
 * <b>어뷰징 경로</b>로 명시하며 닫았고(클라가 상대를 고르면 부계정 반복 지목 = 레이팅 무한 생성,
 * 독립검증 4R MAJ-4), 복수는 그 문을 세 조건으로 좁혀 다시 여는 기능이다. 조건이 하나라도 빠지면
 * 닫아 둔 문이 다시 열린다 — 그래서 <b>규칙 하나당 표본 하나</b>로 태운다(축이 다른 규칙을 한
 * 픽스처에 겹치면 앞 분기가 뒤 분기를 덮어 계약이 공허하게 통과한다 — web W5 가 실제로 당했다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AwayRevengeTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private AwayService awayService;

    // ── 큐 조회 ────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void 큐는_나를_친_기록만_최신순으로_준다() {
        String me = setupUserWithDeck("rv_q_me");
        String meId = userIdOf("rv_q_me");
        setupOpponentWithDeck("rv_q_atk");
        String attackerId = userIdOf("rv_q_atk");
        setupOpponentWithDeck("rv_q_other");
        String otherId = userIdOf("rv_q_other");

        raid(attackerId, meId, "RV_Q1", "WIN");                 // 나를 쳤다(내가 졌다)
        raid(meId, otherId, "RV_Q2", "WIN");                    // 내가 남을 쳤다 — 큐 대상 아님

        ResponseEntity<Map> res = authGet("/api/away/revenge", me, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> entries = (List<Map<String, Object>>) res.getBody().get("entries");
        assertThat(entries).hasSize(1);
        Map<String, Object> e = entries.get(0);
        assertThat(((Map<String, Object>) e.get("opponent")).get("userId")).isEqualTo(attackerId);
        // 점수는 **수비자(나) 관점**으로 배치돼서 온다 — 클라가 뒤집으면 유저가 자기 경기를 오독한다.
        assertThat(e.get("theirScore")).isEqualTo(2);
        assertThat(e.get("myScore")).isEqualTo(0);
        assertThat(e.get("defenceResult")).isEqualTo("LOSS");
        assertThat(e.get("state")).isEqualTo("AVAILABLE");
        assertThat(e.get("attemptsUsed")).isEqualTo(0);
        assertThat(e.get("attemptsMax")).isEqualTo(2);
        // 일일 한도는 **일반 원정과 공유**다(hero Q3-②) — 복수만 따로 세면 무한 재도전이 열린다.
        assertThat((Integer) res.getBody().get("remainingToday")).isNotNull();
    }

    @SuppressWarnings("unchecked")
    @Test
    void 큐는_최근_다섯건만_산다() {
        String me = setupUserWithDeck("rv_w_me");
        String meId = userIdOf("rv_w_me");
        setupOpponentWithDeck("rv_w_atk");
        String attackerId = userIdOf("rv_w_atk");

        for (int i = 1; i <= 7; i++) {
            raid(attackerId, meId, "RV_W" + i, "WIN");
            backdate("RV_W" + i, "2026-07-0" + i + "T00:00:00Z");
        }

        List<Map<String, Object>> entries = queueOf(me);
        assertThat(entries).hasSize(5);
        // 밀려나는 것은 **가장 오래된 것**이다(슬라이딩) — 뒤에서 자르면 방금 맞은 침공이 사라진다.
        assertThat(entries.get(0).get("reportId")).isEqualTo(reportIdOf("RV_W7"));
        assertThat(entries).noneSatisfy(e ->
                assertThat(e.get("reportId")).isEqualTo(reportIdOf("RV_W1")));
    }

    // ── 자물쇠 ─────────────────────────────────────────────────────────────

    @Test
    void 남의_기록으로는_지목할_수_없다() {
        String me = setupUserWithDeck("rv_own_me");
        setupOpponentWithDeck("rv_own_a");
        String aId = userIdOf("rv_own_a");
        setupOpponentWithDeck("rv_own_b");
        String bId = userIdOf("rv_own_b");

        // a 가 b 를 쳤다 — 나와 무관한 기록이다.
        raid(aId, bId, "RV_OWN1", "WIN");

        ResponseEntity<Map> res = authPost(
                "/api/away/revenge/" + reportIdOf("RV_OWN1") + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(res.getBody().get("code")).isEqualTo("REVENGE_NOT_OWNED");
    }

    @Test
    void 없는_기록도_같은_403_이다_존재를_흘리지_않는다() {
        String me = setupUserWithDeck("rv_ghost_me");
        ResponseEntity<Map> res = authPost("/api/away/revenge/NOPE/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(res.getBody().get("code")).isEqualTo("REVENGE_NOT_OWNED");
    }

    @Test
    void 막아낸_침공은_복수할_수_없다() {
        // hero 확정 ④. 빼면 **이미 이긴 상대에게** 지목 원정이 2판 더 생긴다.
        String me = setupUserWithDeck("rv_def_me");
        String meId = userIdOf("rv_def_me");
        setupOpponentWithDeck("rv_def_atk");
        String attackerId = userIdOf("rv_def_atk");

        raid(attackerId, meId, "RV_DEF1", "LOSS");   // 공격자가 졌다 = 내가 막았다

        assertThat(queueOf(me)).singleElement()
                .satisfies(e -> assertThat(e.get("defenceResult")).isEqualTo("WIN"));

        ResponseEntity<Map> res = authPost(
                "/api/away/revenge/" + reportIdOf("RV_DEF1") + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("REVENGE_DEFENDED");
    }

    @Test
    void 창_밖으로_밀려난_기록은_지목할_수_없다() {
        // §4.1 조건 ③ — "최근 5건"이 표시 상한이면 오래 전 부계정 침공까지 되살릴 수 있다.
        String me = setupUserWithDeck("rv_exp_me");
        String meId = userIdOf("rv_exp_me");
        setupOpponentWithDeck("rv_exp_atk");
        String attackerId = userIdOf("rv_exp_atk");

        for (int i = 1; i <= 6; i++) {
            raid(attackerId, meId, "RV_EXP" + i, "WIN");
            backdate("RV_EXP" + i, "2026-07-0" + i + "T00:00:00Z");
        }
        String pushedOut = reportIdOf("RV_EXP1");

        ResponseEntity<Map> res =
                authPost("/api/away/revenge/" + pushedOut + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.GONE);
        assertThat(res.getBody().get("code")).isEqualTo("REVENGE_EXPIRED");
    }

    @Test
    void 진행_중인_매치가_있으면_복수도_거부된다() {
        // 새 매치를 만드는 모든 경로가 같은 잠금을 지난다(#217). 빠뜨리면 복수가 우회로가 된다.
        String me = setupUserWithDeck("rv_lock_me");
        String meId = userIdOf("rv_lock_me");
        setupOpponentWithDeck("rv_lock_atk");
        String attackerId = userIdOf("rv_lock_atk");
        raid(attackerId, meId, "RV_LOCK1", "WIN");

        createMatch(me, null);   // BRIEFING 상태의 연습 매치

        ResponseEntity<Map> res = authPost(
                "/api/away/revenge/" + reportIdOf("RV_LOCK1") + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");
    }

    @Test
    void 오늘_원정_횟수를_다_쓰면_복수도_막힌다() {
        // hero Q3-② — 복수 판도 오늘 횟수를 먹는다. 따로 세면 "복수로 무한 재도전"이 열린다.
        String me = setupUserWithDeck("rv_lim_me");
        String meId = userIdOf("rv_lim_me");
        setupOpponentWithDeck("rv_lim_atk");
        String attackerId = userIdOf("rv_lim_atk");
        raid(attackerId, meId, "RV_LIM1", "WIN");

        for (int i = 0; i < 10; i++) {   // application.yml daily-limit: 10
            seedAwayMatchToday(meId, "RV_LIM_USED" + i);
        }
        releaseActiveMatches();

        ResponseEntity<Map> res = authPost(
                "/api/away/revenge/" + reportIdOf("RV_LIM1") + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(res.getBody().get("code")).isEqualTo("AWAY_DAILY_LIMIT");
    }

    // ── 소모 규칙(정산 시점) ────────────────────────────────────────────────

    @Test
    void 복수에_지면_시도가_하나_줄고_두_번_지면_소진된다() {
        String me = setupUserWithDeck("rv_ex_me");
        String meId = userIdOf("rv_ex_me");
        setupOpponentWithDeck("rv_ex_atk");
        String attackerId = userIdOf("rv_ex_atk");
        raid(attackerId, meId, "RV_EX1", "WIN");
        String reportId = reportIdOf("RV_EX1");

        revengeSettled(me, meId, attackerId, reportId, "LOSS");
        assertThat(queueOf(me)).singleElement().satisfies(e -> {
            assertThat(e.get("attemptsUsed")).isEqualTo(1);
            assertThat(e.get("state")).isEqualTo("AVAILABLE");   // 아직 한 번 남았다
        });

        revengeSettled(me, meId, attackerId, reportId, "LOSS");
        assertThat(queueOf(me)).singleElement().satisfies(e -> {
            assertThat(e.get("attemptsUsed")).isEqualTo(2);
            assertThat(e.get("state")).isEqualTo("EXHAUSTED");
        });

        ResponseEntity<Map> res =
                authPost("/api/away/revenge/" + reportId + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(res.getBody().get("code")).isEqualTo("REVENGE_EXHAUSTED");
    }

    @Test
    void 복수에_이기면_기록이_닫히고_목록에서_사라진다() {
        String me = setupUserWithDeck("rv_av_me");
        String meId = userIdOf("rv_av_me");
        setupOpponentWithDeck("rv_av_atk");
        String attackerId = userIdOf("rv_av_atk");
        raid(attackerId, meId, "RV_AV1", "WIN");
        String reportId = reportIdOf("RV_AV1");

        revengeSettled(me, meId, attackerId, reportId, "WIN");

        assertThat(queueOf(me)).isEmpty();   // §4.2 — 갚으면 소멸한다
        ResponseEntity<Map> res =
                authPost("/api/away/revenge/" + reportId + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.GONE);
        assertThat(res.getBody().get("code")).isEqualTo("REVENGE_AVENGED");
    }

    @Test
    void 복수가_무승부면_횟수를_쓰지_않는다() {
        // hero 확정 Q3-①. 대가(비기는 한 무한 재도전)는 일일 한도가 묶는다 — 알고 채택한 규칙이다.
        String me = setupUserWithDeck("rv_dr_me");
        String meId = userIdOf("rv_dr_me");
        setupOpponentWithDeck("rv_dr_atk");
        String attackerId = userIdOf("rv_dr_atk");
        raid(attackerId, meId, "RV_DR1", "WIN");
        String reportId = reportIdOf("RV_DR1");

        revengeSettled(me, meId, attackerId, reportId, "DRAW");

        assertThat(queueOf(me)).singleElement().satisfies(e -> {
            assertThat(e.get("attemptsUsed")).isEqualTo(0);
            assertThat(e.get("state")).isEqualTo("AVAILABLE");
        });
    }

    @Test
    void 재정산해도_시도가_두_번_깎이지_않는다() {
        // 멱등 게이트 앞에 두면 재정산이 유저가 치지도 않은 판을 뺏는다(#245 가 연승에서 당한 형태).
        String me = setupUserWithDeck("rv_idem_me");
        String meId = userIdOf("rv_idem_me");
        setupOpponentWithDeck("rv_idem_atk");
        String attackerId = userIdOf("rv_idem_atk");
        raid(attackerId, meId, "RV_IDEM1", "WIN");
        String reportId = reportIdOf("RV_IDEM1");

        seedRevengeChallenge(meId, attackerId, "RV_IDEM_R1", reportId);
        awayService.settle("RV_IDEM_R1", meId, "LOSS", 0, 2);
        awayService.settle("RV_IDEM_R1", meId, "LOSS", 0, 2);   // 같은 매치 재정산

        assertThat(queueOf(me)).singleElement()
                .satisfies(e -> assertThat(e.get("attemptsUsed")).isEqualTo(1));
    }

    @Test
    void 복수의_복수는_없다() {
        // 내가 갚아서 이기면 **상대 쪽에** 리포트가 생긴다. 표식이 없으면 그게 그의 복수 큐에 들어가
        // 둘이 무한히 주고받는다 — hero 가 명시적으로 닫은 경로다.
        String me = setupUserWithDeck("rv_ch_me");
        String meId = userIdOf("rv_ch_me");
        String rival = setupOpponentWithDeck("rv_ch_riv");
        String rivalId = userIdOf("rv_ch_riv");
        raid(rivalId, meId, "RV_CH1", "WIN");
        String reportId = reportIdOf("RV_CH1");

        seedRevengeChallenge(meId, rivalId, "RV_CH_R1", reportId);
        awayService.settle("RV_CH_R1", meId, "WIN", 3, 1);   // 내가 갚았다 → rival 이 수비자인 리포트 생성

        String rivalReport = reportIdOf("RV_CH_R1");
        assertThat(rivalReport).isNotNull();
        // ① 그의 큐에 뜨지 않는다
        assertThat(queueOf(rival)).noneSatisfy(e ->
                assertThat(e.get("reportId")).isEqualTo(rivalReport));
        // ② 직접 POST 해도 거부된다(목록에서 감추는 것은 안내이지 방어가 아니다)
        ResponseEntity<Map> res =
                authPost("/api/away/revenge/" + rivalReport + "/matches", rival, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("REVENGE_CHAINED");
    }

    // ── 실제 생성 한 바퀴 ──────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void 복수_매치는_그_상대와_원정으로_만들어진다() {
        String me = setupUserWithDeck("rv_go_me");
        String meId = userIdOf("rv_go_me");
        setupOpponentWithDeck("rv_go_atk");
        String attackerId = userIdOf("rv_go_atk");
        raid(attackerId, meId, "RV_GO1", "WIN");
        String reportId = reportIdOf("RV_GO1");

        ResponseEntity<Map> res =
                authPost("/api/away/revenge/" + reportId + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) res.getBody().get("id");

        // 상대는 **내가 지목한 그 사람**이고(무작위가 아니다), 도전장이 리포트를 가리킨다.
        assertThat(jdbcClient.sql("SELECT defender_id FROM away_challenges WHERE match_id = ?")
                .param(matchId).query(String.class).single()).isEqualTo(attackerId);
        assertThat(jdbcClient.sql("SELECT revenge_report_id FROM away_challenges WHERE match_id = ?")
                .param(matchId).query(String.class).single()).isEqualTo(reportId);
        assertThat(jdbcClient.sql("SELECT mode FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single()).isEqualTo("away");
        // ⚠️ 제시(away_offers)를 소모하지도, 요구하지도 않는다 — 복수는 그 축과 별개의 문이다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM away_offers WHERE user_id = ?")
                .param(meId).query(Integer.class).single()).isZero();
    }

    // ── 헬퍼 ───────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> queueOf(String token) {
        ResponseEntity<Map> res = authGet("/api/away/revenge", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) res.getBody().get("entries");
    }

    /** attacker 가 defender 를 친 원정 한 판을 정산까지 밀어 넣는다(시뮬 없이 상태만). */
    private void raid(String attackerId, String defenderId, String matchId, String attackerResult) {
        seedRevengeChallenge(attackerId, defenderId, matchId, null);
        if ("WIN".equals(attackerResult)) {
            awayService.settle(matchId, attackerId, "WIN", 2, 0);
        } else if ("LOSS".equals(attackerResult)) {
            awayService.settle(matchId, attackerId, "LOSS", 0, 2);
        } else {
            awayService.settle(matchId, attackerId, "DRAW", 1, 1);
        }
    }

    /** 복수 매치 한 판을 정산까지(공격자 = 갚는 사람 = me). */
    private void revengeSettled(String meToken, String meId, String rivalId, String reportId,
                                String myResult) {
        String matchId = "RVM_" + reportId + "_" + myResult + "_" + System.nanoTime();
        seedRevengeChallenge(meId, rivalId, matchId, reportId);
        if ("WIN".equals(myResult)) {
            awayService.settle(matchId, meId, "WIN", 3, 1);
        } else if ("LOSS".equals(myResult)) {
            awayService.settle(matchId, meId, "LOSS", 0, 2);
        } else {
            awayService.settle(matchId, meId, "DRAW", 1, 1);
        }
    }

    private void seedRevengeChallenge(String attackerId, String defenderId, String matchId,
                                      String revengeReportId) {
        String now = java.time.Instant.now().toString();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                                      user_deck_json, mode, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', 'test', '{}', 'away', ?)
                        """)
                .params(matchId, attackerId, "2026-05-01T00:00:00Z").update();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO away_challenges(match_id, defender_id, ghost_bot_id,
                                                              created_at, revenge_report_id)
                        VALUES (?, ?, 'BOT_BAL', ?, ?)
                        """)
                .params(matchId, defenderId, now, revengeReportId).update();
    }

    /** 오늘(KST) 만든 원정으로 세어지는 매치 — 일일 한도 픽스처. */
    private void seedAwayMatchToday(String userId, String matchId) {
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                                      user_deck_json, mode, result, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', 'test', '{}', 'away', 'WIN', ?)
                        """)
                .params(matchId, userId, java.time.Instant.now().toString()).update();
    }

    private String reportIdOf(String matchId) {
        return jdbcClient.sql("SELECT id FROM away_reports WHERE match_id = ?")
                .param(matchId).query(String.class).optional().orElse(null);
    }

    private void backdate(String matchId, String createdAt) {
        jdbcClient.sql("UPDATE away_reports SET created_at = ? WHERE match_id = ?")
                .params(createdAt, matchId).update();
    }
}
