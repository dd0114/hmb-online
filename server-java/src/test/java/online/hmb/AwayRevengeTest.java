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

    @Resource
    private online.hmb.match.MatchLockService lockService;

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

        revengeRound(me, meId, reportId, "LOSS");
        assertThat(queueOf(me)).singleElement().satisfies(e -> {
            assertThat(e.get("attemptsUsed")).isEqualTo(1);
            assertThat(e.get("state")).isEqualTo("AVAILABLE");   // 아직 한 번 남았다
        });

        revengeRound(me, meId, reportId, "LOSS");
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

        revengeRound(me, meId, reportId, "WIN");

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

        revengeRound(me, meId, reportId, "DRAW");

        assertThat(queueOf(me)).singleElement().satisfies(e -> {
            assertThat(e.get("attemptsUsed")).isEqualTo(0);
            assertThat(e.get("state")).isEqualTo("AVAILABLE");
        });
    }

    /**
     * 정산은 <b>예약된 시도를 다시 깎지 않는다</b>. 소모가 생성 시점으로 옮겨졌으므로(BL-1)
     * {@code settle} 의 LOSS 분기는 no-op 이어야 한다 — 여기에 증분을 되살리면 한 판에 두 번 깎인다.
     *
     * <p>⚠️ 이 테스트의 원래 이름은 "재정산해도 두 번 깎이지 않는다"였는데, 그 불변식은 이제
     * <b>이 테스트가 태우지 않는다</b>(no-op 을 두 번 불러 아무 일도 없음을 확인할 뿐 — 독립검증
     * 2R MAJOR-1 이 false green 으로 잡았다). 재정산 축은 {@code 무승부_재정산이_시도를_되살리지_않는다}
     * 가 <b>환불 방향</b>으로 따로 태운다(지금의 진짜 위험은 시도가 순증하는 쪽이다).
     */
    @Test
    void 정산은_예약된_시도를_또_깎지_않는다() {
        // 멱등 게이트 앞에 두면 재정산이 유저가 치지도 않은 판을 뺏는다(#245 가 연승에서 당한 형태).
        String me = setupUserWithDeck("rv_idem_me");
        String meId = userIdOf("rv_idem_me");
        setupOpponentWithDeck("rv_idem_atk");
        String attackerId = userIdOf("rv_idem_atk");
        raid(attackerId, meId, "RV_IDEM1", "WIN");
        String reportId = reportIdOf("RV_IDEM1");

        ResponseEntity<Map> created = authPost(
                "/api/away/revenge/" + reportId + "/matches", me, null, Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) created.getBody().get("id");
        awayService.settle(matchId, meId, "LOSS", 0, 2);
        awayService.settle(matchId, meId, "LOSS", 0, 2);   // 같은 매치 재정산

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

        ResponseEntity<Map> created = authPost(
                "/api/away/revenge/" + reportId + "/matches", me, null, Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String revengeMatchId = (String) created.getBody().get("id");
        awayService.settle(revengeMatchId, meId, "WIN", 3, 1);   // 갚았다 → rival 이 수비자인 리포트 생성

        String rivalReport = reportIdOf(revengeMatchId);
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


    /**
     * ⚠️ <b>동시 요청으로 "기록당 2회"가 뚫리지 않는다</b>(독립검증 BL-1).
     *
     * <p>앞의 검사들은 전부 read-then-act 라, 예약이 없던 판에서는 같은 {@code reportId} 로 동시에
     * 6번 POST 하면 <b>6판이 전부 생성됐다</b>(실측). 복수는 §4.1 이 좁혀서 여는 문 —
     * <b>내가 상대를 고르는 유일한 경로</b>라, 경합 한 번이 곧 약한 부계정 상대로 1버스트 N판이 된다.
     *
     * <p>단언을 "성공 1건"이 아니라 <b>"상한 이하"</b> 로 거는 이유: 진행 중 매치 1개 불변식(#217)의
     * 잠금 자체도 read-then-act 라 같은 경합에서 샌다(대조군: 연습·일반 원정도 동시 요청이 뚫린다).
     * 그건 이 웨이브가 만든 결함이 아니라 <b>선존 플랫폼 결함</b>이고 별도 이슈다. 여기서 지켜야 할
     * 것은 <b>복수 자물쇠</b>다 — 한 기록으로 만들 수 있는 판은 어떤 경합에서도 {@code attempts-max} 를
     * 넘지 않는다. 그 이상을 단언하면 남의 결함 때문에 이 계약이 거짓 실패한다.
     */
    @Test
    void 동시_요청으로도_기록당_시도_상한을_넘지_못한다() throws Exception {
        String me = setupUserWithDeck("rv_race_me");
        String meId = userIdOf("rv_race_me");
        setupOpponentWithDeck("rv_race_atk");
        String attackerId = userIdOf("rv_race_atk");
        raid(attackerId, meId, "RV_RACE1", "WIN");
        String reportId = reportIdOf("RV_RACE1");

        int threads = 6;
        java.util.concurrent.ExecutorService pool =
                java.util.concurrent.Executors.newFixedThreadPool(threads);
        java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
        List<java.util.concurrent.Future<org.springframework.http.HttpStatusCode>> futures =
                new java.util.ArrayList<>();
        for (int i = 0; i < threads; i++) {
            futures.add(pool.submit(() -> {
                go.await();
                return authPost("/api/away/revenge/" + reportId + "/matches", me, null, Map.class)
                        .getStatusCode();
            }));
        }
        go.countDown();
        int created = 0;
        for (java.util.concurrent.Future<org.springframework.http.HttpStatusCode> f : futures) {
            if (f.get() == HttpStatus.CREATED) {
                created++;
            }
        }
        pool.shutdown();

        int attemptsMax = 2;   // application.yml hmb.away.revenge.attempts-max
        assertThat(created).as("한 기록으로 만들어진 복수 매치 수").isLessThanOrEqualTo(attemptsMax);
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM away_challenges WHERE revenge_report_id = ?")
                .param(reportId).query(Integer.class).single())
                .as("도전장 행 수도 같은 상한을 넘지 않는다")
                .isLessThanOrEqualTo(attemptsMax);
    }

    /**
     * ⚠️ <b>갚은 기록이 창 슬롯을 비워 주지 않는다</b>(독립검증 MAJ-1).
     *
     * <p>{@code AVENGED} 를 제외한 뒤 LIMIT 을 걸면 갚을 때마다 더 오래된 기록이 되살아난다 —
     * 부계정이 20번 쳐 뒀으면 5개가 아니라 <b>20개 전부</b>가 순차적으로 지목 대상이 되고, 그러면
     * "최근 5건"은 창이 아니라 필터일 뿐이다(= 좁혀서 연 문이 다시 넓어진다).
     */
    @Test
    void 갚아도_창_밖_기록이_되살아나지_않는다() {
        String me = setupUserWithDeck("rv_slot_me");
        String meId = userIdOf("rv_slot_me");
        setupOpponentWithDeck("rv_slot_atk");
        String attackerId = userIdOf("rv_slot_atk");

        for (int i = 1; i <= 6; i++) {
            raid(attackerId, meId, "RV_SLOT" + i, "WIN");
            backdate("RV_SLOT" + i, "2026-07-0" + i + "T00:00:00Z");
        }
        String oldest = reportIdOf("RV_SLOT1");
        assertThat(authPost("/api/away/revenge/" + oldest + "/matches", me, null, Map.class)
                .getStatusCode()).as("처음엔 창 밖").isEqualTo(HttpStatus.GONE);

        // 창 안의 최신 기록을 갚는다 → 목록에서는 사라진다(§4.2).
        revengeRound(me, meId, reportIdOf("RV_SLOT6"), "WIN");
        assertThat(queueOf(me)).noneSatisfy(e ->
                assertThat(e.get("reportId")).isEqualTo(reportIdOf("RV_SLOT6")));

        // ⚠️ 그렇다고 창이 넓어지지는 않는다.
        ResponseEntity<Map> again =
                authPost("/api/away/revenge/" + oldest + "/matches", me, null, Map.class);
        assertThat(again.getStatusCode()).as("갚은 뒤에도 창 밖").isEqualTo(HttpStatus.GONE);
        assertThat(again.getBody().get("code")).isEqualTo("REVENGE_EXPIRED");
    }

    /**
     * 자기 자신 지목 차단(독립검증 MIN-1). 정상 경로로는 {@code attacker = defender} 인 원장 행이
     * 생기지 않지만, 생기는 순간 자기와 붙어 +10/−10 + 연승 보너스만큼 <b>순증</b>이 된다.
     * 일반 원정에는 이미 있는 가드다 — 새 문에만 없으면 그 문이 우회로가 된다.
     */
    @Test
    void 자기_자신은_지목할_수_없다() {
        String me = setupUserWithDeck("rv_self_me");
        String meId = userIdOf("rv_self_me");
        raid(meId, meId, "RV_SELF1", "WIN");

        ResponseEntity<Map> res = authPost(
                "/api/away/revenge/" + reportIdOf("RV_SELF1") + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * 몰수 침공은 큐에 <b>몰수라고 표시돼서</b> 온다(독립검증 MIN-7). 상대가 브리핑에서 무른 것이라
     * 결과는 내 승리(+10)로 기록되지만, 화면이 그걸 "내가 막아냄"이라고 말하면 사실과 다르다.
     * 복수 차단 자체는 옳다(갚을 것이 없다) — 틀린 것은 <b>라벨</b>이라 서버가 사실을 실어 보낸다.
     */
    @Test
    void 몰수_침공은_몰수로_표시된다() {
        String me = setupUserWithDeck("rv_ff_me");
        String meId = userIdOf("rv_ff_me");
        setupOpponentWithDeck("rv_ff_atk");
        String attackerId = userIdOf("rv_ff_atk");

        seedRevengeChallenge(attackerId, meId, "RV_FF1", null);
        awayService.settle("RV_FF1", attackerId, "LOSS", 0, 0, true);   // 몰수

        assertThat(queueOf(me)).singleElement().satisfies(e -> {
            assertThat(e.get("forfeit")).isEqualTo(true);
            assertThat(e.get("defenceResult")).isEqualTo("WIN");   // 원장은 그대로(hero D1)
        });
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


    /**
     * ⚠️ <b>서버 사고가 유저의 도전 기회를 먹지 않는다</b>(독립검증 2R BLOCKER-1).
     *
     * <p>시도는 매치를 만드는 순간 예약된다(원자적 자물쇠). 그런데 사고 회수 경로(FAILED · 멈춘
     * 생성 · 시계 멈춤 · 스톨 스윕)는 <b>정산이 돌지 않으므로</b>, 되돌려 주지 않으면 유저는
     * <b>한 판도 못 치른 채</b> 기록이 소진된다. 같은 코드가 바로 그 자리에서 레이팅은 면제하면서
     * (<i>"서버 장애가 유저 레이팅을 깎으면 안 된다"</i>) 복수 시도만 청구하면 자기모순이다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void 사고로_회수된_복수는_시도를_돌려준다() {
        String me = setupUserWithDeck("rv_acc_me");
        String meId = userIdOf("rv_acc_me");
        setupOpponentWithDeck("rv_acc_atk");
        String attackerId = userIdOf("rv_acc_atk");
        raid(attackerId, meId, "RV_ACC1", "WIN");
        String reportId = reportIdOf("RV_ACC1");

        ResponseEntity<Map> created = authPost(
                "/api/away/revenge/" + reportId + "/matches", me, null, Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) created.getBody().get("id");
        assertThat(attemptsOf(reportId)).as("생성 시점에 예약된다").isEqualTo(1);

        // 사고: AI 잡이 죽어 FAILED — #217 이 영구 잠금을 막으려고 연 탈출구로 회수한다.
        forceState(matchId, "FAILED");
        assertThat(authPost("/api/matches/" + matchId + "/abandon", me, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(attemptsOf(reportId)).as("사고는 시도를 먹지 않는다").isZero();
        assertThat(queueOf(me)).singleElement().satisfies(e -> {
            assertThat(e.get("attemptsUsed")).isEqualTo(0);
            assertThat(e.get("state")).isEqualTo("AVAILABLE");
        });
        // 실제로 다시 도전할 수 있어야 한다(숫자만 돌려놓고 문이 닫혀 있으면 의미가 없다).
        assertThat(authPost("/api/away/revenge/" + reportId + "/matches", me, null, Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    /**
     * 사고 환불은 <b>멱등</b>하다 — 도전장의 복수 링크를 끊는 것이 그 장치다.
     *
     * <p>⚠️ 초판 계약은 스위퍼를 한 번 더 돌려 확인했는데, 스위퍼는 ABANDONED 를 다시 고르지 않아
     * <b>두 번째 호출 자체가 일어나지 않았다</b> — 멱등 장치를 통째로 제거해도 통과하는 공허한
     * 계약이었다(2R 후속 변이 R2 생존). 장치를 태우려면 <b>직접 두 번</b> 불러야 한다.
     */
    @Test
    void 사고_환불은_두_번_돌지_않는다() {
        String me = setupUserWithDeck("rv_acc2_me");
        String meId = userIdOf("rv_acc2_me");
        setupOpponentWithDeck("rv_acc2_atk");
        String attackerId = userIdOf("rv_acc2_atk");
        raid(attackerId, meId, "RV_ACC2_B", "WIN");
        String reportId = reportIdOf("RV_ACC2_B");

        String matchId = (String) authPost("/api/away/revenge/" + reportId + "/matches", me, null,
                Map.class).getBody().get("id");
        // 경합으로 2판이 떠 있는 상태(= 예약 2건)를 손으로 만든다.
        jdbcClient.sql("UPDATE away_reports SET revenge_attempts = 2 WHERE id = ?")
                .param(reportId).update();

        awayService.refundAccidentalRevenge(matchId);
        assertThat(attemptsOf(reportId)).as("사고 1건 = 환불 1회").isEqualTo(1);
        awayService.refundAccidentalRevenge(matchId);
        awayService.refundAccidentalRevenge(matchId);
        assertThat(attemptsOf(reportId)).as("몇 번을 불러도 한 번만").isEqualTo(1);
    }

    /**
     * 사고 환불은 <b>실제로 치른 판</b>은 건드리지 않는다. 정산이 돌았다는 것이 그 증거다
     * (리포트 행) — 그걸 안 보면 자발적 몰수까지 환불돼 무르기 리롤이 열린다.
     */
    @Test
    void 정산이_끝난_복수는_환불되지_않는다() {
        String me = setupUserWithDeck("rv_acc3_me");
        String meId = userIdOf("rv_acc3_me");
        setupOpponentWithDeck("rv_acc3_atk");
        String attackerId = userIdOf("rv_acc3_atk");
        raid(attackerId, meId, "RV_ACC3", "WIN");
        String reportId = reportIdOf("RV_ACC3");

        String matchId = (String) authPost("/api/away/revenge/" + reportId + "/matches", me, null,
                Map.class).getBody().get("id");
        awayService.settle(matchId, meId, "LOSS", 0, 2);   // 실제로 치르고 졌다
        assertThat(attemptsOf(reportId)).isEqualTo(1);

        awayService.refundAccidentalRevenge(matchId);
        assertThat(attemptsOf(reportId)).as("치른 판은 돌려주지 않는다").isEqualTo(1);
    }

    /**
     * ⚠️ <b>환불이 이미 갚은 기록을 되살리지 않는다</b>(2R MINOR-4 축).
     *
     * <p>경합으로 두 판이 동시에 떠 있다가 하나가 이기고({@code AVENGED}) 다른 하나가 늦게
     * 무승부로 정산되는 순서가 실재한다. 그 늦은 정산이 상태를 되돌리면 <b>닫힌 문이 다시 열린다</b>.
     *
     * <p>⚠️ <b>이 계약이 덮는 것은 "늦은 정산이 AVENGED 를 뒤집지 않는다"까지다.</b>
     * {@code refundRevenge} 의 {@code <> 'AVENGED'} 조건 자체는 <b>등가 변이</b>라 여기서 죽지 않는다 —
     * 갚은 기록의 시도 수는 어디서도 관측되지 않기 때문이다(그쪽 판단 근거는 그 메서드 javadoc).
     */
    @Test
    void 환불은_이미_갚은_기록을_되살리지_않는다() {
        String me = setupUserWithDeck("rv_av2_me");
        String meId = userIdOf("rv_av2_me");
        setupOpponentWithDeck("rv_av2_atk");
        String attackerId = userIdOf("rv_av2_atk");
        raid(attackerId, meId, "RV_AV2", "WIN");
        String reportId = reportIdOf("RV_AV2");

        String won = (String) authPost("/api/away/revenge/" + reportId + "/matches", me, null,
                Map.class).getBody().get("id");
        releaseActiveMatches();
        // 두 번째 판이 같이 떠 있던 상태(#333 경합) — 손으로 도전장을 하나 더 심는다.
        seedRevengeChallenge(meId, attackerId, "RV_AV2_LATE", reportId);
        jdbcClient.sql("UPDATE away_reports SET revenge_attempts = 2 WHERE id = ?")
                .param(reportId).update();

        awayService.settle(won, meId, "WIN", 3, 1);                  // 갚았다
        awayService.settle("RV_AV2_LATE", meId, "DRAW", 1, 1);       // 늦게 도착한 무승부 → 환불 시도

        assertThat(stateOfReport(reportId)).as("AVENGED 는 유지된다").isEqualTo("AVENGED");
        ResponseEntity<Map> res =
                authPost("/api/away/revenge/" + reportId + "/matches", me, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.GONE);
        assertThat(res.getBody().get("code")).isEqualTo("REVENGE_AVENGED");
    }

    /**
     * ⚠️ <b>무승부 환불이 재정산에서 두 번 돌지 않는다</b>(독립검증 2R MAJOR-1).
     *
     * <p>원래 이 자리엔 "재정산해도 시도가 두 번 깎이지 않는다"가 있었는데, 소모가 생성 시점으로
     * 옮겨지면서 {@code settle} 의 LOSS 분기가 <b>no-op</b> 이 됐다 — 아무것도 하지 않는 코드를 두 번
     * 불러 "두 번 깎이지 않았다"를 확인하는 <b>false green</b> 이 된 것이다. 이제 위험은 반대 방향이다:
     * 환불이 두 번 돌면 <b>시도가 순증</b>해 상한을 넘는다. 그쪽을 태운다.
     */
    @Test
    void 무승부_재정산이_시도를_되살리지_않는다() {
        String me = setupUserWithDeck("rv_dr2_me");
        String meId = userIdOf("rv_dr2_me");
        setupOpponentWithDeck("rv_dr2_atk");
        String attackerId = userIdOf("rv_dr2_atk");
        raid(attackerId, meId, "RV_DR2", "WIN");
        String reportId = reportIdOf("RV_DR2");

        // 2판을 예약한 상태에서 하나가 무승부로 끝난다(경합으로 도달 가능한 상태).
        String matchId = (String) authPost("/api/away/revenge/" + reportId + "/matches", me, null,
                Map.class).getBody().get("id");
        jdbcClient.sql("UPDATE away_reports SET revenge_attempts = 2 WHERE id = ?")
                .param(reportId).update();

        awayService.settle(matchId, meId, "DRAW", 1, 1);
        assertThat(attemptsOf(reportId)).as("무승부 1건 = 환불 1회").isEqualTo(1);
        awayService.settle(matchId, meId, "DRAW", 1, 1);   // 같은 매치 재정산
        awayService.settle(matchId, meId, "DRAW", 1, 1);
        assertThat(attemptsOf(reportId)).as("재정산은 환불을 더 하지 않는다").isEqualTo(1);
    }

    private String stateOfReport(String reportId) {
        return jdbcClient.sql("SELECT revenge_state FROM away_reports WHERE id = ?")
                .param(reportId).query(String.class).single();
    }

    private int attemptsOf(String reportId) {
        return jdbcClient.sql("SELECT revenge_attempts FROM away_reports WHERE id = ?")
                .param(reportId).query(Integer.class).single();
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

    /**
     * 복수 한 판을 <b>실제 엔드포인트로</b> 만들고 정산까지 민다.
     *
     * <p>⚠️ 도전장을 직접 심지 않는 이유: 시도 예약이 <b>생성 시점</b>으로 옮겨졌으므로(BL-1),
     * DB 를 손으로 채우면 자물쇠를 통과하지 않은 판이 되어 계약이 실물을 안 태운다.
     */
    private void revengeRound(String meToken, String meId, String reportId, String myResult) {
        ResponseEntity<Map> created = authPost(
                "/api/away/revenge/" + reportId + "/matches", meToken, null, Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) created.getBody().get("id");
        if ("WIN".equals(myResult)) {
            awayService.settle(matchId, meId, "WIN", 3, 1);
        } else if ("LOSS".equals(myResult)) {
            awayService.settle(matchId, meId, "LOSS", 0, 2);
        } else {
            awayService.settle(matchId, meId, "DRAW", 1, 1);
        }
        releaseActiveMatches();   // 다음 판을 위해 #217 잠금 해제
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
