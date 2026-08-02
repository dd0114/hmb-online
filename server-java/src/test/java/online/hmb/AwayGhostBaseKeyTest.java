package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import online.hmb.match.BotService;
import online.hmb.match.MatchService;
import online.hmb.match.PromptContextBuilder;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 원정 고스트의 A(베이스) 키를 <b>수비자 본인의 A 키와 일치시킨다</b> — #402 W1 AC1.
 *
 * <p><b>왜</b>(라이브 실측, #402 W1): 원정 상대는 실유저 덱을 복사해 구운 고스트 봇이다
 * ({@code AwayService.bakeGhost}). 수비자는 덱 저장 시점(#215)에 자기 A 를 이미 만들어 뒀는데,
 * 고스트로 조회하는 A 키는 <b>팀 지시문 자리 하나</b>만 달라서 그걸 못 찾고 매번 풀생성(20~180초)했다:
 * <ul>
 *   <li>수비자 A({@code deckBaseJob}) → 팀 지시문 = <b>덱 팀 문장</b>(#253)</li>
 *   <li>고스트 A({@code botBaseJob}) → 팀 지시문 = <b>{@code bot.persona()}</b>, 그런데
 *       {@code bakeGhost} 는 persona 를 {@code ""} 로 굽는다</li>
 * </ul>
 * 라이브 증거: 수비자 A {@code e9fd174cb8523c1d…} 가 2026-07-31T03:17:58Z 부터 done 이었는데
 * 08-01·08-02 원정 3건이 못 찾고 58초/96초/23초를 새로 만들었다. 팀 지시문 자리만 덱 값으로 바꿔
 * 조회하니 3건 전부 즉시 done 이 나왔다.
 *
 * <p><b>규약</b>: 봇 덱 JSON 에 {@code teamPrompt} 필드가 <b>있으면</b> 그 값이 팀 지시문이고
 * (= {@code deckBaseJob(봇덱)} 과 같은 산출), <b>없으면</b> 종전대로 {@code bot.persona()} 다.
 * 고스트 덱은 {@code DeckSnapshot.json} 이 만들고 그 함수는 덱 팀 문장이 non-blank 일 때만 필드를
 * 넣으므로, 리그봇·시드봇(덱 JSON 에 그 필드가 없다)은 <b>무영향</b>이다.
 *
 * <p>키만 맞추는 게 아니라 <b>봇이 AI 프롬프트로 받는 팀 지시문도 같은 값</b>이어야 한다 — 재사용된
 * 결과와 프롬프트가 어긋나면 "캐시는 맞았는데 내용이 다른" 상태가 된다. (hero 승인: 고스트가
 * 수비자의 팀 지시대로 싸우는 것이 의도다.)
 *
 * <p>박제하는 불변식: ① 팀 문장이 있는 덱 → 고스트 A id == 수비자 A id ② 팀 문장이 없는 덱도 동일
 * (무회귀) ③ 고스트 A 컨텍스트의 teamPrompt = 수비자 덱 문장 ④ 고스트 <b>풀 컨텍스트</b>도 같은 값
 * ⑤ 시드봇(덱에 teamPrompt 필드 없음)은 종전대로 persona 를 쓴다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class AwayGhostBaseKeyTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    @Resource
    private online.hmb.away.AwayService awayService;

    @Resource
    private PromptContextBuilder contextBuilder;

    @Resource
    private BotService botService;

    @Resource
    private MatchService matchService;

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private static List<Map<String, Object>> starters11PlusBench(String twist) {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(i == 11 && twist != null
                    ? slot(String.format("P%03d", i), "starter", i - 1, twist)
                    : slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        return slots;
    }

    /** 덱 저장 — {@code teamPrompt} 가 null 이면 필드를 아예 싣지 않는다(팀 문장 없는 덱). */
    private void saveDeck(String token, String teamPrompt, String twist) {
        Map<String, Object> body = new HashMap<>();
        body.put("formation", "4-4-2");
        body.put("slots", starters11PlusBench(twist));
        if (teamPrompt != null) {
            body.put("teamPrompt", teamPrompt);
        }
        assertThat(authPut("/api/deck", token, body, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    /** 이 유저가 덱 저장 선실행으로 만든 A 의 id(= 수비자 본인 A 키). */
    private String prewarmBaseId(String nickname) {
        return jdbcClient.sql("SELECT base_id FROM deck_prewarm WHERE user_id = ?")
                .param(userIdOf(nickname)).query(String.class).single();
    }

    /**
     * 상대를 고정해 원정을 시작한다(AwayRaidTest 와 같은 시임) — 지목은 공개 API 에 없으므로
     * 서버가 그 상대를 제시한 상태를 만들어 놓고 서비스로 부른다.
     */
    private MatchService.MatchRow startAwayPinned(String attackerId, String defenderId) {
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(attackerId, "[\"" + defenderId + "\"]", java.time.Instant.now().toString())
                .update();
        return awayService.start(attackerId, defenderId);
    }

    private PromptContextBuilder.BaseJob ghostBaseOf(MatchService.MatchRow match) {
        return contextBuilder.botBaseJob(match, botService.get(match.botId()));
    }

    // ── ①③ 팀 문장이 있는 덱 — 라이브 미스의 정체 ──────────────────────────

    /**
     * <b>이 테스트가 라이브 버그를 박제한다.</b> 수비자가 팀 문장을 쓴 덱을 저장해 A 를 만들어 뒀다면,
     * 그 사람에게 원정을 갈 때 고스트가 조회하는 A 는 <b>같은 id</b> 여야 한다(= 이미 done 인 캐시를
     * 그대로 쓴다). 수정 전에는 팀 지시문 자리가 {@code ""}(고스트 persona) 라서 절대 안 맞았다.
     */
    @Test
    void aGhostLooksUpTheSameBaseAsItsDefenderWhenTheDeckHasATeamPrompt() {
        String defender = setupOpponentWithDeck("ghostkey_def");
        saveDeck(defender, "골좀넣어줘 제발", "고스트키_수비자");
        String defenderBase = prewarmBaseId("ghostkey_def");

        String attacker = setupUserWithDeck("ghostkey_atk");
        assertThat(attacker).isNotNull();
        MatchService.MatchRow match = startAwayPinned(userIdOf("ghostkey_atk"), userIdOf("ghostkey_def"));

        PromptContextBuilder.BaseJob ghost = ghostBaseOf(match);
        assertThat(ghost.baseId())
                .as("고스트 A 키 = 수비자가 이미 만들어 둔 A 키 — 아니면 매번 20~180초 풀생성이다")
                .isEqualTo(defenderBase);
        assertThat(ghost.context().get("teamPrompt"))
                .as("재사용된 결과와 프롬프트가 어긋나면 안 된다 — 고스트도 그 팀 지시로 싸운다")
                .isEqualTo("골좀넣어줘 제발");
    }

    /** ④ A 잡뿐 아니라 <b>풀생성 컨텍스트</b>(폴백 경로)도 같은 팀 지시문을 받아야 어긋나지 않는다. */
    @Test
    void theGhostFullContextCarriesTheDefendersTeamPromptToo() {
        String defender = setupOpponentWithDeck("ghostctx_def");
        saveDeck(defender, "수비 라인을 끌어올려라", "고스트컨텍스트");
        setupUserWithDeck("ghostctx_atk");
        MatchService.MatchRow match =
                startAwayPinned(userIdOf("ghostctx_atk"), userIdOf("ghostctx_def"));

        Map<String, Object> context =
                contextBuilder.buildBotContext(match, 1, botService.get(match.botId()), null);

        assertThat(context.get("teamPrompt")).isEqualTo("수비 라인을 끌어올려라");
    }

    // ── ② 팀 문장이 없는 덱 — 무회귀 ──────────────────────────────────────

    /**
     * 팀 문장이 없는 덱은 {@code DeckSnapshot} 이 필드 자체를 생략하므로 고스트도 폴백(persona="")
     * 을 쓰고, 수비자 A 의 팀 지시문도 {@code ""} 다 → 원래 맞았고 <b>계속 맞아야</b> 한다.
     */
    @Test
    void aGhostAlsoMatchesItsDefenderWhenTheDeckHasNoTeamPrompt() {
        String defender = setupOpponentWithDeck("gk_plain_def");
        saveDeck(defender, null, "고스트키_문장없음");
        String defenderBase = prewarmBaseId("gk_plain_def");

        setupUserWithDeck("gk_plain_atk");
        MatchService.MatchRow match =
                startAwayPinned(userIdOf("gk_plain_atk"), userIdOf("gk_plain_def"));

        assertThat(ghostBaseOf(match).baseId()).isEqualTo(defenderBase);
        assertThat(ghostBaseOf(match).context().get("teamPrompt")).isEqualTo("");
    }

    // ── ⑤ 리그봇·시드봇 무영향 ───────────────────────────────────────────

    /**
     * 덱 JSON 에 {@code teamPrompt} 필드가 없는 봇(시드봇·리그봇 — 라이브 {@code bots} 전수 확인)은
     * 종전대로 {@code persona} 를 팀 지시문으로 쓴다. 이 폴백이 없어지면 모든 봇의 A 키가 한꺼번에
     * 바뀌어(=라이브 캐시 전멸) 회귀가 된다.
     */
    @Test
    void seedBotsStillUseTheirPersonaAsTeamPrompt() {
        String token = setupUserWithDeck("ghostkey_seedbot");
        String matchId = createMatch(token, "BOT_BAL");
        MatchService.MatchRow match = matchService.find(matchId).orElseThrow();
        BotService.BotRow bot = botService.get("BOT_BAL");
        assertThat(bot.persona()).isNotBlank();

        assertThat(contextBuilder.botBaseJob(match, bot).context().get("teamPrompt"))
                .isEqualTo(bot.persona());
    }
}
