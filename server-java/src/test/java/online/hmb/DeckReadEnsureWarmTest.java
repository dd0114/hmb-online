package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import online.hmb.jobs.AiJobQueue;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>활성 덱이 있으면 그 덱의 A(베이스)도 있다</b> — 상시 보증 (#402 W1 AC2).
 *
 * <p><b>왜</b>(라이브 실측, #402 W1): A 재생성 트리거가 {@code PUT /api/deck}(저장 이벤트) 하나뿐이라
 * <b>덱을 안 건드리면 영영 복구가 안 된다</b>. 라이브 활성덱 보유 유저 61명 중 <b>36명(59%)</b> 이
 * 현재 덱의 A 를 아예 갖고 있지 않았다 — 전원 마지막 덱 저장이 A 키 규약 v1→v2 범프(#324, 07-30)
 * 이전이거나 저장 이력이 없다. 그 유저들은 경기를 시작할 때마다 20~180초를 새로 만들어 기다린다.
 *
 * <p><b>해결</b>: 읽기 경로({@code GET /api/deck})가 <b>보증</b>을 건다. 규약이 바뀌든 카탈로그가
 * 바뀌든, 앱을 켜서 덱을 한 번 조회하면 그 덱의 A 가 채워진다.
 *
 * <p><b>핫 경로 규율</b>: 흔한 경우(A 가 이미 있고 failed 가 아니며 원장도 그 baseId 를 가리킴)에는
 * <b>DB 쓰기가 0</b> 이어야 한다 — 덱 조회는 화면 진입마다 일어난다. 여기서 매번 원장을 갱신하면
 * 조회가 쓰기가 되고, {@code deck_prewarm} 이 유저별 1행이라 write 경합까지 만든다.
 *
 * <p>실패는 전부 삼킨다 — 조회 응답을 절대 깨뜨리지 않는다(선실행은 최적화지 정합성 경로가 아니다).
 *
 * <p>박제하는 불변식: ① A 가 없으면 조회가 채운다 ② 이미 준비된 덱을 조회해도 <b>아무것도 안 쓴다</b>
 * ③ failed 로 굳은 A 는 조회가 되살린다(봇·고스트가 아니라 유저 A 의 자가 복구) ④ 조회가 채운 A 를
 * 킥오프가 그대로 쓴다(같은 키) ⑤ 덱이 없는 유저의 조회는 404 그대로, 잡도 안 만든다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class DeckReadEnsureWarmTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    @Resource
    private AiJobQueue jobQueue;

    @BeforeEach
    void clearPrewarmLedger() {
        jdbcClient.sql("DELETE FROM deck_prewarm").update();
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private void saveDeck(String token, String twist) {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(i == 11 && twist != null
                    ? slot(String.format("P%03d", i), "starter", i - 1, twist)
                    : slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        assertThat(authPut("/api/deck", token, deckBody("4-4-2", slots), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    private void getDeck(String token, HttpStatus expected) {
        assertThat(authGet("/api/deck", token, Map.class).getStatusCode()).isEqualTo(expected);
    }

    private long baseRows() {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL")
                .query(Long.class).single();
    }

    private String ledgerBaseId(String nickname) {
        return jdbcClient.sql("SELECT base_id FROM deck_prewarm WHERE user_id = ?")
                .param(userIdOf(nickname)).query(String.class).optional().orElse(null);
    }

    private String ledgerUpdatedAt(String nickname) {
        return jdbcClient.sql("SELECT updated_at FROM deck_prewarm WHERE user_id = ?")
                .param(userIdOf(nickname)).query(String.class).optional().orElse(null);
    }

    private String jobUpdatedAt(String baseId) {
        return jdbcClient.sql("SELECT updated_at FROM ai_jobs WHERE id = ?")
                .param(baseId).query(String.class).single();
    }

    /** 큐에 있는 A 를 done 으로 만든다(워커 완주 시뮬레이션). */
    private void completeBase(String baseId) {
        jdbcClient.sql("""
                        UPDATE ai_jobs SET status = 'done', result_json = ?, updated_at = ?
                        WHERE id = ?
                        """)
                .params("{\"team\":{},\"players\":{}}", "2026-01-01T00:00:00Z", baseId)
                .update();
    }

    /**
     * <b>07-30 이전에 마지막으로 덱을 저장한 유저</b>(라이브 36/61)를 재현한다: 활성 덱은 있는데
     * 그 덱의 A 는 어디에도 없다(키 규약 범프로 무효화됐거나 저장 이력이 없다).
     */
    private void forgetEverythingWarmed() {
        jdbcClient.sql("DELETE FROM ai_jobs WHERE match_id IS NULL").update();
        jdbcClient.sql("DELETE FROM deck_prewarm").update();
    }

    // ── ① 없으면 채운다 ─────────────────────────────────────────────────

    /**
     * <b>이 테스트가 라이브 결함을 박제한다.</b> 덱 저장 이벤트 없이도 조회 한 번이면 A 가 선다 —
     * 이게 없으면 키 규약이 바뀐 뒤 덱을 안 건드린 유저는 <b>영영</b> 매 경기 풀생성이다.
     */
    @Test
    void readingTheDeckWarmsAMissingBase() {
        String token = setupUserWithDeck("ensure_missing");
        forgetEverythingWarmed();
        assertThat(baseRows()).isZero();

        getDeck(token, HttpStatus.OK);

        assertThat(baseRows()).as("조회가 그 덱의 A 를 채운다").isEqualTo(1L);
        assertThat(ledgerBaseId("ensure_missing")).as("원장도 그 A 를 가리킨다").isNotNull();
        assertThat(jobQueue.find(ledgerBaseId("ensure_missing")).orElseThrow().status())
                .isEqualTo("queued");
    }

    // ── ② 이미 준비돼 있으면 아무것도 안 쓴다(핫 경로) ──────────────────────

    /**
     * 덱 조회는 화면 진입마다 일어난다 — 이미 A 가 있는 흔한 경우에 <b>쓰기가 0</b> 이어야 한다.
     * (직접 관측할 수 있는 것은 "무엇이 바뀌었나"이므로, 이 경로가 건드릴 수 있는 모든 값
     * — 잡 행 수·잡 {@code updated_at}·원장 {@code base_id}/{@code updated_at} — 이 그대로임을 본다.)
     */
    @Test
    void readingAnAlreadyWarmDeckWritesNothing() {
        String token = setupUserWithDeck("ensure_hot");
        String baseId = ledgerBaseId("ensure_hot");
        completeBase(baseId);
        String jobStamp = jobUpdatedAt(baseId);
        String ledgerStamp = ledgerUpdatedAt("ensure_hot");
        long rows = baseRows();

        getDeck(token, HttpStatus.OK);
        getDeck(token, HttpStatus.OK);
        getDeck(token, HttpStatus.OK);

        assertThat(baseRows()).isEqualTo(rows);
        assertThat(jobUpdatedAt(baseId)).as("잡을 다시 쓰지 않는다").isEqualTo(jobStamp);
        assertThat(ledgerBaseId("ensure_hot")).isEqualTo(baseId);
        assertThat(ledgerUpdatedAt("ensure_hot")).as("원장을 다시 쓰지 않는다").isEqualTo(ledgerStamp);
        assertThat(jobQueue.find(baseId).orElseThrow().status()).isEqualTo("done");
    }

    // ── ③ failed 로 굳은 A 는 조회가 되살린다 ──────────────────────────────

    /**
     * A 가 영구 실패(주간 한도·일시 API 오류)로 굳으면 그 덱은 계속 폴백이다. 되살림 트리거가
     * "같은 덱 재저장"뿐이면 유저는 자기가 뭘 해야 하는지 알 수 없다 — 조회가 그걸 대신한다.
     */
    @Test
    void readingTheDeckRevivesABaseThatDiedAsFailed() {
        String token = setupUserWithDeck("ensure_revive");
        String baseId = ledgerBaseId("ensure_revive");
        jdbcClient.sql("UPDATE ai_jobs SET status = 'failed' WHERE id = ?").param(baseId).update();

        getDeck(token, HttpStatus.OK);

        assertThat(jobQueue.find(baseId).orElseThrow().status())
                .as("실패로 굳은 A 가 조회 한 번으로 다시 큐에 선다")
                .isEqualTo("queued");
    }

    // ── ④ 조회가 채운 A 를 킥오프가 쓴다 ─────────────────────────────────

    /** 채우는 것만으로는 부족하다 — 그 A 가 <b>킥오프가 찾는 바로 그 키</b>여야 의미가 있다. */
    @Test
    void theBaseWarmedByReadingIsTheOneTheMatchLooksUp() {
        String token = setupUserWithDeck("ensure_kick");
        forgetEverythingWarmed();
        getDeck(token, HttpStatus.OK);
        String warmed = ledgerBaseId("ensure_kick");
        completeBase(warmed);

        createMatch(token, "BOT_BAL"); // 프리페치가 유저 A 를 다시 만들면 키가 다른 것이다

        assertThat(jobQueue.find(warmed).orElseThrow().status()).isEqualTo("done");
        assertThat(jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id IS NULL AND id <> ?
                        """).param(warmed).query(Long.class).single())
                .as("새로 뜬 A 는 봇 것 하나뿐 — 유저 A 는 조회가 채운 그 키다")
                .isEqualTo(1L);
    }

    // ── ⑤ 덱이 없는 유저 — 응답을 깨뜨리지 않는다 ─────────────────────────

    @Test
    void readingWithoutADeckStillReturnsNotFoundAndWarmsNothing() {
        String token = login("ensure_nodeck");

        getDeck(token, HttpStatus.NOT_FOUND);

        assertThat(baseRows()).isZero();
        assertThat(ledgerBaseId("ensure_nodeck")).isNull();
    }
}
