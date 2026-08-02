package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.league.LeagueService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #328 — <b>디비전 표가 없는 폴백 경로</b>(league.v1)도 포메이션 형태를 지켜야 한다.
 *
 * <p><b>왜 이 테스트가 따로 필요한가</b>: #252 가 포지션 인지 샘플링을 넣으면서 계약
 * ({@code LeagueDivisionTest.botStartingElevenMatchesItsFormationShape})을 걸었지만, 그 테스트는
 * <b>league.v2(디비전 표 있음)</b> 로만 돈다. {@code LeagueService.sampleRoster} 는 첫 줄에서
 * {@code spec == null} 이면 {@code sampleRosterLegacy} 로 갈라지는데 <b>그 갈래엔 계약이 없었다</b> —
 * 그리고 그 갈래는 포지션을 아예 보지 않아 골키퍼가 필드 슬롯에 앉는다.
 *
 * <p><b>죽은 코드가 아니다.</b> {@code divisionSpec} 은 리그 발행물이 없거나 divisions 가 비면
 * null 을 돌려준다 — 배포에서 data 발행물이 빠지거나 v1 으로 롤백하는 순간 <b>새 시즌 전부</b>가
 * 이 경로로 태어난다. 화면엔 아무 신호가 없어서(라이브에선 hero 의 "수비가 이상하다" 체감으로만
 * 드러났다) 계약이 없으면 조용히 다시 샌다.
 *
 * <p><b>피해가 왜 큰가</b>: 엔진 {@code decision.ts} 의 GK 분기는 {@code basePosition} 을 <b>읽기 전에
 * 반환</b>하고 자기 골문 앞으로 간다. {@code isGK} 는 슬롯이 아니라 <b>포지션 문자열</b>로 판정되므로,
 * 필드 슬롯에 앉은 골키퍼는 그 자리를 쓰지 않고 골대에 붙는다 = 그 팀은 <b>10명 이하로 싸운다</b>.
 * 라이브 실측: 어웨이 GK 3명이 전 경기 x 평균 95~101(골라인 105) 에 상주.
 *
 * <p><b>실 카탈로그로 돈다</b>: 다른 리그 테스트의 17명 픽스처 카탈로그로는 10팀 로스터를
 * 포지션대로 채우는 것이 애초에 불가능해, 형태 단언이 카탈로그 부족과 구현 결함을 구분하지 못한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueLegacyRosterTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.3.json");
        // ⚠️ v1 = divisions 없음 → divisionSpec 이 null → **레거시 경로**. 이 한 줄이 이 테스트의 전부다.
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
        registry.add("hmb.data.bots-file", () -> "../data/players/bots.v3.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Test
    void legacyPathStillMatchesFormationShape() {
        String token = setupUserWithDeck("legacy-shape");
        String seasonId = startSeason(token);
        List<Map<String, Object>> bots = botDecksOf(seasonId);
        assertThat(bots).as("리그 봇 팀이 생성돼야").isNotEmpty();

        for (Map<String, Object> bot : bots) {
            JsonNode deck = readJson((String) bot.get("deck_json"));
            String formation = deck.path("formation").asText("4-4-2");
            List<String> expected = LeagueService.startingPositions(formation);
            List<String> actual = new ArrayList<>();
            for (JsonNode st : deck.path("starters")) {
                actual.add(positionOf(st.path("playerId").asText()));
            }
            assertThat(actual).as("%s 선발 11", bot.get("id")).hasSize(11);
            assertThat(actual).as("%s(%s) 선발 슬롯 포지션", bot.get("id"), formation).isEqualTo(expected);
        }
    }

    /**
     * 형태 단언과 <b>따로</b> 건다 — 위가 깨지는 방식은 여러 가지인데, 그중 <b>피치에서 실제로
     * 사람을 지우는 것</b>은 오직 "필드 슬롯의 골키퍼" 하나다. 폴백을 어떻게 완화하더라도
     * 이 선만은 넘지 않는다는 뜻으로 남긴다.
     */
    @Test
    void legacyPathNeverPutsAGoalkeeperInAnOutfieldSlot() {
        String token = setupUserWithDeck("legacy-gk");
        String seasonId = startSeason(token);
        for (Map<String, Object> bot : botDecksOf(seasonId)) {
            JsonNode deck = readJson((String) bot.get("deck_json"));
            List<String> starters = new ArrayList<>();
            for (JsonNode st : deck.path("starters")) {
                starters.add(positionOf(st.path("playerId").asText()));
            }
            assertThat(starters.get(0)).as("%s slot0 = GK", bot.get("id")).isEqualTo("GK");
            assertThat(starters.subList(1, starters.size()))
                    .as("%s 필드 슬롯 10칸에 골키퍼가 없어야(엔진이 골문에 세운다)", bot.get("id"))
                    .doesNotContain("GK");
        }
    }

    /**
     * 포지션이 <b>마른</b> 풀에서의 폴백 — 통합 테스트로는 못 밟는 분기라 직접 태운다.
     *
     * <p>실 카탈로그(DF 54·MF 62·FW 51)로도 픽스처 카탈로그(각 6)로도 정확 매치가 늘 성공해서,
     * 시즌을 돌리는 테스트만으로는 "포지션이 없을 때 무엇을 집는가"가 검증되지 않는다
     * (실제로 GK 배제 가드를 제거하는 변이체가 <b>살아남았다</b>). 그 자리를 여기서 덮는다.
     */
    @Test
    void whenPositionIsExhaustedTheFallbackStillNeverPicksAGoalkeeper() {
        // DF 를 요청하는데 풀엔 GK 와 MF 밖에 없다.
        // ⚠️ **양쪽 순서를 다 태운다**. `takeLegacyAt` 은 풀을 역방향으로 훑으므로, 정답(mf1)이
        //    마지막에 놓인 배열만 쓰면 GK 배제 가드를 지워도 우연히 통과한다(독립검증 MAJ-3 실측).
        for (List<LeagueService.PlayerRow> order : List.of(
                List.of(new LeagueService.PlayerRow("gk1", "BRONZE", "GK", 100),
                        new LeagueService.PlayerRow("mf1", "BRONZE", "MF", 100)),
                List.of(new LeagueService.PlayerRow("mf1", "BRONZE", "MF", 100),
                        new LeagueService.PlayerRow("gk1", "BRONZE", "GK", 100)))) {
            Map<String, List<LeagueService.PlayerRow>> pool = new LinkedHashMap<>();
            pool.put("BRONZE", new ArrayList<>(order));
            LeagueService.PlayerRow picked = LeagueService.takeLegacyAt(pool, "DF", 0);
            assertThat(picked).as("팀은 서야 하므로 누군가는 뽑힌다").isNotNull();
            assertThat(picked.position()).as("필드 슬롯에 골키퍼를 앉히지 않는다 (순서 %s)", order)
                    .isNotEqualTo("GK");
            assertThat(picked.id()).isEqualTo("mf1");
        }
    }

    @Test
    void exactPositionWinsOverTheFallback() {
        // 같은 이유로 양쪽 순서를 태운다 — df1 이 마지막인 배열만 쓰면 우선순위를 뒤집어도 통과한다.
        for (List<LeagueService.PlayerRow> order : List.of(
                List.of(new LeagueService.PlayerRow("mf1", "BRONZE", "MF", 100),
                        new LeagueService.PlayerRow("df1", "BRONZE", "DF", 100)),
                List.of(new LeagueService.PlayerRow("df1", "BRONZE", "DF", 100),
                        new LeagueService.PlayerRow("mf1", "BRONZE", "MF", 100)))) {
            Map<String, List<LeagueService.PlayerRow>> pool = new LinkedHashMap<>();
            pool.put("BRONZE", new ArrayList<>(order));
            assertThat(LeagueService.takeLegacyAt(pool, "DF", 0).id())
                    .as("정확 포지션이 폴백을 이긴다 (순서 %s)", order).isEqualTo("df1");
        }
    }

    /*
     * ⚠️ 여기 있던 `gradeCursorSpreadsPicksAcrossGrades` 는 **공허해서 지웠다**(독립검증 MIN-A).
     * 풀을 등급당 DF 1명으로 짰더니 커서를 무시해도 5개가 소진 순서대로 다 나와
     * `doesNotHaveDuplicates()` 가 **항상 참**이었다 — 어떤 변이체도 죽이지 못했다.
     * 등급 라운드로빈의 실제 커버리지는 `league/LegacyRosterFillTest` 가
     * **로스터 산출물의 등급 분포**로 낸다(그쪽이 호출부 변이까지 죽인다).
     */

    // ── 헬퍼 (LeagueDivisionTest 와 동형) ─────────────────────────────────

    private String startSeason(String token) {
        ResponseEntity<Map> res = authPost("/api/league/start", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) ((Map<?, ?>) res.getBody().get("season")).get("id");
    }

    /** 봇 id 는 시즌이 아니라 디비전에 매인다(#402 AC5) — 시즌이 선언한 teamId 를 따라간다. */
    private List<Map<String, Object>> botDecksOf(String seasonId) {
        String teamsJson = jdbcClient.sql("SELECT teams_json FROM league_seasons WHERE id = ?")
                .param(seasonId).query(String.class).single();
        List<Map<String, Object>> rows = new ArrayList<>();
        for (JsonNode t : readJson(teamsJson)) {
            if (t.path("isUser").asBoolean()) {
                continue;
            }
            rows.addAll(jdbcClient.sql("SELECT id, deck_json FROM bots WHERE id = ?")
                    .param(t.path("teamId").asText())
                    .query((rs, n) -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("id", rs.getString("id"));
                        m.put("deck_json", rs.getString("deck_json"));
                        return m;
                    })
                    .list());
        }
        return rows;
    }

    private JsonNode readJson(String json) {
        try {
            return new ObjectMapper().readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String positionOf(String playerId) {
        return jdbcClient.sql("SELECT position FROM players WHERE id = ?")
                .param(playerId).query(String.class).single();
    }
}
