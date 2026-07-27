package online.hmb.match;

import java.time.Instant;
import online.hmb.common.TxRunner;
import online.hmb.jobs.AiJobQueue;
import online.hmb.meta.DeckService;
import online.hmb.meta.DeckSnapshot;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 덱 저장 시 AI 인풋 <b>선실행</b>(A 베이스 프리워밍) — #215 W2 (hero 확정 방향).
 *
 * <p><b>문제</b>(라이브 실측, #215 W1): A 생성은 지금까지 <b>매치 생성(브리핑 진입)</b> 때 시작했다.
 * 생성이 51~294초인데 유저가 브리핑에 머무는 시간은 0.9~67초 — 리드타임이 생성시간보다 짧으니
 * 구조적으로 못 맞추고, 라이브 매치 전부가 풀생성 폴백(122~191초)을 탔다. "전술 무변경이면 콜0"
 * 분기는 전제(A done)가 성립한 적이 없어 <b>한 번도 발동하지 않았다</b>.
 *
 * <p><b>해결</b>: 시작점을 덱 저장으로 옮긴다. 리드타임이 분~시간이 되어 킥오프 때는 이미 준비돼 있다.
 * 킥오프 경로는 <b>건드리지 않는다</b> — 같은 A 를 찾아 쓰기만 하면 되므로(같은 baseId) 폴백을 포함한
 * 기존 동작이 그대로 남는다(A 미완이면 여전히 풀생성).
 *
 * <p><b>예산 가드</b>(P2-D8 정합): 저장 연타가 AI 콜 폭증이 되면 안 된다. 유저당 <b>대기(queued) A 는
 * 1개</b> 다 — {@code deck_prewarm}(V20) 이 유저당 1행으로 강제하고 갈아탈 때 직전 잡을 회수한다.
 * (이미 <b>물린</b> 잡은 회수 못 한다 — 실행 중인 AI 를 취소할 수단이 없다. 그래서 "저장 N회 = 콜 1회"는
 * 거짓이고, 참인 명제는 "대기 ≤ 1/유저, 물린 것 ≤ AI_CONCURRENCY" 다 — 독립검증 F1/R2.) 회수는
 * <b>"아무도 안 물었고 아무도 안 쓰는" 잡</b>만이다:
 * <ul>
 *   <li>{@code queued} + {@code attempts=0} 만 — 워커가 이미 물었으면 남긴다(늦은 complete 를 404 로 만들지 않는다).</li>
 *   <li>{@code done} 은 <b>캐시 자산</b>이라 남긴다 — 덱을 되돌리면 그 결과로 콜0 복귀해야 한다(#193 supersede 와 같은 규율).</li>
 *   <li>A id 는 <b>덱 내용 해시</b>라 유저 간 공유된다 — 다른 유저가 참조 중이면 건드리지 않는다(남의 대기를 폴백으로 떨어뜨리는 짓).</li>
 * </ul>
 *
 * <p>실패는 전부 삼킨다(로그만) — 선실행은 <b>최적화</b>지 정합성 경로가 아니다. 실패하면 기존
 * 프리페치·풀생성 폴백이 그대로 매치를 완주시킨다.
 */
@Service
public class DeckPrewarmService {

    private static final Logger log = LoggerFactory.getLogger(DeckPrewarmService.class);

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final DeckService deckService;
    private final DeckSnapshot deckSnapshot;
    private final PromptContextBuilder contextBuilder;
    private final AiJobQueue jobQueue;
    private final boolean enabled;

    public DeckPrewarmService(JdbcClient jdbcClient,
                              TxRunner txRunner,
                              DeckService deckService,
                              DeckSnapshot deckSnapshot,
                              PromptContextBuilder contextBuilder,
                              AiJobQueue jobQueue,
                              @Value("${hmb.prewarm.enabled}") boolean enabled) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.deckService = deckService;
        this.deckSnapshot = deckSnapshot;
        this.contextBuilder = contextBuilder;
        this.jobQueue = jobQueue;
        this.enabled = enabled;
    }

    /**
     * 덱이 저장됐다(PUT /api/deck · 튜토리얼 덱 지급). 그 덱의 A 를 지금 큐에 올린다.
     * 이미 같은 A 를 기다리고 있거나 done 이면 아무 일도 일어나지 않는다(멱등).
     */
    public void onDeckSaved(String userId) {
        if (!enabled) {
            return;
        }
        try {
            DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
            // 전술은 A 밖(#215 W2-B1) — 매치 스냅샷과 같은 직렬화를 쓰되 teamTactics 는 넣지 않는다.
            String deckJson = deckSnapshot.json(deck, null);
            PromptContextBuilder.BaseJob base =
                    contextBuilder.deckBaseJob(contextBuilder.readJson(deckJson));
            warm(userId, base);
        } catch (Exception e) {
            log.warn("덱 저장 선실행 실패(user {}) — 무시(킥오프 폴백이 소유): {}", userId, e.toString());
        }
    }

    /**
     * <b>한 트랜잭션</b>: 직전 잡 회수 → 원장 갱신 → 새 A enqueue. 셋이 쪼개지면 그 사이에
     * "회수는 됐는데 새 잡은 없는" 상태가 남에게 보이고, 그때 킥오프가 오면 폴백 풀생성으로 떨어진다.
     */
    private void warm(String userId, PromptContextBuilder.BaseJob base) {
        txRunner.run(() -> {
            // 직전 값 읽기도 트랜잭션 안이다 — 같은 유저의 동시 저장 2건이 tx 밖에서 같은 previous 를
            // 읽으면 한쪽의 새 잡이 회수되지 않고 고아로 남는다(독립검증 F5).
            String previous = currentBaseId(userId);
            if (base.baseId().equals(previous)) {
                reviveIfDead(base);   // 같은 덱인데 잡이 실패로 굳었으면 되살린다(F3)
                jobQueue.enqueueBase(base.baseId(), base.context()); // 행이 사라졌으면 재삽입(멱등)
                return null;
            }
            if (previous != null) {
                reclaim(previous, userId);
            }
            jdbcClient.sql("""
                            INSERT INTO deck_prewarm(user_id, base_id, updated_at) VALUES (?, ?, ?)
                            ON CONFLICT(user_id) DO UPDATE
                              SET base_id = excluded.base_id, updated_at = excluded.updated_at
                            """)
                    .params(userId, base.baseId(), Instant.now().toString())
                    .update();
            reviveIfDead(base);
            jobQueue.enqueueBase(base.baseId(), base.context());
            return null;
        });
    }

    /**
     * 이 유저가 <b>기다리는 중</b>인 A 를 원장에 기록만 한다(enqueue·회수 없음).
     *
     * <p>왜(독립검증 F2): 회수 보호는 원장 참조만 본다. 그런데 {@code prefetchBaseInputs}(매치 생성)가
     * 만든 A 는 원장에 흔적이 없어서, <b>V20 배포 직후 원장이 빈 기존 유저 전원</b>이 무방비였다 —
     * 같은 덱을 쓰는 다른 유저가 덱을 바꿔 저장하면 그 유저가 기다리던 A 가 지워져 풀생성 폴백으로
     * 떨어진다(= #215 의 원증상). 기다리는 사람은 전부 원장에 있어야 보호가 성립한다.
     *
     * <p>행이 이미 있으면 <b>덮지 않는다</b>. 유저가 매치 생성 후 덱을 새로 저장했다면 원장의 최신 행이
     * 옳고, 그걸 이 매치의 옛 base 로 되돌리면 정작 새 A 가 무방비가 된다.
     */
    public void noteWaiting(String userId, String baseId) {
        if (!enabled) {
            return;
        }
        try {
            jdbcClient.sql("""
                            INSERT INTO deck_prewarm(user_id, base_id, updated_at) VALUES (?, ?, ?)
                            ON CONFLICT(user_id) DO NOTHING
                            """)
                    .params(userId, baseId, Instant.now().toString())
                    .update();
        } catch (Exception e) {
            log.warn("prewarm 원장 기록 실패(user {}) — 무시: {}", userId, e.toString());
        }
    }

    /**
     * 같은 baseId 인데 잡이 {@code failed} 로 굳어 있으면 그 행을 지워 재큐잉이 가능하게 한다.
     *
     * <p>왜(독립검증 F3): {@code enqueueBase} 는 {@code INSERT OR IGNORE} 이고 회수는 {@code queued} 만
     * 지운다. 그래서 A 가 영구 실패하면 <b>같은 덱을 다시 저장해도</b> 되살아나지 않아 그 덱은 영영
     * 폴백이었다. 덱 저장이 A 의 주 트리거가 된 지금은 유저가 스스로 복구할 수단이 이것뿐이다.
     */
    private void reviveIfDead(PromptContextBuilder.BaseJob base) {
        int revived = jdbcClient.sql("""
                        DELETE FROM ai_jobs WHERE id = ? AND match_id IS NULL AND status = 'failed'
                        """)
                .param(base.baseId())
                .update();
        if (revived > 0) {
            log.info("실패로 굳은 A 를 덱 저장이 되살린다(base {})", base.baseId());
        }
    }

    private String currentBaseId(String userId) {
        return jdbcClient.sql("SELECT base_id FROM deck_prewarm WHERE user_id = ?")
                .param(userId).query(String.class).optional().orElse(null);
    }

    /**
     * 직전 A 회수 — 조건이 하나라도 안 맞으면 <b>그냥 남긴다</b>(0행 삭제). 남은 행은 무해하다:
     * queued 면 워커가 언젠가 처리해 캐시가 되고, done 이면 이미 캐시다.
     */
    private void reclaim(String previousBaseId, String userId) {
        int removed = jdbcClient.sql("""
                        DELETE FROM ai_jobs
                        WHERE id = ? AND match_id IS NULL AND status = 'queued' AND attempts = 0
                          AND NOT EXISTS (
                            SELECT 1 FROM deck_prewarm WHERE base_id = ? AND user_id <> ?
                          )
                        """)
                .params(previousBaseId, previousBaseId, userId)
                .update();
        if (removed > 0) {
            log.debug("덱 재저장 — 미배포 A 회수(user {} base {})", userId, previousBaseId);
        }
    }
}
