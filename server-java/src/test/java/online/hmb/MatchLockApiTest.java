package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #217 매치 잠금·재입장 — AC1(재입장 진입점) · AC2(잠금 범위)의 계약.
 *
 * <p>여기서 박제하는 건 "409 가 난다"가 아니라 <b>어디까지 잠그고 어디는 안 잠그는가</b>다. 범위는
 * 이슈 STATE §2 의 근거표 그대로: 새 매치 생성은 ACTIVE 전체, 로스터·유효스탯을 바꾸는 쓰기는
 * LOCKED(=킥오프 이후), 그 밖(뽑기·브리핑 중 덱 편집)은 <b>열려 있어야 한다</b>. 과잉 잠금도 회귀다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MatchLockApiTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // 배경 스위퍼가 이 테스트의 강제 상태를 회수해 버리지 않게(주제는 잠금이지 회수가 아니다).
        registry.add("hmb.match.abandon.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
    }

    private String token;

    @BeforeEach
    void setup() {
        // 클래스 단위 DB 공유 — 앞 테스트가 남긴 미완 매치가 다음 테스트의 잠금 판정을 오염시킨다.
        // ⚠️ setupUserWithDeck 보다 **먼저** 돌아야 한다: 그 안의 PUT /api/deck 자체가 이제 잠금 대상이다.
        jdbcClient.sql("UPDATE matches SET state = 'FINISHED' WHERE state NOT IN ('FINISHED','ABANDONED')")
                .update();
        token = setupUserWithDeck("m_lock");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> activeMatch() {
        ResponseEntity<Map> res = authGet("/api/me/active-match", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    // ── AC1: 재입장 진입점 ──────────────────────────────────────────────

    @Test
    void activeMatchIsNullWhenNothingIsInFlight() {
        Map<String, Object> body = activeMatch();
        assertThat(body.get("match")).isNull();
        assertThat(body.get("locked")).isEqualTo(false);
        assertThat(body.get("abandonable")).isEqualTo(false);
    }

    @Test
    @SuppressWarnings("unchecked")
    void briefingMatchIsActiveButNotLocked() {
        String matchId = createMatch(token, null);

        Map<String, Object> body = activeMatch();
        Map<String, Object> match = (Map<String, Object>) body.get("match");
        assertThat(match).isNotNull();
        assertThat(match.get("id")).isEqualTo(matchId);
        assertThat(match.get("state")).isEqualTo("BRIEFING");
        // 브리핑은 아직 킥오프 전 — 강제 재입장 대상이 아니다(로비에서 "이어하기" 안내만).
        assertThat(body.get("locked")).isEqualTo(false);
        assertThat(body.get("abandonable")).isEqualTo(true);
    }

    /**
     * 재입장은 "매치 ID 를 돌려준다"로 끝나지 않는다 — 응답이 {@code MatchDetail} 통짜여야 web 이
     * 한 번의 요청으로 {@code clock} 을 받아 seek-to-now(#170)를 그대로 태운다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void activeMatchCarriesTheFullDetailIncludingTheLiveClock() {
        String matchId = createMatch(token, null);
        forceState(matchId, "FIRST_HALF");
        String now = online.hmb.match.MatchClockService.format(java.time.Instant.now());
        String ends = online.hmb.match.MatchClockService.format(
                java.time.Instant.now().plusSeconds(120));
        jdbcClient.sql("UPDATE matches SET kickoff_at = ?, phase_start_at = ?, phase_ends_at = ? WHERE id = ?")
                .params(now, now, ends, matchId).update();

        Map<String, Object> body = activeMatch();
        Map<String, Object> match = (Map<String, Object>) body.get("match");
        assertThat(match.get("id")).isEqualTo(matchId);
        assertThat(body.get("locked")).isEqualTo(true);
        Map<String, Object> clock = (Map<String, Object>) match.get("clock");
        assertThat(clock).as("seek-to-now 를 태우려면 창(phase/ends/serverNow)이 같이 와야 한다").isNotNull();
        assertThat(clock.get("phase")).isEqualTo("FIRST_HALF");
        assertThat(clock.get("phaseEndsAt")).isEqualTo(ends);
        assertThat(clock.get("serverNow")).isNotNull();
    }

    /** 남의 매치는 내 잠금이 아니다(잠금 판정이 user_id 로 격리돼 있는지). */
    @Test
    void anotherUsersLiveMatchDoesNotLockMe() {
        String other = setupUserWithDeck("m_lock_other");
        String otherMatch = createMatchAs(other);
        forceState(otherMatch, "FIRST_HALF");

        assertThat(activeMatch().get("match")).isNull();
        ResponseEntity<Map> created = authPost("/api/matches", token, Map.of(), Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    // ── AC2: 새 매치 생성 차단 (ACTIVE 전체) ────────────────────────────

    @ParameterizedTest(name = "state={0} 에서는 새 매치 생성이 409 다")
    @ValueSource(strings = {"BRIEFING", "GEN1", "FIRST_HALF", "HALFTIME", "GEN2", "SECOND_HALF", "FAILED"})
    @SuppressWarnings("unchecked")
    void createIsBlockedWhileAnyMatchIsUnfinished(String state) {
        String matchId = createMatch(token, null);
        forceState(matchId, state);

        ResponseEntity<Map> res = authPost("/api/matches", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");
        // 빈 손 409 는 유저를 막다른 길에 세운다 — 어느 매치로 가야 하는지 반드시 실어야 한다.
        Map<String, Object> detail = (Map<String, Object>) res.getBody().get("detail");
        assertThat(detail.get("matchId")).isEqualTo(matchId);
        assertThat(detail.get("state")).isEqualTo(state);
    }

    @ParameterizedTest(name = "state={0} 은 끝난 매치라 새 매치를 막지 않는다")
    @ValueSource(strings = {"FINISHED", "ABANDONED"})
    void createIsAllowedOnceTheMatchIsTerminal(String state) {
        String matchId = createMatch(token, null);
        forceState(matchId, state);

        ResponseEntity<Map> res = authPost("/api/matches", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(activeMatch()).extracting(b -> ((Map<String, Object>) b.get("match")).get("id"))
                .isNotEqualTo(matchId);
    }

    // ── AC2: 메타 쓰기 잠금 (LOCKED = 킥오프 이후) ──────────────────────

    @Test
    void deckEditIsBlockedOnceTheMatchHasKickedOff() {
        String matchId = createMatch(token, null);
        forceState(matchId, "FIRST_HALF");

        ResponseEntity<Map> res = authPut("/api/deck", token, deckBody("4-4-2", defaultSlots()), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");
    }

    /**
     * 프리셋 적용은 활성 덱 통짜 덮어쓰기다 = PUT /api/deck 과 같은 쓰기.
     * (독립검증 MAJOR-2: 이 가드가 계약 문서·openapi 에는 있는데 테스트가 없어 뮤테이션이 생존했다.)
     */
    @Test
    void teamPresetApplyIsBlockedOnceTheMatchHasKickedOff() {
        // 슬롯을 채워 둔다 — 빈 슬롯 404 가 잠금 409 를 가려서 통과하는 거짓 green 을 막는다.
        ResponseEntity<Map> saved = authPut("/api/presets/team/1", token,
                Map.of("name", "기본", "formation", "4-4-2",
                        "starters", startersSnapshot(), "bench", benchSnapshot()),
                Map.class);
        assertThat(saved.getStatusCode()).as("프리셋 저장 선행").isEqualTo(HttpStatus.OK);

        String matchId = createMatch(token, null);
        // 브리핑에서는 열려 있다(덱 편집과 같은 대우).
        assertThat(authPost("/api/presets/team/1/apply", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        forceState(matchId, "FIRST_HALF");
        ResponseEntity<Map> res = authPost("/api/presets/team/1/apply", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");
    }

    /**
     * 잠금 이전 계정에는 미완 매치가 여럿 남아 있을 수 있다(V19 가 정리하지만 레이스·부분 롤백을
     * 가정한다). 그때 <b>어느 매치로 되돌릴지</b>가 재입장의 전부다 — 유저가 실제로 "안에 있는"
     * 매치(=이미 킥오프한 쪽)를 골라야 한다. 생성 시각만 보면 나중에 만든 브리핑이 이긴다.
     * (독립검증 MINOR-2: 이 우선순위를 뒤집어도 죽는 테스트가 없었다.)
     */
    @Test
    @SuppressWarnings("unchecked")
    void activeMatchPrefersTheKickedOffMatchOverANewerBriefing() {
        String live = createMatch(token, null);
        forceState(live, "FIRST_HALF");
        // 잠금을 우회해 직접 두 번째(더 최신) 브리핑 행을 만든다 — 레거시 계정 모양의 재현.
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, created_at)
                        SELECT 'M_LEGACY_BRIEF', user_id, bot_id, 'BRIEFING', seed, engine_version,
                               user_deck_json, mode, ?
                        FROM matches WHERE id = ?
                        """)
                .params(java.time.Instant.now().plusSeconds(60).toString(), live)
                .update();

        Map<String, Object> match = (Map<String, Object>) activeMatch().get("match");
        assertThat(match.get("id")).isEqualTo(live);
        assertThat(activeMatch().get("locked")).isEqualTo(true);
    }

    /**
     * <b>과잉 잠금 회귀 가드</b>: 브리핑 중 덱 편집은 킥오프 재캡처(AC-B2)가 명시적으로 지원하는
     * 기존 기능이다. 여기까지 잠그면 "브리핑에서 라인업을 고친다"가 통째로 죽는다.
     */
    @Test
    void deckEditStaysOpenDuringBriefing() {
        createMatch(token, null);

        ResponseEntity<Map> res = authPut("/api/deck", token, deckBody("4-3-3", defaultSlots()), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /**
     * 강화는 UX 취향이 아니라 <b>버그 차단</b>이다: MatchOrchestrator.buildSelectData 가 시뮬 시점에
     * effectiveAttributes 를 읽으므로, 하프타임에 성★를 올리면 같은 경기의 후반만 스탯이 오른다.
     */
    @Test
    void growthWritesAreBlockedWhileTheMatchIsLive() {
        String matchId = createMatch(token, null);
        forceState(matchId, "HALFTIME");

        ResponseEntity<Map> star = authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        assertThat(star.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(star.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");

        ResponseEntity<Map> dice = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "NORMAL"), Map.class);
        assertThat(dice.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(dice.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");
    }

    /** 트레이드 수락만 user_players 를 감소·삭제한다 = 진행 중 로스터에서 선수가 사라질 수 있다. */
    @Test
    void tradeAcceptIsBlockedWhileTheMatchIsLive() {
        String matchId = createMatch(token, null);
        forceState(matchId, "SECOND_HALF");

        ResponseEntity<Map> res = authPost("/api/trade/1/accept", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");
    }

    /**
     * <b>과잉 잠금 회귀 가드</b>: 뽑기는 카드/재화를 <b>추가만</b> 한다 — 진행 중 매치의 로스터·
     * 유효스탯에 영향이 0 이므로 잠그지 않는다. 여기가 409 로 바뀌면 "경기 중엔 아무것도 못 한다"는
     * 과잉 잠금이 들어온 것이다.
     */
    @Test
    void gachaStaysOpenWhileTheMatchIsLive() {
        String matchId = createMatch(token, null);
        forceState(matchId, "FIRST_HALF");

        ResponseEntity<Map> res = authPost("/api/shop/gacha", token, Map.of("count", 1), Map.class);
        assertThat(res.getStatusCode())
                .as("뽑기는 잠금 대상이 아니다(실패하더라도 MATCH_IN_PROGRESS 여선 안 된다)")
                .isNotEqualTo(HttpStatus.CONFLICT);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private String createMatchAs(String otherToken) {
        ResponseEntity<Map> res = authPost("/api/matches", otherToken, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) res.getBody().get("id");
    }

    /** 팀 프리셋 스냅샷(선발 11) — 덱과 같은 로스터라 apply 가 검증을 통과한다. */
    private static List<Map<String, Object>> startersSnapshot() {
        List<Map<String, Object>> out = new ArrayList<>();
        out.add(Map.of("playerId", "P001", "slotIndex", 0));
        for (int i = 2; i <= 11; i++) {
            out.add(Map.of("playerId", String.format("P%03d", i), "slotIndex", i - 1));
        }
        return out;
    }

    private static List<Map<String, Object>> benchSnapshot() {
        return List.of(Map.of("playerId", "P012", "slotIndex", 0),
                Map.of("playerId", "P013", "slotIndex", 1));
    }

    private static List<Map<String, Object>> defaultSlots() {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1));
        return slots;
    }
}
