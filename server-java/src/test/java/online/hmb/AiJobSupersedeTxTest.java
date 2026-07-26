package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import online.hmb.common.TxRunner;
import online.hmb.jobs.AiJobQueue;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * {@code AiJobQueue.supersede} 의 <b>원자성</b> 계약 (#193 최종검증 m-3).
 *
 * <p>결함: supersede 는 세 개의 문장(① 미배포 queued 삭제 ② 나머지 effective=0 ③ 대상 effective=1)으로
 * <b>단 하나의 유효 잡</b>을 만드는데, 이게 트랜잭션 밖에서 하나씩 커밋되면 <b>중간 상태가 남에게 보인다</b>.
 * 실경로에 그 창이 있다: 프롬프트 제출의 <b>즉시 해소</b>(FirstHalfPreResolve)와 <b>킥오프</b>가 같은
 * (match,half,side)를 동시에 해소할 수 있고, 두 supersede 가 ②③ 사이로 서로 끼어들면 각자의 대상이 모두
 * effective=1 로 남아 <b>유효 잡 2행</b>이 된다. 그러면 {@code latestDoneResult}(단일 행 전제)가
 * 어느 쪽을 집을지 시점이 정하고, 유저의 최신 지시가 조용히 버려질 수 있다.
 *
 * <p>이 클래스는 <b>동시성 재현 대신</b> 두 가지를 박제한다(재현은 스케줄러 의존이라 비결정적이다):
 * <ul>
 *   <li><b>구조</b> — supersede 의 DB 작업이 <b>활성 트랜잭션 안에서</b> 실행된다(TxRunner 를 정확히
 *       1회 통과하고, 그 안에서 {@code isActualTransactionActive()} 가 참). 트랜잭션을 벗기면 깨진다.</li>
 *   <li><b>최종 상태 불변식</b> — 어떤 상태(done/leased/미배포 queued)가 섞여 있든, 재해소를 몇 번
 *       반복하든 (match,half,side) 의 effective=1 은 <b>정확히 1행</b>이고 그건 마지막 대상이다.</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(AiJobSupersedeTxTest.RecordingTxConfig.class)
class AiJobSupersedeTxTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    /** TxRunner 통과 횟수 — supersede 호출 구간의 증분만 본다(다른 경로도 TxRunner 를 쓴다). */
    static final AtomicInteger TX_RUNS = new AtomicInteger();
    /** TxRunner 로 넘긴 작업이 실행되는 순간 실제 트랜잭션이 열려 있었는가. */
    static final AtomicBoolean TX_ACTIVE_INSIDE = new AtomicBoolean();

    /**
     * 실제 트랜잭션 동작은 그대로 두고(진짜 TransactionTemplate) <b>통과 여부만</b> 기록하는 TxRunner.
     * 모킹이 아니라 데코레이션이라, 이 테스트가 green 이어도 트랜잭션 의미론은 프로덕션과 동일하다.
     */
    @TestConfiguration
    static class RecordingTxConfig {
        @Bean
        @Primary
        TxRunner recordingTxRunner(PlatformTransactionManager transactionManager) {
            return new TxRunner(transactionManager) {
                @Override
                public <T> T run(Supplier<T> action) {
                    TX_RUNS.incrementAndGet();
                    return super.run(() -> {
                        TX_ACTIVE_INSIDE.set(TransactionSynchronizationManager.isActualTransactionActive());
                        return action.get();
                    });
                }
            };
        }
    }

    @Resource
    private AiJobQueue jobQueue;

    // ── 구조: 세 문장이 한 트랜잭션 안에서 실행된다 ─────────────────────────

    @Test
    void supersedeRunsItsThreeStatementsInsideOneTransaction() {
        String matchId = seedMatch("tx_struct");
        String target = enqueueJob(matchId, "target");
        String stale = enqueueJob(matchId, "stale");
        markDone(stale);

        int runsBefore = TX_RUNS.get();
        TX_ACTIVE_INSIDE.set(false);

        jobQueue.supersede(matchId, 1, "home", target);

        assertThat(TX_RUNS.get() - runsBefore).isEqualTo(1); // 문장마다가 아니라 통째로 1회
        assertThat(TX_ACTIVE_INSIDE).isTrue();               // 그 안에서 실제 트랜잭션이 열려 있었다
    }

    // ── 최종 상태 불변식: 유효 잡은 언제나 정확히 1행 ───────────────────────

    @Test
    void mixedRowStatesCollapseToExactlyOneEffectiveJob() {
        String matchId = seedMatch("tx_mixed");
        String target = enqueueJob(matchId, "target");
        String doneRow = enqueueJob(matchId, "done");
        markDone(doneRow);
        String leasedRow = enqueueJob(matchId, "leased");
        markLeased(leasedRow);
        String ghost = enqueueJob(matchId, "ghost"); // 한 번도 배포 안 된 queued(attempts=0)

        jobQueue.supersede(matchId, 1, "home", target);

        assertThat(effectiveIds(matchId)).containsExactly(target); // 정확히 1행 = 대상
        assertThat(exists(ghost)).isFalse();                       // 미배포 queued 만 삭제
        assertThat(exists(doneRow)).isTrue();                      // done 캐시는 남긴다(effective=0)
        assertThat(exists(leasedRow)).isTrue();                    // 워커가 물고 있는 행도 남긴다
        assertThat(effectiveOf(doneRow)).isZero();
        assertThat(effectiveOf(leasedRow)).isZero();
    }

    /**
     * 재해소(제출 즉시 해소 → 킥오프 → 재편집)를 반복해도 불변식은 그대로다. 되돌린 지시가 예전 done
     * 행을 <b>복권</b>시키는 것(effective 0→1)까지 한 트랜잭션 안에서 일어난다.
     */
    @Test
    void repeatedSupersedeKeepsTheInvariantAndCanReviveACachedRow() {
        String matchId = seedMatch("tx_repeat");
        String first = enqueueJob(matchId, "first");
        markDone(first);
        String second = enqueueJob(matchId, "second");

        jobQueue.supersede(matchId, 1, "home", second);
        assertThat(effectiveIds(matchId)).containsExactly(second);

        jobQueue.supersede(matchId, 1, "home", second); // 멱등 — 같은 대상 재확정
        assertThat(effectiveIds(matchId)).containsExactly(second);

        markDone(second);                               // 그 사이 결과 도착(캐시가 된다)
        jobQueue.supersede(matchId, 1, "home", first);  // 지시를 되돌림 → 캐시된 done 행 복권
        assertThat(effectiveIds(matchId)).containsExactly(first);
        assertThat(effectiveOf(second)).isZero();
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    private String seedMatch(String nickname) {
        String token = setupUserWithDeck(nickname);
        String matchId = createMatch(token, "BOT_BAL");
        jdbcClient.sql("DELETE FROM ai_jobs").update(); // 프리페치 제거 — 행 구성을 직접 만든다
        return matchId;
    }

    /** (match, h1, home) 잡 1행. id = context 해시라 tag 가 다르면 다른 행이다. */
    private String enqueueJob(String matchId, String tag) {
        return jobQueue.enqueue(matchId, "home", 1, Map.of("kind", "team-input", "tag", tag));
    }

    private void markDone(String jobId) {
        jdbcClient.sql("UPDATE ai_jobs SET status = 'done', result_json = '{}', attempts = 1 WHERE id = ?")
                .param(jobId).update();
    }

    private void markLeased(String jobId) {
        jdbcClient.sql("UPDATE ai_jobs SET status = 'leased', attempts = 1 WHERE id = ?")
                .param(jobId).update();
    }

    private List<String> effectiveIds(String matchId) {
        return jdbcClient.sql("""
                        SELECT id FROM ai_jobs
                        WHERE match_id = ? AND half = 1 AND side = 'home' AND effective = 1
                        """)
                .param(matchId).query(String.class).list();
    }

    private int effectiveOf(String jobId) {
        return jdbcClient.sql("SELECT effective FROM ai_jobs WHERE id = ?")
                .param(jobId).query(Integer.class).single();
    }

    private boolean exists(String jobId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE id = ?")
                .param(jobId).query(Long.class).single() > 0;
    }
}
