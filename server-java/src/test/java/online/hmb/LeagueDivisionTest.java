package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
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
 * #252 디비전 난이도 사다리 + 승급/강등.
 *
 * <p><b>실 카탈로그(players.v2.3) + 실 발행물(league.v2)로 돈다.</b> 다른 리그 테스트는 17명짜리
 * 픽스처 카탈로그를 쓰는데, 등급 사다리는 "어느 등급 풀에서 뽑느냐"가 전부라 등급이 고르게 있는
 * 풀이 없으면 검증 자체가 성립하지 않는다.
 *
 * <p><b>단언의 성격</b>: 절대 파워 상수를 박지 않는다. 카탈로그가 개편되면 파워는 따라 움직이므로
 * 상수 단언은 거짓 실패가 된다. 대신 <b>관계식</b>을 건다 — 사다리 단조성, 입문 &lt; 유저 덱,
 * 최상위 &gt; 구 사다리, 배율이 실제 SelectData 에 도달함. 설계가 깨지면 이 관계들이 깨진다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueDivisionTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        // 실 발행물 — 사다리·연습봇 하향의 SoT.
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.3.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v2.json");
        registry.add("hmb.data.bots-file", () -> "../data/players/bots.v3.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @jakarta.annotation.Resource
    private LeagueService leagueService;

    @jakarta.annotation.Resource
    private FakeServants fakeServants;

    // ── 사다리 ───────────────────────────────────────────────────────────

    @Test
    void botTeamPowerIncreasesMonotonicallyAsDivisionLevelDrops() {
        // 각 디비전에서 시즌을 하나씩 만들고 봇 9팀 평균 파워를 잰다.
        // level 이 작을수록(=상위) 강해져야 한다 — 사다리의 존재 이유.
        Map<Integer, Double> avgPower = new LinkedHashMap<>();
        for (int level = 10; level >= 1; level--) {
            String nickname = "div-mono-" + level;
            String token = setupUserWithRealDeck(nickname);
            setDivision(nickname, level);
            String seasonId = startSeason(token);
            assertThat(divisionOfSeason(seasonId)).isEqualTo(level);
            avgPower.put(level, avgBotPower(seasonId));
        }
        for (int level = 9; level >= 1; level--) {
            assertThat(avgPower.get(level))
                    .as("D%d(%.0f) 가 D%d(%.0f) 보다 강해야 한다",
                            level, avgPower.get(level), level + 1, avgPower.get(level + 1))
                    .isGreaterThan(avgPower.get(level + 1));
        }
    }

    @Test
    void entryDivisionIsWeakerThanAStarterDeckAndTopDivisionIsStrongerThanLegacyLadder() {
        // "초반 5시즌 무난"의 뿌리 = 입문 디비전 봇이 유저 덱보다 약할 것.
        String token = setupUserWithRealDeck("div-entry");
        String seasonId = startSeason(token);
        double entry = avgBotPower(seasonId);
        int userPower = userTeamPowerOf(seasonId);
        assertThat(entry)
                .as("입문 디비전 봇 평균 %.0f < 유저 XI %d", entry, userPower)
                .isLessThan(userPower);

        // 최상위는 **구 사다리보다 세야** 한다 — 잘하는 유저에게 갈 곳이 남아 있어야 하기 때문.
        // 구 사다리 = 등급 라운드로빈이라 XI ≈ 각 등급 2명 + GK 1. 상수를 박지 않고 실제 카탈로그에서 계산한다.
        double legacy = legacyLadderXiPower();

        String topToken = setupUserWithRealDeck("div-top");
        setDivision("div-top", 1);
        double top = avgBotPower(startSeason(topToken));
        assertThat(top).as("최상위 %.0f > 구 사다리 %.0f", top, legacy).isGreaterThan(legacy);
        assertThat(entry).as("입문 %.0f < 구 사다리 %.0f", entry, legacy).isLessThan(legacy);
    }

    @Test
    void botRostersRespectDivisionGradeSlotsAndAlwaysFieldAGoalkeeper() {
        String token = setupUserWithRealDeck("div-slots");
        setDivision("div-slots", 10); // 입문 = 전원 BRONZE 슬롯
        String seasonId = startSeason(token);
        for (JsonNode team : teamsJson(seasonId)) {
            if (team.path("isUser").asBoolean()) {
                continue;
            }
            List<String> roster = new ArrayList<>();
            team.path("rosterPlayerIds").forEach(n -> roster.add(n.asText()));
            assertThat(roster).as("로스터 중복 없음").doesNotHaveDuplicates();
            List<String> xi = roster.subList(0, Math.min(11, roster.size()));
            assertThat(gradeOf(xi.get(0))).isEqualTo("BRONZE");
            assertThat(positionOf(xi.get(0))).as("slot 0 은 GK").isEqualTo("GK");
            // 입문 슬롯은 전원 BRONZE — 폴백이 돌 이유가 없는 큰 풀이다.
            for (String id : xi) {
                assertThat(gradeOf(id)).as("XI 전원 BRONZE (%s)", id).isEqualTo("BRONZE");
            }
        }
    }

    @Test
    void botStartingElevenMatchesItsFormationShape() {
        // 구현 이전 실측(#252 W2): 디비전 XI 의 평균 GK 수가 **2.00** 인 디비전이 있었다 —
        // 포지션을 안 보고 뽑았기 때문이다. 골키퍼 둘이 필드에 선 팀은 등급과 무관하게 약해져
        // 사다리가 단조롭지 않게 된다(D2 승률 47.6% > D3 33.7% 역전이 실제로 났다).
        for (int level : new int[] {10, 6, 1}) {
            String nick = "shape-" + level;
            String token = setupUserWithRealDeck(nick);
            setDivision(nick, level);
            String seasonId = startSeason(token);
            for (Map<String, Object> bot : botDecksOf(seasonId)) {
                JsonNode deck = readJson((String) bot.get("deck_json"));
                String formation = deck.path("formation").asText("4-4-2");
                List<String> expected = LeagueService.startingPositions(formation);
                List<String> actual = new ArrayList<>();
                for (JsonNode st : deck.path("starters")) {
                    actual.add(positionOf(st.path("playerId").asText()));
                }
                assertThat(actual).as("%s 선발 11", bot.get("id")).hasSize(11);
                assertThat(actual.get(0)).as("slot 0 = GK").isEqualTo("GK");
                for (String pos : List.of("GK", "DF", "MF", "FW")) {
                    assertThat(actual.stream().filter(pos::equals).count())
                            .as("%s(%s) %s 수", bot.get("id"), formation, pos)
                            .isEqualTo(expected.stream().filter(pos::equals).count());
                }
            }
        }
    }

    @Test
    void formationStringParsesIntoElevenPositionSlots() {
        assertThat(LeagueService.startingPositions("4-4-2"))
                .containsExactly("GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW");
        assertThat(LeagueService.startingPositions("4-3-3"))
                .containsExactly("GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW");
        assertThat(LeagueService.startingPositions("5-3-2"))
                .containsExactly("GK", "DF", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW");
        // 4단 표기: 가운데를 전부 MF 로 합친다.
        assertThat(LeagueService.startingPositions("4-2-3-1"))
                .containsExactly("GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "MF", "FW");
        // 깨진 입력은 4-4-2 폴백 — 팀이 안 서는 것보다 낫다.
        assertThat(LeagueService.startingPositions("nonsense")).hasSize(11);
        assertThat(LeagueService.startingPositions("9-9-9")).hasSize(11);
        assertThat(LeagueService.startingPositions(null)).hasSize(11);
    }

    // ── 승급 / 강등 ──────────────────────────────────────────────────────

    @Test
    void promotionRuleMovesTopTwoUpBottomTwoDownAndHoldsTheMiddle() {
        // 전이 규칙은 순수 함수라 그대로 단언한다(조회·부수효과 없음). top=1, bottom=10.
        assertThat(LeagueService.nextDivision(5, 1, 1, 10, 2, 9)).as("1위 승급").isEqualTo(4);
        assertThat(LeagueService.nextDivision(5, 2, 1, 10, 2, 9)).as("2위 승급").isEqualTo(4);
        assertThat(LeagueService.nextDivision(5, 3, 1, 10, 2, 9)).as("3위 유지").isEqualTo(5);
        assertThat(LeagueService.nextDivision(5, 8, 1, 10, 2, 9)).as("8위 유지").isEqualTo(5);
        assertThat(LeagueService.nextDivision(5, 9, 1, 10, 2, 9)).as("9위 강등").isEqualTo(6);
        assertThat(LeagueService.nextDivision(5, 10, 1, 10, 2, 9)).as("10위 강등").isEqualTo(6);
    }

    @Test
    void promotionRuleClampsAtBothEndsOfTheLadder() {
        assertThat(LeagueService.nextDivision(1, 1, 1, 10, 2, 9)).as("최상위 우승 — 더 올라갈 곳 없음").isEqualTo(1);
        assertThat(LeagueService.nextDivision(10, 10, 1, 10, 2, 9)).as("입문 꼴찌 — 더 내려갈 곳 없음").isEqualTo(10);
    }

    @Test
    void winningEveryFixturePromotesTheUserWhenTheSeasonFinishes() {
        assertDivisionAfterSeason("promo-win", 5, true, 4);
    }

    @Test
    void losingEveryFixtureRelegatesTheUserWhenTheSeasonFinishes() {
        assertDivisionAfterSeason("promo-loss", 5, false, 6);
    }

    @Test
    void seasonKeepsItsDivisionEvenIfTheUserIsPromotedMidSeason() {
        // 시즌 난이도는 **시작 시점**에 박제된다. 아니면 이미 치른 라운드와 남은 라운드의 상대 강도가
        // 달라져 순위표가 뜻을 잃는다.
        String token = setupUserWithRealDeck("div-frozen");
        setDivision("div-frozen", 8);
        String seasonId = startSeason(token);
        double before = avgBotPower(seasonId);

        setDivision("div-frozen", 2); // 시즌 도중 디비전이 바뀌어도
        assertThat(divisionOfSeason(seasonId)).as("시즌에 박제된 값은 불변").isEqualTo(8);
        assertThat(avgBotPower(seasonId)).isEqualTo(before);
        assertThat(seasonDto(token).path("division").asInt()).isEqualTo(8);
    }

    @Test
    void ladderEndsReportNoPromotionOrRelegationBecauseTheServerClampsThere() {
        // 독립검증 BL-1: config 컷을 그대로 실어 보내면 클라가 **서버가 하지 않는 전이**를 화면에
        // 단언한다. 입문 디비전에는 강등이, 최상위에는 승급이 없다(nextDivision 이 클램프).
        // 신규 유저는 전원 입문 디비전이므로 이건 100% 의 유저가 보는 화면이다.
        String entryToken = setupUserWithRealDeck("cut-entry");
        setDivision("cut-entry", 10); // 입문
        startSeason(entryToken);
        JsonNode entry = seasonDto(entryToken);
        assertThat(entry.path("promoteRankMax").asInt()).as("입문에서도 승급은 있다").isEqualTo(2);
        assertThat(entry.path("relegateRankMin").isNull())
                .as("입문 디비전에는 강등이 없다 — 컷을 보내면 없는 위협을 그린다").isTrue();

        String topToken = setupUserWithRealDeck("cut-top");
        setDivision("cut-top", 1); // 최상위
        startSeason(topToken);
        JsonNode top = seasonDto(topToken);
        assertThat(top.path("promoteRankMax").isNull())
                .as("최상위에는 승급이 없다 — 우승했는데 '한 단계 위로' 는 거짓말이다").isTrue();
        assertThat(top.path("relegateRankMin").asInt()).as("최상위에서도 강등은 있다").isEqualTo(9);

        String midToken = setupUserWithRealDeck("cut-mid");
        setDivision("cut-mid", 5);
        startSeason(midToken);
        JsonNode mid = seasonDto(midToken);
        assertThat(mid.path("promoteRankMax").asInt()).isEqualTo(2);
        assertThat(mid.path("relegateRankMin").asInt()).isEqualTo(9);
    }

    @Test
    void reportedCutsMatchWhatNextDivisionActuallyDoes() {
        // 화면 규칙과 실제 전이가 갈라지지 않는다는 계약. 사다리 전 구간을 훑어
        // "컷이 있다 ⇔ 그 순위에서 디비전이 실제로 움직인다" 를 확인한다.
        for (int level = 10; level >= 1; level--) {
            String nick = "cut-scan-" + level;
            String token = setupUserWithRealDeck(nick);
            setDivision(nick, level);
            startSeason(token);
            JsonNode dto = seasonDto(token);
            boolean promoteAdvertised = !dto.path("promoteRankMax").isNull();
            boolean relegateAdvertised = !dto.path("relegateRankMin").isNull();
            boolean promoteHappens = LeagueService.nextDivision(level, 1, 1, 10, 2, 9) != level;
            boolean relegateHappens = LeagueService.nextDivision(level, 10, 1, 10, 2, 9) != level;
            assertThat(promoteAdvertised).as("D%d 승급 광고 == 실제 승급", level).isEqualTo(promoteHappens);
            assertThat(relegateAdvertised).as("D%d 강등 광고 == 실제 강등", level).isEqualTo(relegateHappens);
        }
    }

    // ── 강도 배율이 실제 엔진 입력까지 도달하는가 ────────────────────────

    @Test
    void divisionStrengthMultiplierReachesTheBotRowAndTheTeamsJsonPower() {
        String token = setupUserWithRealDeck("div-mul");
        setDivision("div-mul", 10); // 입문 = strengthMul < 1.0
        String seasonId = startSeason(token);

        List<Map<String, Object>> rows = botRowsOf(seasonId);
        assertThat(rows).isNotEmpty();
        double mul = (Double) rows.get(0).get("strength_mul");
        assertThat(mul).as("입문 디비전은 배율이 걸린다").isLessThan(1.0).isGreaterThan(0.0);
        assertThat(rows).allSatisfy(r -> assertThat(r.get("kind")).isEqualTo("league"));

        // teams_json.power 는 **배율 적용 후** 값이어야 한다 — 화면 파워 = 실제 파워.
        // (봇전 간이결과도 이 값을 쓰므로 두 경로가 자동 정합한다.)
        int declared = 0;
        int rawXi = 0;
        for (JsonNode team : teamsJson(seasonId)) {
            if (team.path("isUser").asBoolean()) {
                continue;
            }
            declared = team.path("power").asInt();
            List<String> roster = new ArrayList<>();
            team.path("rosterPlayerIds").forEach(n -> roster.add(n.asText()));
            for (String id : roster.subList(0, 11)) {
                rawXi += attrSum(id);
            }
            break;
        }
        assertThat(declared).isEqualTo((int) Math.round(rawXi * mul));
    }

    @Test
    void divisionStrengthMultiplierActuallyReachesTheEngineSelectData() {
        // 배율이 DB 에만 있고 엔진 입력에 안 닿으면 난이도는 하나도 안 바뀐다.
        // 실제 /simulate 요청을 가로채 봇 사이드 능력치가 카탈로그 원본보다 낮은지 본다.
        String token = setupUserWithRealDeck("div-engine");
        setDivision("div-engine", 10);
        String seasonId = startSeason(token);
        double mul = (Double) botRowsOf(seasonId).get(0).get("strength_mul");
        assertThat(mul).isLessThan(1.0);

        RUNNER.requests.clear();
        ResponseEntity<Map> next = authPost("/api/league/next-match", token, Map.of(), Map.class);
        assertThat(next.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) ((Map<?, ?>) next.getBody().get("match")).get("id");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();

        assertThat(RUNNER.requests).as("/simulate 가 호출됐다").isNotEmpty();
        JsonNode select = RUNNER.requests.get(0).path("selectData");
        String botName = botTeamNameOf(seasonId, matchId);
        JsonNode botSide = select.path("home").path("name").asText().equals(botName)
                ? select.path("home") : select.path("away");
        assertThat(botSide.path("name").asText()).isEqualTo(botName);

        boolean sawScaledDown = false;
        for (JsonNode card : botSide.path("players")) {
            String pid = card.path("playerId").asText();
            int sent = 0;
            for (JsonNode v : card.path("attributes")) {
                sent += v.asInt();
            }
            int raw = attrSum(pid);
            assertThat(sent).as("%s 능력치가 원본(%d)보다 커지면 안 된다", pid, raw).isLessThanOrEqualTo(raw);
            if (sent < raw) {
                sawScaledDown = true;
            }
        }
        assertThat(sawScaledDown).as("봇 능력치가 실제로 하향돼 엔진에 전달됐다").isTrue();
    }

    // ── /api/me 디비전 (#268) ───────────────────────────────────────────

    @Test
    void meExposesCurrentDivisionIndependentlyOfAnySeason() {
        // 승급/강등은 시즌 **사이**에 일어난다. 시즌을 끝내고 다음 시즌 전이 정확히 "몇 부가 됐지?"
        // 가 궁금한 순간인데 시즌 DTO 가 없어 표시할 근거가 없었다(#268).
        String nick = "me-div";
        String token = setupUserWithRealDeck(nick);
        setDivision(nick, 7);

        JsonNode me = readJson(authGet("/api/me", token, String.class).getBody());
        assertThat(me.path("league").path("division").asInt()).as("시즌이 없어도 나온다").isEqualTo(7);
        assertThat(me.path("league").path("divisionName").asText())
                .as("표시명은 서버가 준다 — 클라가 level 로 만들지 않는다").isNotBlank();

        // 시즌을 끝내고 승급하면 **바로** 다음 값이 보인다(시즌 DTO 는 아직 옛 값을 들고 있다).
        String seasonId = startSeason(token);
        winEverySeasonFixture(seasonId);
        invokeSeasonHook("maybeFinishSeason", seasonId);
        assertThat(divisionOfSeason(seasonId)).as("시즌은 치른 디비전을 박제").isEqualTo(7);
        JsonNode after = readJson(authGet("/api/me", token, String.class).getBody());
        assertThat(after.path("league").path("division").asInt())
                .as("유저는 이미 승급돼 있다").isEqualTo(6);
    }

    // ── 연습 봇 풀 오염 차단 (BL-1) ──────────────────────────────────────

    @Test
    void practiceMatchmakingNeverDrawsLeagueBotTeams() {
        String token = setupUserWithRealDeck("div-practice");
        String seasonId = startSeason(token);
        assertThat(botRowsOf(seasonId)).as("리그 봇팀 행이 실제로 만들어졌다").isNotEmpty();

        // 리그 봇팀이 bots 표에 있는 상태에서 연습 매칭을 여러 번 돌린다.
        // 예전엔 표 전체에서 뽑아 리그팀이 섞였고, 시즌이 늘수록 시드봇 확률이 0으로 수렴했다.
        List<String> seedIds = jdbcClient.sql("SELECT id FROM bots WHERE kind='seed'")
                .query(String.class).list();
        assertThat(seedIds).as("시드봇 3종").hasSize(3);
        for (int i = 0; i < 40; i++) {
            releaseActiveMatches();
            ResponseEntity<Map> res = authPost("/api/matches", token, Map.of(), Map.class);
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
            String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id=?")
                    .param((String) res.getBody().get("id")).query(String.class).single();
            assertThat(seedIds).as("연습 상대는 시드봇만").contains(botId);
        }
    }

    @Test
    void aRealAwayGhostIsCreatedOutsideThePracticePool() {
        // 원정 고스트(#245)는 **실유저 덱 + 성장 스탯**이라 난이도 설계 밖이다. bots.kind 기본값이
        // 'seed' 라 AwayService 가 분류를 빼먹으면 리그 봇팀이 연습 풀을 오염시킨 것(BL-1)과
        // 똑같은 결함이 다른 문으로 들어온다.
        //
        // ⚠️ 여기서 행을 직접 INSERT 하면 안 된다 — 그건 SQL 의미론을 확인하는 것이지 제품 동작이
        // 아니다(실제로 그렇게 썼다가 독립검증에서 "변이체가 살아남는다"고 잡혔다).
        // **실제 원정 매치 생성 API 를 태워** 생긴 행을 본다.
        // 수비자는 **한 판이라도 끝낸** 유저여야 상대 풀에 든다(#296) — 덱만으론 후보가 되지 않는다.
        setupOpponentWithDeck("ghost-def");
        setupOpponentWithDeck("ghost-def2");
        String attacker = setupUserWithRealDeck("ghost-atk");

        ResponseEntity<Map> cand = authGet("/api/away/candidates", attacker, Map.class);
        assertThat(cand.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> offered = (List<Map<String, Object>>) cand.getBody().get("candidates");
        assertThat(offered).isNotEmpty();
        String defenderId = (String) offered.get(0).get("userId");
        assertThat(authPost("/api/away/matches", attacker, Map.of("defenderId", defenderId), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);

        List<Map<String, Object>> ghosts = jdbcClient.sql("SELECT id, kind FROM bots WHERE id LIKE 'GHOST%'")
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("kind", rs.getString("kind"));
                    return m;
                })
                .list();
        assertThat(ghosts).as("원정 매치가 실제로 고스트 행을 만들었다").isNotEmpty();
        assertThat(ghosts).allSatisfy(g ->
                assertThat(g.get("kind")).as("%s 는 연습 풀이 아니다", g.get("id")).isEqualTo("away"));

        List<String> practicePool = jdbcClient.sql("SELECT id FROM bots WHERE kind = 'seed'")
                .query(String.class).list();
        for (Map<String, Object> g : ghosts) {
            assertThat(practicePool).doesNotContain((String) g.get("id"));
        }
        releaseActiveMatches();
    }

    @Test
    void seedBotStrengthMultiplierIsImportedAndReachesTheEngine() {
        // #252 MAJ-3: 연습 봇 하나(공격형)는 등급 하한으로도 못 내려가 배율을 쓴다. 그 배율이
        // 발행물에만 있고 엔진 입력에 안 닿으면 아무것도 안 바뀐다.
        double mul = jdbcClient.sql("SELECT strength_mul FROM bots WHERE id = 'BOT_ATK'")
                .query(Double.class).single();
        assertThat(mul).as("bots.v3.json 의 strengthMul 이 임포트됐다").isLessThan(1.0).isGreaterThan(0.0);
        assertThat(jdbcClient.sql("SELECT strength_mul FROM bots WHERE id = 'BOT_BAL'")
                .query(Double.class).single()).as("배율을 안 쓰는 봇은 1.0").isEqualTo(1.0);

        String token = setupUserWithRealDeck("seed-mul");
        RUNNER.requests.clear();
        ResponseEntity<Map> res = authPost("/api/matches", token, Map.of("botId", "BOT_ATK"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) res.getBody().get("id");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();

        assertThat(RUNNER.requests).isNotEmpty();
        JsonNode select = RUNNER.requests.get(0).path("selectData");
        String botName = botTeamNameOf(null, matchId);
        JsonNode botSide = select.path("home").path("name").asText().equals(botName)
                ? select.path("home") : select.path("away");
        boolean scaledDown = false;
        for (JsonNode card : botSide.path("players")) {
            int sent = 0;
            for (JsonNode v : card.path("attributes")) {
                sent += v.asInt();
            }
            int raw = attrSum(card.path("playerId").asText());
            assertThat(sent).isLessThanOrEqualTo(raw);
            if (sent < raw) {
                scaledDown = true;
            }
        }
        assertThat(scaledDown).as("연습 봇 능력치가 실제로 하향돼 엔진에 전달됐다").isTrue();
        releaseActiveMatches();
    }

    @Test
    void practiceCannotTargetANonSeedBotByExplicitId() {
        // 랜덤 경로는 pickRandom 이 막지만, botId 를 명시하면 리그 봇팀·원정 고스트를 지목할 수 있다.
        // 그 우회가 열려 있으면 풀 필터는 장식이다.
        String token = setupUserWithRealDeck("explicit-bot");
        String seasonId = startSeason(token);
        String leagueBotId = (String) botRowsOf(seasonId).get(0).get("id");
        releaseActiveMatches();

        ResponseEntity<String> res = authPost("/api/matches", token,
                Map.of("botId", leagueBotId), String.class);
        assertThat(res.getStatusCode())
                .as("리그 봇팀을 연습 상대로 지목하면 없는 봇과 같은 응답")
                .isEqualTo(HttpStatus.NOT_FOUND);

        // 시드봇 지목은 계속 된다(과잉 차단이면 기능 회귀).
        releaseActiveMatches();
        assertThat(authPost("/api/matches", token, Map.of("botId", "BOT_BAL"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        releaseActiveMatches();
    }

    @Test
    void lateReplayOfAnOldSeasonHookDoesNotUndoALaterPromotion() {
        // 승급 CAS 가 실제로 막는 시나리오. 단순 재호출은 CAS 없이도 안전하다(from 이 시즌에 박제돼
        // 있어 같은 to 를 쓴다) — 진짜 위험은 **유저가 이미 더 나아간 뒤** 옛 시즌 훅이 늦게 도는 것이다.
        // D5 우승→D4, D4 우승→D3 까지 간 유저에게 첫 시즌 훅이 다시 돌면 division 을 4 로 덮어써
        // 한 칸 되돌린다. (그래서 시즌을 **둘** 완주시켜야 이 변이가 잡힌다.)
        String token = setupUserWithRealDeck("late-replay");
        String userId = userIdOf("late-replay");
        setDivision("late-replay", 5);

        String firstSeason = startSeason(token);
        winEverySeasonFixture(firstSeason);
        invokeSeasonHook("maybeFinishSeason", firstSeason);
        assertThat(divisionOfUser(userId)).as("1시즌 우승 → D4").isEqualTo(4);

        String secondSeason = startSeason(token);
        assertThat(divisionOfSeason(secondSeason)).isEqualTo(4);
        winEverySeasonFixture(secondSeason);
        invokeSeasonHook("maybeFinishSeason", secondSeason);
        assertThat(divisionOfUser(userId)).as("2시즌 우승 → D3").isEqualTo(3);

        // 이제 **첫 시즌** 훅이 늦게 한 번 더 돈다(재배포·재처리 등).
        invokeSeasonHook("awardSeasonRewards", firstSeason);

        assertThat(divisionOfUser(userId))
                .as("옛 시즌 훅이 늦게 돌아도 진행도를 되돌리면 안 된다")
                .isEqualTo(3);
    }

    /** 봇전 전부 0-0, 유저전 전부 승 — 유저가 확실한 1위가 되게. */
    private void winEverySeasonFixture(String seasonId) {
        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=0, score_away=0 "
                        + "WHERE season_id = ? AND is_user = 0").param(seasonId).update();
        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=1, score_away=0 "
                        + "WHERE season_id = ? AND is_user = 1 AND home_team = ?")
                .params(seasonId, LeagueService.USER_TEAM_ID).update();
        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=0, score_away=1 "
                        + "WHERE season_id = ? AND is_user = 1 AND away_team = ?")
                .params(seasonId, LeagueService.USER_TEAM_ID).update();
    }

    // ── 봇전 간이결과    // ── 봇전 간이결과    // ── 봇전 간이결과: 승점 산포가 실제 리그 밴드인가 (BL-5) ─────────────

    @Test
    void closelyMatchedTeamsStayCompetitiveUnderTheConfiguredPowerDivisor() {
        // BL-5(docs/plan-v5/opponent-balance.md §1.4): power-divisor 가 봇 파워 산포에 비해 작으면
        // 조금 센 팀이 조금 약한 팀을 **거의 매번** 이겨 한 봇이 리그를 쓸어간다. 라이브에서 실제로
        // 그랬고(최고 2.50 ppg vs 최저 0.17 ppg, 유저는 2.00 ppg 로도 3위), 그 상태에서는 유저가
        // 매치를 아무리 잘해도 우승할 수 없다.
        //
        // 임계는 **뽑힌 로스터가 아니라 고정 파워차**에 건다 — 로스터는 시드마다 달라 산포가 흔들리고,
        // 그러면 계약이 시드 운에 좌우된다. 150 은 라이브 실측 봇 파워 sd(126)에 대응하는 전형적
        // 맞대결 파워차다(같은 디비전 안에서 일상적으로 생기는 격차).
        int typicalGap = 150;
        int base = 6000;
        double[] eg = leagueService.expectedGoals(base + typicalGap, base);
        double favourite = eg[0];
        double underdog = eg[1];

        // ① 약팀이 "사실상 무득점 확정"이 되면 안 된다. 실제 축구에서 상위-하위 맞대결 기대득점은
        //    대략 2.1 : 0.8(비 0.38) 수준이다 — 그보다 극단이면 리그가 추첨이 아니라 서열표가 된다.
        assertThat(underdog / favourite)
                .as("파워차 %d 에서 약팀/강팀 기대득점 비 %.3f (구 divisor 120 이면 0.02)",
                        typicalGap, underdog / favourite)
                .isGreaterThan(0.35);
        // ② 강팀 기대득점이 실제 리그 상단(~2.0)을 넘지 않아야 한다.
        assertThat(favourite).as("강팀 기대득점 %.2f", favourite).isLessThan(2.0);
        // ③ 방향성은 유지(홈 보정 포함) — 파워가 높은 쪽이 더 많이 넣는다.
        assertThat(favourite).isGreaterThan(underdog);
    }

    @Test
    void botOnlyRoundsSettleEveryFixtureDeterministically() {
        // 사다리·divisor 변경이 봇전 정산 자체를 깨지 않는지(회귀 가드). 결정론은 재계산 일치로 본다.
        String token = setupUserWithRealDeck("div-botsettle");
        String seasonId = startSeason(token);
        for (int round = 1; round <= 18; round++) {
            leagueService.generateRoundBotResults(seasonId, round);
        }
        List<Map<String, Object>> played = playedBotFixtures(seasonId);
        assertThat(played).as("봇전 72경기 전부 PLAYED").hasSize(72);
        assertThat(leagueService.computeStandings(seasonId)).hasSize(10);
        // 같은 시즌 seed + fixtureId 로 재계산하면 같은 스코어(AC-F2).
        for (Map<String, Object> f : played) {
            LeagueService.BotScore again = leagueService.botMatchResult(
                    seedOf(seasonId), (String) f.get("id"),
                    powerOf(seasonId, (String) f.get("home_team")),
                    powerOf(seasonId, (String) f.get("away_team")));
            assertThat(again.home()).isEqualTo(((Number) f.get("score_home")).intValue());
            assertThat(again.away()).isEqualTo(((Number) f.get("score_away")).intValue());
        }
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    /** 실 카탈로그(P001..)로 유효 덱 — MatchTestBase 의 덱과 같은 슬롯 구성. */
    private String setupUserWithRealDeck(String nickname) {
        return setupUserWithDeck(nickname);
    }

    /** 주의: 상속받은 {@code userIdOf} 는 <b>닉네임</b>을 받는다(토큰 아님). */
    private void setDivision(String nickname, int level) {
        jdbcClient.sql("UPDATE users SET division = ? WHERE id = ?")
                .params(level, userIdOf(nickname)).update();
    }

    private String startSeason(String token) {
        ResponseEntity<Map> res = authPost("/api/league/start", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) ((Map<?, ?>) res.getBody().get("season")).get("id");
    }

    /**
     * 구 사다리(등급 라운드로빈)가 세우던 선발 XI 파워 — 각 등급 2명 + GK 1(등급 무작위, GOLD 근사).
     * 라이브 실측 평균이 6861 이었고(docs/plan-v5/opponent-balance.md §1.4 BL-2), 이 계산이 그 값을 재현한다.
     */
    private double legacyLadderXiPower() {
        Map<String, Double> avg = new LinkedHashMap<>();
        for (String g : List.of("BRONZE", "SILVER", "GOLD", "DIA", "LEGEND")) {
            List<String> ids = jdbcClient.sql("SELECT id FROM players WHERE grade = ?")
                    .param(g).query(String.class).list();
            avg.put(g, ids.stream().mapToInt(this::attrSum).average().orElseThrow());
        }
        return 2 * avg.values().stream().mapToDouble(Double::doubleValue).sum() + avg.get("GOLD");
    }

    private double avgBotPower(String seasonId) {
        List<Integer> powers = new ArrayList<>();
        for (JsonNode t : teamsJson(seasonId)) {
            if (!t.path("isUser").asBoolean()) {
                powers.add(t.path("power").asInt());
            }
        }
        assertThat(powers).isNotEmpty();
        return powers.stream().mapToInt(Integer::intValue).average().orElseThrow();
    }

    private int userTeamPowerOf(String seasonId) {
        for (JsonNode t : teamsJson(seasonId)) {
            if (t.path("isUser").asBoolean()) {
                return t.path("power").asInt();
            }
        }
        throw new IllegalStateException("유저 팀 없음");
    }

    private JsonNode teamsJson(String seasonId) {
        String json = jdbcClient.sql("SELECT teams_json FROM league_seasons WHERE id = ?")
                .param(seasonId).query(String.class).single();
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private int divisionOfSeason(String seasonId) {
        return jdbcClient.sql("SELECT division FROM league_seasons WHERE id = ?")
                .param(seasonId).query(Integer.class).single();
    }

    private JsonNode seasonDto(String token) {
        ResponseEntity<String> res = authGet("/api/league", token, String.class);
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(res.getBody())
                    .path("season");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private List<Map<String, Object>> botRowsOf(String seasonId) {
        return jdbcClient.sql("SELECT id, kind, strength_mul FROM bots WHERE id LIKE ?")
                .param(seasonId + "-T%")
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("kind", rs.getString("kind"));
                    m.put("strength_mul", rs.getDouble("strength_mul"));
                    return m;
                })
                .list();
    }

    private List<Map<String, Object>> playedBotFixtures(String seasonId) {
        return jdbcClient.sql("""
                        SELECT id, home_team, away_team, score_home, score_away FROM league_fixtures
                        WHERE season_id = ? AND is_user = 0 AND state = 'PLAYED'
                        """)
                .param(seasonId)
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("home_team", rs.getString("home_team"));
                    m.put("away_team", rs.getString("away_team"));
                    m.put("score_home", rs.getInt("score_home"));
                    m.put("score_away", rs.getInt("score_away"));
                    return m;
                })
                .list();
    }

    /** 이 매치의 상대(봇) 표시명 — SelectData 의 home/away 중 어느 쪽이 봇인지 가르는 키. */
    /** seasonId 는 안 쓴다(매치 → 봇 조회) — 리그/연습 양쪽에서 같은 헬퍼를 쓰기 위해 남겨둔다. */
    private String botTeamNameOf(String seasonId, String matchId) {
        String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        return jdbcClient.sql("SELECT name FROM bots WHERE id = ?")
                .param(botId).query(String.class).single();
    }

    private List<Map<String, Object>> botDecksOf(String seasonId) {
        return jdbcClient.sql("SELECT id, deck_json FROM bots WHERE id LIKE ?")
                .param(seasonId + "-T%")
                .query((rs, n) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("deck_json", rs.getString("deck_json"));
                    return m;
                })
                .list();
    }

    private JsonNode readJson(String json) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private int divisionOfUser(String userId) {
        return jdbcClient.sql("SELECT division FROM users WHERE id = ?")
                .param(userId).query(Integer.class).single();
    }

    private String seedOf(String seasonId) {
        return jdbcClient.sql("SELECT seed FROM league_seasons WHERE id = ?")
                .param(seasonId).query(String.class).single();
    }

    private int powerOf(String seasonId, String teamId) {
        for (JsonNode t : teamsJson(seasonId)) {
            if (t.path("teamId").asText().equals(teamId)) {
                return t.path("power").asInt();
            }
        }
        return 0;
    }

    private String gradeOf(String playerId) {
        return jdbcClient.sql("SELECT grade FROM players WHERE id = ?")
                .param(playerId).query(String.class).single();
    }

    private String positionOf(String playerId) {
        return jdbcClient.sql("SELECT position FROM players WHERE id = ?")
                .param(playerId).query(String.class).single();
    }

    private int attrSum(String playerId) {
        String json = jdbcClient.sql("SELECT attributes_json FROM players WHERE id = ?")
                .param(playerId).query(String.class).single();
        try {
            JsonNode node = new com.fasterxml.jackson.databind.ObjectMapper().readTree(json);
            int sum = 0;
            for (JsonNode v : node) {
                sum += v.asInt();
            }
            return sum;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * 시즌 하나를 실제로 <b>끝까지 정산</b>시켜(승급/강등이 보상과 같은 지점에서 도는지) 디비전 전이를 본다.
     *
     * <p>순위는 스코어를 심어 만든다: 봇전은 전부 0-0(무승부 → 봇 전원 승점 동률), 유저전만 승/패로
     * 채운다. 그러면 유저는 전승이면 확실한 1위, 전패면 확실한 꼴찌라 타이브레이커에 기대지 않는다.
     */
    private void assertDivisionAfterSeason(String nickname, int fromDivision,
                                           boolean userWinsAll, int expectedDivision) {
        String token = setupUserWithRealDeck(nickname);
        String userId = userIdOf(nickname);
        setDivision(nickname, fromDivision);
        String seasonId = startSeason(token);

        // 봇전: 전부 0-0.
        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=0, score_away=0 "
                        + "WHERE season_id = ? AND is_user = 0")
                .param(seasonId).update();
        // 유저전: 유저 쪽에 1-0 / 0-1. home_team 이 'USER' 인지로 사이드를 판별한다.
        int userGoals = userWinsAll ? 1 : 0;
        int oppGoals = userWinsAll ? 0 : 1;
        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=?, score_away=? "
                        + "WHERE season_id = ? AND is_user = 1 AND home_team = ?")
                .params(userGoals, oppGoals, seasonId, LeagueService.USER_TEAM_ID).update();
        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=?, score_away=? "
                        + "WHERE season_id = ? AND is_user = 1 AND away_team = ?")
                .params(oppGoals, userGoals, seasonId, LeagueService.USER_TEAM_ID).update();

        invokeSeasonHook("maybeFinishSeason", seasonId);

        assertThat(jdbcClient.sql("SELECT state FROM league_seasons WHERE id=?")
                .param(seasonId).query(String.class).single()).isEqualTo("FINISHED");
        assertThat(rankOfUser(seasonId)).isEqualTo(userWinsAll ? 1 : 10);
        assertThat(jdbcClient.sql("SELECT division FROM users WHERE id=?")
                .param(userId).query(Integer.class).single())
                .as("D%d 에서 %s → D%d", fromDivision, userWinsAll ? "우승" : "꼴찌", expectedDivision)
                .isEqualTo(expectedDivision);

        // 재진입 멱등 ①: 시즌 종료 훅 재호출(시즌은 이미 FINISHED — CAS 가 막는다).
        invokeSeasonHook("maybeFinishSeason", seasonId);
        assertThat(jdbcClient.sql("SELECT division FROM users WHERE id=?")
                .param(userId).query(Integer.class).single()).isEqualTo(expectedDivision);

        // 재진입 멱등 ②: 보상 훅을 **직접** 재호출해도 디비전이 또 움직이면 안 된다.
        // 보상은 원장 유니크가 막지만 디비전엔 그런 장치가 없어 별도 CAS 로 막는다.
        invokeSeasonHook("awardSeasonRewards", seasonId);
        assertThat(jdbcClient.sql("SELECT division FROM users WHERE id=?")
                .param(userId).query(Integer.class).single())
                .as("보상 훅 재진입으로 두 칸 움직이면 안 된다")
                .isEqualTo(expectedDivision);
    }

    /** 시즌 종료 훅(package-private)을 리플렉션으로 호출 — production API 를 테스트용으로 넓히지 않는다. */
    private void invokeSeasonHook(String method, String seasonId) {
        try {
            java.lang.reflect.Method m = LeagueService.class.getDeclaredMethod(method, String.class);
            m.setAccessible(true);
            m.invoke(leagueService, seasonId);
        } catch (Exception e) {
            throw new IllegalStateException("훅 재호출 실패: " + method, e);
        }
    }

    private int rankOfUser(String seasonId) {
        return leagueService.computeStandings(seasonId).stream()
                .filter(LeagueService.LeagueStanding::isUser)
                .map(LeagueService.LeagueStanding::rank)
                .findFirst().orElseThrow();
    }
}
