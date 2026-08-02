package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.growth.GrowthService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>정산 모델 교체 계약</b>(#405 W2b, 설계 §2.4) — 경기 정산은 <b>카드 XP</b>만 쌓고 스탯은
 * 건드리지 않는다. 스탯이 오르는 유일한 경로는 <b>유저의 선택</b>이다.
 *
 * <p>왜 이게 계약이어야 하나: 구 모델(V10)은 정산이 스탯별 XP 를 자동 적립해 <b>자동으로</b>
 * 레벨업시켰다. 개편의 내용이 정확히 그것을 걷어내는 것이라, "안 오른다"를 기계가 지키지 않으면
 * 구 경로가 조용히 남아 두 모델이 동시에 돈다(= 유저 스탯이 두 배로 오른다).
 *
 * <p>기대값을 {@code GrowthTuning} 에서 다시 읽지 않는다 — 여기 단언은 전부 <b>구조적 성질</b>
 * ("안 움직인다" · "레벨당 한 행" · "재정산해도 안 늘어난다")이라 계수가 바뀌어도 유효하다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class GrowthCardLevelSettlementTest extends MatchTestBase {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final List<String> STARTERS = List.of("P001", "P002", "P003", "P004", "P005",
            "P006", "P007", "P008", "P009", "P010", "P011");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private GrowthService growthService;

    /**
     * <b>계약 3 — 경기 정산만으로는 어떤 스탯도 오르지 않는다.</b> 정산 전후의 유효스탯 9종이
     * 전부 같아야 한다(선택을 해야 오른다).
     */
    @Test
    void settlementAloneRaisesNoStat() {
        String token = setupUserWithDeck("gc_nostat");
        String userId = userIdOf("gc_nostat");
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");

        Map<?, ?> before = (Map<?, ?>) growthService.cardEffective(userId, "P001").get("attributes");
        growthService.settleMatch(matchId, userId, STARTERS, List.of(), Set.of(), Set.of(), true, "WIN");
        Map<?, ?> after = (Map<?, ?>) growthService.cardEffective(userId, "P001").get("attributes");

        assertThat(after)
                .as("정산이 스탯을 올렸다 — 자동 상승 경로가 살아 있다(개편이 걷어내려던 것)")
                .isEqualTo(before);
    }

    /** 대신 <b>카드 XP</b> 는 쌓인다 — "아무 일도 안 일어난다"와 구분한다(공허한 계약 방지). */
    @Test
    void settlementAccruesCardXpAndGrantsOneChoicePerLevel() {
        String token = setupUserWithDeck("gc_xp");
        String userId = userIdOf("gc_xp");
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");

        growthService.settleMatch(matchId, userId, STARTERS, List.of(), Set.of(), Set.of(), true, "WIN");

        int level = cardLevel(userId, "P001");
        assertThat(level).as("선발 한 경기로 레벨이 하나도 안 오르면 XP 곡선이 소비되지 않는 것이다")
                .isGreaterThan(1);
        assertThat(choiceLevels(userId, "P001"))
                .as("레벨업 N 회 = 선택권 N 개(레벨마다 한 행)")
                .containsExactlyElementsOf(java.util.stream.IntStream.range(1, level).boxed().toList());
    }

    /** 계약 6 — 같은 매치를 재정산해도 XP·선택권이 늘지 않는다. */
    @Test
    void resettlingTheSameMatchAddsNothing() {
        String token = setupUserWithDeck("gc_idem");
        String userId = userIdOf("gc_idem");
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");

        growthService.settleMatch(matchId, userId, STARTERS, List.of(), Set.of(), Set.of(), true, "WIN");
        int level = cardLevel(userId, "P001");
        int xp = cardXp(userId, "P001");
        long choices = choiceCount(userId);

        growthService.settleMatch(matchId, userId, STARTERS, List.of(), Set.of(), Set.of(), true, "WIN");

        assertThat(cardLevel(userId, "P001")).isEqualTo(level);
        assertThat(cardXp(userId, "P001")).isEqualTo(xp);
        assertThat(choiceCount(userId)).isEqualTo(choices);
    }

    /** 정산에 쓴 계수 리비전이 리포트에 박제된다 — "어떤 값으로 정산했나"가 사후에 답해져야 한다. */
    @Test
    void reportSnapshotPinsTheTuningRevision() {
        String token = setupUserWithDeck("gc_rev");
        String userId = userIdOf("gc_rev");
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");

        growthService.settleMatch(matchId, userId, STARTERS, List.of(), Set.of(), Set.of(), true, "DRAW");

        String reportJson = jdbcClient.sql("""
                        SELECT report_json FROM growth_applied
                        WHERE match_id=? AND user_id=? AND player_id='P001'
                        """)
                .params(matchId, userId).query(String.class).single();
        assertThat(reportJson).isNotNull();
        try {
            assertThat(MAPPER.readTree(reportJson).has("tuningRevisionId"))
                    .as("정산 리포트에 계수 리비전이 없으면 사후 추적이 불가능하다").isTrue();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private int cardLevel(String userId, String playerId) {
        return jdbcClient.sql("SELECT card_level FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(Integer.class).single();
    }

    private int cardXp(String userId, String playerId) {
        return jdbcClient.sql("SELECT card_xp FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(Integer.class).single();
    }

    private List<Integer> choiceLevels(String userId, String playerId) {
        return jdbcClient.sql("""
                        SELECT level FROM growth_level_choices
                        WHERE user_id=? AND player_id=? ORDER BY level
                        """)
                .params(userId, playerId).query(Integer.class).list();
    }

    private long choiceCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM growth_level_choices WHERE user_id=?")
                .param(userId).query(Long.class).single();
    }
}
