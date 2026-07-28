package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import jakarta.annotation.Resource;
import online.hmb.away.AwayService;
import online.hmb.match.MatchService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #245 — 원정 후보 루프가 <b>내 매치 생성 실패까지 삼키지 않는다</b>.
 *
 * <p>왜 별도 클래스에 목(mock)까지 쓰나: 이 성질은 {@code createAwayMatch} 가 <b>덱이 아닌 이유로</b>
 * 실패할 때만 관측된다. 그런 실패(봇 조회·컨디션 계산·INSERT 경합)는 블랙박스 HTTP 테스트로 결정론적
 * 재현이 안 되고, 그래서 4R blocker 를 고친 뒤에도 "매치 생성을 루프 안으로 되돌리는" 변이가
 * <b>전 스위트를 통과했다</b>(독립검증 5R BL-1 — 나는 그걸 죽었다고 잘못 기록했다).
 *
 * <p>루프가 삼켜도 되는 것은 <b>그 후보를 세울 수 없다</b>는 실패뿐이다. 내 쪽 실패를 삼키면
 * ①에러가 404 NO_OPPONENT 으로 뒤집혀 "상대가 없다"는 거짓말이 되고 ②후보 수만큼 고스트가 구워진다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AwayLoopFailurePropagationTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    /** 매치 생성만 실패시키는 시임 — 나머지(덱 검증·고스트 굽기)는 실물 그대로다. */
    @MockBean
    private MatchService matchService;

    @Resource
    private AwayService awayService;

    @Resource
    private JdbcClient jdbc;

    @Test
    void ownMatchCreationFailureIsNotSwallowedAsNoOpponent() {
        setupUserWithDeck("loop_def1");
        setupUserWithDeck("loop_def2");
        setupUserWithDeck("loop_def3");
        setupUserWithDeck("loop_atk");
        String attackerId = jdbc.sql("SELECT id FROM users WHERE nickname = 'loop_atk'")
                .query(String.class).single();

        // ⚠️ **ApiException** 으로 던진다. 루프의 catch 가 ApiException 이라 그 계열만 삼켜지고,
        // 실제로 createAwayMatch 가 던지는 것도 그 계열이다(덱 재검증 DECK_INVALID · 봇 조회 NOT_FOUND).
        // RuntimeException 으로 던지면 좁은 catch 를 그냥 지나쳐 계약이 성립하지 않는다.
        when(matchService.createAwayMatch(anyString(), anyString(), anyString()))
                .thenThrow(online.hmb.common.ApiException.notFound("boom — 덱과 무관한 실패"));

        long ghostsBefore = ghostRows();

        assertThatThrownBy(() -> awayService.start(attackerId, null))
                .as("내 쪽 실패가 '상대가 없다'로 뒤집히면 유저는 고칠 수 없는 문제를 본다")
                .isInstanceOf(online.hmb.common.ApiException.class)
                .hasMessageContaining("boom");

        assertThat(ghostRows() - ghostsBefore)
                .as("실패 1회가 후보 수만큼 고스트를 굽는다면 루프가 매치 생성까지 감싼 것이다")
                .isLessThanOrEqualTo(1);
    }

    private long ghostRows() {
        return jdbc.sql("SELECT COUNT(*) FROM bots WHERE id LIKE 'GHOST\\_%' ESCAPE '\\'")
                .query(Long.class).single();
    }
}
