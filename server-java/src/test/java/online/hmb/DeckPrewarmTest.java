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
 * <p>박제하는 불변식: ① 저장하면 A 가 큐에 뜬다 ② 같은 덱 재저장은 잡을 늘리지 않는다(멱등)
 * ③ 덱을 바꿔 재저장하면 유효 잡은 여전히 1개(직전 미배포 잡 회수) ④ 남이 쓰는 A 는 회수하지 않는다
 * ⑤ done 인 A 는 지우지 않는다 ⑥ 저장한 A 를 킥오프가 그대로 찾아 쓴다(콜0) ⑦ config 로 끌 수 있다.
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
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(i == 11 && twist != null
                    ? slot(String.format("P%03d", i), "starter", i - 1, twist)
                    : slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, "벤치 프롬프트"));
        assertThat(authPut("/api/deck", token, deckBody(formation, slots), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
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
                .as("저장 4회 = AI 콜 1회분 — 미배포 잡은 갈아끼운다")
                .isEqualTo(1L);
        assertThat(queuedBaseRows()).isEqualTo(1L);
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
