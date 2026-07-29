package online.hmb;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #252 W2 시뮬 검증 지원 — 디비전별 봇 선발 XI 를 파일로 덤프한다.
 *
 * <p>왜 필요한가: "디비전별 실측 승률"은 <b>엔진</b>(TS)이 있어야 나오는데, 로스터를 정하는 것은
 * <b>서버</b>(Java)다. 로스터 샘플링을 TS 로 다시 구현하면 그건 검증이 아니라 <b>재발명</b>이고,
 * 구현과 검증이 같은 실수를 공유하게 된다. 그래서 실제 서버 경로가 만든 로스터를 그대로 내보낸다.
 *
 * <p>기본 비활성 — {@code HMB_DUMP_DIVISION_ROSTERS=<경로>} 가 있을 때만 돈다. CI 게이트가 파일
 * 쓰기에 의존하지 않게 하기 위함이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
@EnabledIfEnvironmentVariable(named = "HMB_DUMP_DIVISION_ROSTERS", matches = ".+")
class LeagueDivisionRosterDumpTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.3.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v2.json");
        registry.add("hmb.data.bots-file", () -> "../data/players/bots.v3.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @Test
    void dump() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        List<Map<String, Object>> out = new ArrayList<>();
        for (int level = 10; level >= 1; level--) {
            String nick = "dump-" + level;
            String token = setupUserWithDeck(nick);
            jdbcClient.sql("UPDATE users SET division=? WHERE id=?")
                    .params(level, userIdOf(nick)).update();
            var res = authPost("/api/league/start", token, Map.of(), Map.class);
            String seasonId = (String) ((Map<?, ?>) res.getBody().get("season")).get("id");
            JsonNode teams = mapper.readTree(
                    jdbcClient.sql("SELECT teams_json FROM league_seasons WHERE id=?")
                            .param(seasonId).query(String.class).single());
            double mul = jdbcClient.sql("SELECT strength_mul FROM bots WHERE id LIKE ? LIMIT 1")
                    .param(seasonId + "-T%").query(Double.class).single();
            List<Map<String, Object>> botTeams = new ArrayList<>();
            for (JsonNode t : teams) {
                if (t.path("isUser").asBoolean()) {
                    continue;
                }
                List<String> xi = new ArrayList<>();
                t.path("rosterPlayerIds").forEach(n -> xi.add(n.asText()));
                Map<String, Object> team = new LinkedHashMap<>();
                team.put("teamId", t.path("teamId").asText());
                team.put("formation", t.path("formation").asText("4-4-2"));
                team.put("power", t.path("power").asInt());
                team.put("xi", xi.subList(0, Math.min(11, xi.size())));
                botTeams.add(team);
            }
            Map<String, Object> div = new LinkedHashMap<>();
            div.put("level", level);
            div.put("strengthMul", mul);
            div.put("teams", botTeams);
            out.add(div);
        }
        Path target = Path.of(System.getenv("HMB_DUMP_DIVISION_ROSTERS"));
        Files.createDirectories(target.getParent());
        Files.writeString(target, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(out));
        System.out.println("DUMPED division rosters -> " + target.toAbsolutePath());
    }
}
