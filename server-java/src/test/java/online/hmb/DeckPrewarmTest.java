package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import online.hmb.jobs.AiJobQueue;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 덱 저장 시 AI 인풋 <b>선실행</b> + <b>유저당 in-flight 1잡</b> — #215 W2-B2 (hero 확정 방향).
 *
 * <p><b>왜</b>(라이브 실측, #215 W1): A(베이스) 생성은 지금까지 <b>매치 생성(브리핑 진입)</b> 때 시작했다.
 * 생성이 51~294초인데 유저는 브리핑에 0.9~67초만 머물러 <b>단 한 번도 킥오프에 못 맞췄고</b>, 전부
 * 풀생성 폴백(122~191초)을 탔다. 리드타임을 <b>덱 저장 시점</b>으로 옮기면 분~시간 단위가 되어
 * "전술 무변경 = 콜0(0.5초)" 분기가 비로소 실제로 발동한다.
 *
 * <p><b>예산 가드</b>(P2-D8 정합): 저장을 연타해도 AI 콜이 저장 횟수만큼 늘면 안 된다. 그래서 유저당
 * 유효 prewarm 은 1개다 — 새로 저장하면 직전 잡을 supersede 한다(#193 의 원자성 패턴 재사용).
 * 단 <b>회수 대상은 "아무도 안 물었고 아무도 안 쓰는" 잡뿐</b>이다: ①한 번도 배포 안 된 queued(attempts=0)
 * 만 지운다(워커가 물었으면 complete 404 를 만들지 않는다) ②done 은 <b>캐시 자산</b>이라 남긴다
 * ③A 는 내용 해시 키라 <b>다른 유저와 공유</b>될 수 있으므로 남이 참조 중이면 건드리지 않는다.
 *
 * <p><b>보장의 실제 범위</b>(독립검증 F1): "저장 N회 = 콜 1회"가 아니다 — 워커가 사이에 물면 그 잡은
 * 회수 대상이 아니다(실행 중인 AI 를 취소할 수단이 없다). 참인 보장은 <b>유저당 동시 in-flight ≤
 * leased 1 + queued 1</b> 이고, 매치 잡이 A 보다 항상 먼저 리스되므로(AiJobQueue 우선순위) 유저 대기에
 * 끼어들지도 않는다.
 *
 * <p>박제하는 불변식: ① 저장하면 A 가 큐에 뜬다 ② 같은 덱 재저장은 잡을 늘리지 않는다(멱등)
 * ③ 덱을 바꿔 재저장하면 대기 잡은 여전히 1개(직전 미배포 잡 회수) ④ 남이 쓰는 A 는 회수하지 않는다
 * ⑤ done 인 A 는 지우지 않는다 ⑥ 저장한 A 를 킥오프가 그대로 찾아 쓴다(콜0) ⑦ config 로 끌 수 있다
 * ⑧ 물린 잡은 살아남고 대기 잡만 갈아끼운다 ⑨ 실패로 굳은 A 는 재저장이 되살린다 ⑩ 매치 프리페치로
 * 기다리는 유저도 원장에 실려 보호된다 ⑪ 튜토덱 지급도 선실행 트리거다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class DeckPrewarmTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    @Resource
    private AiJobQueue jobQueue;

    /**
     * {@code ai_jobs} 는 {@link MatchTestBase} 가 비우지만 <b>원장도 같이</b> 비워야 메서드가 격리된다 —
     * 안 그러면 앞 메서드가 남긴 "다른 유저가 같은 A 를 참조 중" 상태 때문에 회수가 (정상적으로)
     * 막혀 다른 메서드가 애먼 실패를 한다. 실제로 그 실패를 한 번 겪고 넣은 정리다.
     */
    @org.junit.jupiter.api.BeforeEach
    void clearPrewarmLedger() {
        jdbcClient.sql("DELETE FROM deck_prewarm").update();
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** 선발 11 + 벤치 2 덱을 저장한다. {@code twist} 로 한 슬롯의 프롬프트를 바꿔 다른 덱을 만든다. */
    private void saveDeck(String token, String formation, String twist) {
        assertThat(authPut("/api/deck", token, deckBody(formation, defaultSlots(twist)), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /** 선발 11 + 벤치 2. {@code twist} 는 마지막 선발의 프롬프트만 바꿔 "다른 덱"을 만든다. */
    private List<Map<String, Object>> defaultSlots(String twist) {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(i == 11 && twist != null
                    ? slot(String.format("P%03d", i), "starter", i - 1, twist)
                    : slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, "벤치 프롬프트"));
        return slots;
    }

    /** A(베이스) 잡 = match_id IS NULL. */
    private long baseRows() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL")
                .query(Long.class).single();
    }

    private long queuedBaseRows() {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL AND status = 'queued'
                        """)
                .query(Long.class).single();
    }

    private String prewarmBaseIdOf(String nickname) {
        return jdbcClient.sql("SELECT base_id FROM deck_prewarm WHERE user_id = ?")
                .param(userIdOf(nickname)).query(String.class).optional().orElse(null);
    }

    // ── ①② 저장 = 선실행, 재저장 = 멱등 ───────────────────────────────────

    @Test
    void savingADeckEnqueuesItsBaseJobRightThen() {
        String token = login("prewarm_save");
        assertThat(baseRows()).isZero();

        saveDeck(token, "4-4-2", null);

        assertThat(queuedBaseRows()).as("덱 저장 즉시 A 가 큐에 있어야 한다").isEqualTo(1L);
        assertThat(prewarmBaseIdOf("prewarm_save")).isNotNull();
    }

    @Test
    void savingTheSameDeckAgainDoesNotAddAnotherJob() {
        String token = login("prewarm_idem");
        saveDeck(token, "4-4-2", null);
        String first = prewarmBaseIdOf("prewarm_idem");

        saveDeck(token, "4-4-2", null);
        saveDeck(token, "4-4-2", null);

        assertThat(baseRows()).isEqualTo(1L);
        assertThat(prewarmBaseIdOf("prewarm_idem")).isEqualTo(first);
    }

    // ── ③ 유저당 in-flight 1잡 (예산 가드) ────────────────────────────────

    @Test
    void editingTheDeckRepeatedlyKeepsExactlyOneInFlightJob() {
        String token = login("prewarm_edit");
        saveDeck(token, "4-4-2", null);
        saveDeck(token, "4-4-2", "1차 수정");
        saveDeck(token, "4-4-2", "2차 수정");
        saveDeck(token, "4-3-3", "3차 수정");

        assertThat(baseRows())
                .as("워커가 물기 전 편집은 큐의 잡을 갈아끼운다 — 저장 4회에 미배포 잡 1개")
                .isEqualTo(1L);
        assertThat(queuedBaseRows()).isEqualTo(1L);
    }

    /**
     * <b>보장의 실제 범위</b>(독립검증 F1): 워커가 저장 사이에 잡을 물면 그 잡은 회수 대상이 아니다
     * (실행 중인 AI 를 취소할 수단이 없고, 늦은 complete 를 404 로 만들지도 않는다). 그래서 "저장 N회 =
     * 콜 1회"는 <b>거짓</b>이다 — 참인 보장은 <b>유저당 동시 in-flight ≤ leased 1 + queued 1</b> 이다.
     * 라이브에서 롱폴 워커는 1초 안에 물기 때문에 이 경로가 실제 경로다. 이 테스트가 그 차이를 박제한다.
     * (워커 1개 기준. 배포 기본 {@code AI_CONCURRENCY=2} 에서는 물린 것이 그만큼 늘 수 있고,
     * 불변인 것은 <b>대기 잡 1개</b> 쪽이다 — 독립검증 2R R2.)
     */
    @Test
    void aLeasedBaseSurvivesTheNextSaveButPendingStaysAtOne() {
        String token = login("prewarm_leased");
        saveDeck(token, "4-4-2", "최초");
        AiJobQueue.JobRow leased = jobQueue.lease("worker-1").orElseThrow(); // 워커가 물었다

        saveDeck(token, "4-4-2", "물린 뒤 편집");
        saveDeck(token, "4-4-2", "또 편집");

        assertThat(jobQueue.find(leased.id())).as("물린 잡은 살려둔다").isPresent();
        assertThat(queuedBaseRows())
                .as("대기 중인 잡은 언제나 1개 — 그 뒤 편집들은 서로를 갈아끼운다")
                .isEqualTo(1L);
        assertThat(baseRows()).as("물린 것 1 + 대기 1 — 불변인 쪽은 대기 1").isEqualTo(2L);
    }

    /**
     * 영구 실패한 A 를 <b>같은 덱 재저장이 되살린다</b>(독립검증 F3). {@code enqueueBase} 는
     * INSERT OR IGNORE 이고 회수는 queued 만 지우므로, 되살림이 없으면 그 덱은 영영 폴백이었다 —
     * 덱 저장이 A 의 주 트리거가 된 지금 유저가 스스로 복구할 수단은 이것뿐이다.
     */
    @Test
    void aFailedBaseIsRevivedBySavingTheSameDeckAgain() {
        String token = login("prewarm_revive");
        saveDeck(token, "4-4-2", "되살림");
        String baseId = prewarmBaseIdOf("prewarm_revive");
        jdbcClient.sql("UPDATE ai_jobs SET status = 'failed' WHERE id = ?").param(baseId).update();

        saveDeck(token, "4-4-2", "되살림"); // 같은 덱 그대로 다시 저장

        assertThat(jobQueue.find(baseId).orElseThrow().status())
                .as("실패로 굳은 A 가 다시 큐에 선다")
                .isEqualTo("queued");
    }

    /**
     * 매치 생성으로 A 를 기다리게 된 유저도 원장에 실린다(독립검증 F2). 안 그러면 <b>원장이 빈 기존
     * 유저 전원</b>이 무방비였다 — 같은 덱을 쓰는 남이 덱을 바꿔 저장하면 그 유저가 기다리던 A 가
     * 지워져 풀생성 폴백으로 떨어진다(= #215 의 원증상).
     */
    @Test
    void aUserWaitingViaMatchPrefetchIsAlsoProtected() {
        String waiter = login("prewarm_waiter");
        List<Map<String, Object>> slots = defaultSlots(null);
        assertThat(authPut("/api/deck", waiter, deckBody("4-4-2", slots), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        jdbcClient.sql("DELETE FROM deck_prewarm").update();       // V20 배포 직후 = 원장이 빈 상태
        createMatch(waiter, "BOT_BAL");                            // 프리페치로 A 를 기다리기 시작
        String waited = jdbcClient.sql("SELECT base_id FROM deck_prewarm WHERE user_id = ?")
                .param(userIdOf("prewarm_waiter")).query(String.class).single();

        String other = login("prewarm_other");                     // 같은 덱을 쓰는 다른 유저가
        saveDeck(other, "4-4-2", null);
        saveDeck(other, "4-3-3", "덱 변경");                        // 덱을 바꿔 저장한다

        assertThat(jobQueue.find(waited))
                .as("남의 재저장이 내가 기다리는 A 를 지우면 안 된다")
                .isPresent();
    }

    /** ⑤ 이미 done 인 A 는 캐시 자산이라 지우지 않는다 — 되돌리면 콜0으로 복귀해야 한다. */
    @Test
    void aFinishedBaseIsKeptAsCacheWhenTheDeckChanges() {
        String token = login("prewarm_done");
        saveDeck(token, "4-4-2", null);
        String done = prewarmBaseIdOf("prewarm_done");
        completeQueuedBase(done);

        saveDeck(token, "4-4-2", "바꾼 지시");

        assertThat(baseRows()).as("done 1(캐시) + 신규 queued 1").isEqualTo(2L);
        assertThat(jobQueue.find(done).orElseThrow().status()).isEqualTo("done");
    }

    /** ④ A 는 내용 해시라 유저 간 공유된다 — 남이 참조 중인 잡을 내 저장이 회수하면 안 된다. */
    @Test
    void anotherUsersPendingBaseIsNeverReclaimed() {
        String mine = login("prewarm_mine");
        String theirs = login("prewarm_theirs");
        saveDeck(mine, "4-4-2", null);
        saveDeck(theirs, "4-4-2", null); // 같은 덱 → 같은 A 를 공유
        String shared = prewarmBaseIdOf("prewarm_mine");
        assertThat(prewarmBaseIdOf("prewarm_theirs")).isEqualTo(shared);

        saveDeck(mine, "4-3-3", "내 수정"); // 나는 옮겨간다

        assertThat(jobQueue.find(shared))
                .as("상대가 아직 기다리는 A 를 내 저장이 지우면 그 유저는 폴백으로 떨어진다")
                .isPresent();
        assertThat(prewarmBaseIdOf("prewarm_theirs")).isEqualTo(shared);
    }

    /**
     * 튜토리얼 덱 지급도 <b>저장</b>이다 — 가입 직후 첫 경기가 곧바로 이어지는 경로라 여기서 A 를
     * 돌려두지 않으면 신규 유저는 항상 풀생성 폴백을 본다(#215 W1 의 오픈베타 테스터 케이스).
     * (독립검증 F4: 이 계약이 없어서 호출을 지워도 전체 green 이었다.)
     */
    @Test
    void grantingTheTutorialDeckAlsoWarmsItsBase() {
        String token = login("prewarm_tutorial"); // 덱 없이 시작
        assertThat(baseRows()).isZero();

        Map<String, Object> result = authPost("/api/me/tutorial-complete", token, Map.of(), Map.class)
                .getBody();

        assertThat(result).containsEntry("deckGranted", true);
        assertThat(queuedBaseRows()).as("지급된 덱의 A 가 그 자리에서 큐에 선다").isEqualTo(1L);
        assertThat(prewarmBaseIdOf("prewarm_tutorial")).isNotNull();
    }

    // ── ⑥ 저장한 A 를 킥오프가 쓴다 ──────────────────────────────────────

    @Test
    void theBaseWarmedAtDeckSaveIsTheOneKickoffReuses() {
        String token = login("prewarm_reuse");
        saveDeck(token, "4-4-2", null);
        String warmed = prewarmBaseIdOf("prewarm_reuse");
        completeQueuedBase(warmed);

        String matchId = createMatch(token, "BOT_BAL");

        // 매치 생성의 프리페치는 이미 done 인 유저 A 를 다시 만들지 않는다(봇 A 만 새로 뜬다).
        assertThat(jobQueue.find(warmed).orElseThrow().status()).isEqualTo("done");
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
    }

    /** 큐에 있는 A 를 done 으로 만든다(워커 완주 시뮬레이션 — 결과 내용은 이 테스트의 주제가 아니다). */
    private void completeQueuedBase(String baseId) {
        jdbcClient.sql("""
                        UPDATE ai_jobs SET status = 'done', result_json = ?, updated_at = ?
                        WHERE id = ?
                        """)
                .params("{\"team\":{},\"players\":{}}", java.time.Instant.now().toString(), baseId)
                .update();
    }
}
