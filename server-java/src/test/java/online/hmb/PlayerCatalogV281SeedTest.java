package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#483 — players v2.8.1 소비 계약</b>(현행 소비본): 은퇴 120종까지 개명해 <b>실명 잔존 0</b>.
 *
 * <p>{@link PlayerCatalogV27SeedTest}·V24·V23·V22 는 남겨 둔다 — 각자 자기 버전을 <b>명시 지정</b>하는
 * 회귀 가드(구 발행물이 여전히 임포트되는가 = 롤백 경로)라 기본 설정이 v2.8.1 로 넘어가도 계속 통과한다.
 *
 * <p><b>왜 서버 쪽에도 계약이 필요한가</b> — data 쪽 파일 테스트는 "발행물에 실명이 없다"까지만 본다.
 * 유저가 실제로 보는 것은 <b>DB 를 거친 카탈로그 응답</b>이고, 그 사이에 임포터가 있다:
 * {@code upsertPlayers} 의 {@code ON CONFLICT DO UPDATE … WHERE admin_locked = 0} 은 <b>잠긴 행의
 * 이름을 갱신하지 않는다</b>. 즉 "발행물은 깨끗한데 라이브에는 실명이 남는" 상태가 구조적으로 가능하고,
 * 그건 파일 테스트로는 원리적으로 안 잡힌다.
 *
 * <p><b>이 웨이브가 닫는 경계</b>: {@code active = 0} 은 <b>획득만</b> 막는다. 도감·덱 편성은
 * {@code WHERE p.active = 1 OR 보유수 > 0}({@code CatalogController}, #207 U-D7)이라 <b>보유분은 계속
 * 보인다</b> — 라이브 실측(2026-08-10)에서 유저 210명 중 <b>207명</b>이 실명 카드를 갖고 있었고, 그중
 * 둘(P081·P092)은 스타터팩이라 사실상 전원이 봤다.
 */
@SpringBootTest
class PlayerCatalogV281SeedTest {

    /**
     * v2.6(실명 축)의 표시명·shortName 전집합. <b>발행물에서 직접 읽는다</b> — 실명 목록을 자바
     * 상수로 베끼면 스테일해지고, 그 순간 이 계약은 "내가 적어 둔 몇 개만" 보는 것이 된다.
     */
    private static Set<String> realNamesFromV26() throws IOException {
        JsonNode rows = new ObjectMapper().readTree(new File("../data/players/players.v2.6.json"));
        // 패러디 10종(P173~P182)은 실명이 아니다(hero 확정 유지 대상, #406 안 C).
        Set<String> parody = Set.of("P173", "P174", "P175", "P176", "P177", "P178", "P179", "P180",
                "P181", "P182");
        Set<String> out = new HashSet<>();
        for (JsonNode p : rows) {
            if (parody.contains(p.path("id").asText())) {
                continue;
            }
            out.add(p.path("name").asText());
            String s = p.path("shortName").asText(null);
            if (s != null && !s.isBlank()) {
                out.add(s);
            }
        }
        return out;
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        try {
            Path dbFile = Files.createTempFile("hmb-test-v281-", ".db");
            Files.deleteIfExists(dbFile);
            registry.add("hmb.db.path", () -> dbFile.toAbsolutePath().toString());
            Path overrideFile = Files.createTempDirectory("hmb-test-econ-v281-")
                    .resolve("economy.override.json");
            registry.add("hmb.data.economy-override-file", () -> overrideFile.toAbsolutePath().toString());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        // 기본 설정과 같은 세트를 **명시 지정**한다 — 기본값이 다음 버전으로 넘어가도 이 테스트는
        // "v2.8.1 세트가 임포트 가능한가"를 계속 지킨다. "지금 소비 중인 버전이 이것인가"는
        // DataVersionParityTest 가 별도로 건다(V27SeedTest 와 같은 규율).
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.8.1.json");
        registry.add("hmb.data.economy-file", () -> "../data/players/economy.v4.json");
        registry.add("hmb.data.bots-file", () -> "../data/players/bots.v4.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v2.json");
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void v281ImportsAllRowsAndRecordsTheVersion() {
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single())
                .as("v2.8.1 은 행을 더하지도 지우지도 않는다(표시명 레이어)").isEqualTo(182L);
        assertThat(jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'players_version'")
                .query(String.class).single()).isEqualTo("v2.8.1");
    }

    /** 🔴 이 트랙의 존재 이유 — <b>DB 를 거친 뒤에도</b> 실명이 한 건도 없다. */
    @Test
    void noRealPlayerNameSurvivesInTheCatalog() throws IOException {
        Set<String> real = realNamesFromV26();
        assertThat(real).as("실명 축이 비어 있으면 이 계약은 아무것도 안 본다").hasSizeGreaterThan(100);

        List<String> leaked = jdbcClient.sql("SELECT id || ' ' || name FROM players WHERE name IN ("
                        + real.stream().map(n -> "?").reduce((a, b) -> a + "," + b).orElse("''") + ")")
                .params(real.stream().toList())
                .query(String.class).list();
        assertThat(leaked).as("카탈로그에 v2.6 실명이 남아 있다").isEmpty();

        List<String> leakedShort = jdbcClient.sql(
                        "SELECT id || ' ' || short_name FROM players WHERE short_name IN ("
                                + real.stream().map(n -> "?").reduce((a, b) -> a + "," + b).orElse("''") + ")")
                .params(real.stream().toList())
                .query(String.class).list();
        assertThat(leakedShort).as("shortName 에 v2.6 실명이 남아 있다").isEmpty();
    }

    /**
     * <b>은퇴 카드도 이름을 갖는다</b> — 개명이 "비우기"로 잘못 구현되면 도감의 보유분이 빈칸이 된다.
     * (보유분은 계속 보이므로 빈칸은 곧 유저가 보는 결함이다.)
     */
    @Test
    void everyRetiredRowStillHasANameAndShortName() {
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM players WHERE active = 0"
                                + " AND (name IS NULL OR name = '' OR short_name IS NULL OR short_name = '')")
                .query(Long.class).single()).isZero();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE active = 0")
                .query(Long.class).single()).as("은퇴 격자는 그대로다").isEqualTo(120L);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE active = 1")
                .query(Long.class).single()).as("활성 격자는 그대로다").isEqualTo(62L);
    }

    /**
     * <b>shortName 이 이제 전역 유일하다</b> — v2.7 은 활성 62 안에서만 걸 수 있었다("루이스" P101·P118 이
     * 둘 다 은퇴해 비활성 구간에 중복으로 남아서다). 그 두 행이 개명되며 제약이 전역으로 올라간다.
     *
     * <p>도감은 보유한 은퇴 카드도 보여 주므로, 전역 중복은 유저 화면에서 실제로 마주칠 수 있는 상태였다.
     */
    @Test
    void shortNameIsNowUniqueAcrossTheWholeCatalog() {
        List<String> dupes = jdbcClient.sql(
                        "SELECT short_name FROM players GROUP BY short_name HAVING COUNT(*) > 1")
                .query(String.class).list();
        assertThat(dupes).as("카탈로그 전역 중복 shortName").isEmpty();

        List<String> nameDupes = jdbcClient.sql(
                        "SELECT name FROM players GROUP BY name HAVING COUNT(*) > 1")
                .query(String.class).list();
        assertThat(nameDupes).as("카탈로그 전역 중복 표시명").isEmpty();
    }

    /**
     * <b>보유·성장 축은 id 로 물려 있다</b> — 개명이 유저 자산을 건드리지 않는다는 것을 스키마 쪽에서
     * 확인한다. ({@code user_players} 등이 {@code players(id)} 를 참조하고 이름은 참조 키가 아니다.)
     */
    @Test
    void renamingIsDisplayOnly_idsAreUntouched() {
        // v2.7 과 v2.8 의 id 집합이 같다(행 추가·삭제 0).
        List<String> ids = jdbcClient.sql("SELECT id FROM players ORDER BY id").query(String.class).list();
        assertThat(ids).hasSize(182).startsWith("P001").endsWith("P182");
        // 부팅 임포트는 아무것도 잠그지 않는다 — 잠금은 어드민 API 만 세운다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE admin_locked <> 0")
                .query(Long.class).single()).isZero();
    }

    /**
     * 🔴 <b>패널 수리 검정</b> — 캐리오버 4행이 <b>DB 를 거친 뒤에도</b> 새 이름이다.
     * (`upsertPlayers` 의 `WHERE admin_locked = 0` 때문에 "발행물은 고쳤는데 라이브는 안 바뀐다"가
     * 구조적으로 가능하다 — 파일 테스트로는 원리적으로 안 잡히는 자리다.)
     */
    @Test
    void carryoverFixedRowsLandInTheCatalog() {
        record Row(String id, String stale, String fixed) {}
        List<Row> rows = List.of(
                new Row("P135", "앙헬로 킨타", "엘리안 킨타"),
                new Row("P096", "알렉 페르잔", "네스토르 페르잔"),
                new Row("P084", "실반 로이터", "실반 마흘러"),
                new Row("P082", "아리츠 바르셀", "제로니 바르셀"));
        for (Row r : rows) {
            String name = jdbcClient.sql("SELECT name FROM players WHERE id = ?")
                    .param(r.id()).query(String.class).single();
            assertThat(name).as("%s 가 수리 전 이름으로 남아 있다", r.id()).isNotEqualTo(r.stale());
            assertThat(name).as("%s 수리명", r.id()).isEqualTo(r.fixed());
        }
    }
}
