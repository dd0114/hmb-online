package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import online.hmb.catalog.EconomyService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#450 W2 — v2.7 / economy v4 / bots v4 소비 계약</b>(현행 소비본).
 *
 * <p>{@link PlayerCatalogV24SeedTest}·V23·V22 는 남겨 둔다 — 그쪽은 각자의 버전을 <b>명시 지정</b>하는
 * 회귀 가드(구 발행물이 여전히 임포트되는가 = 롤백 경로)라 기본 설정이 v2.7 로 넘어가도 계속 통과한다.
 * 경쟁하지 않는다.
 *
 * <p><b>왜 파일이 아니라 DB 결과 상태를 보는가</b>: 시드가 옳아도 임포터가 {@code active} 를
 * 왕복시키지 못하거나 {@code shortName} 을 흘려 버리면 DB 는 다른 상태로 뜬다 — data 쪽 파일
 * 테스트로는 구조적으로 안 잡히는 실패다.
 *
 * <p><b>economy v4 의 승계 확인이 이 클래스의 두 번째 주제</b>다. v4 는 디스크의 v3 를 입력으로
 * 삼아 스타터 두 블록만 갈아끼운 것인데, v3 자체가 <b>발행 후 손으로 얹은 블록 3개</b>
 * (#251 {@code league.gemReward} · #368 {@code league.dailyReward} · #408 {@code mission.reward})를
 * 갖고 있었다 — 생성기를 한 번 돌리면 그 셋이 조용히 사라지는 상태였고 실제로 한 번 덮였다(#453).
 * 그러니 "v4 로 올렸다"는 그 승계가 살아 있을 때만 안전하다.
 */
@SpringBootTest
class PlayerCatalogV27SeedTest {

    /** v2.7 활성 62종의 포지션 구성(명세 = {@code docs/plan-v5/roster-v27-spec.md}). */
    private static final Map<String, Integer> ACTIVE_BY_POSITION =
            Map.of("GK", 10, "DF", 17, "MF", 19, "FW", 16);

    /** 활성 LEGEND 10종 = {@code economy.v4 starterTop.pool} 과 같은 집합이어야 한다. */
    private static final List<String> ACTIVE_LEGENDS = List.of(
            "P173", "P174", "P175", "P176", "P177", "P178", "P179", "P180", "P181", "P182");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        try {
            Path dbFile = Files.createTempFile("hmb-test-v27-", ".db");
            Files.deleteIfExists(dbFile);
            registry.add("hmb.db.path", () -> dbFile.toAbsolutePath().toString());
            Path overrideFile = Files.createTempDirectory("hmb-test-econ-v27-")
                    .resolve("economy.override.json");
            registry.add("hmb.data.economy-override-file", () -> overrideFile.toAbsolutePath().toString());
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        // 기본 설정(application.yml)과 같은 발행물을 **명시 지정**한다 — 기본값이 다음 버전으로
        // 넘어가도 이 테스트는 "v2.7 세트가 임포트 가능한가"를 계속 지킨다(V22~V24 와 같은 규율).
        // "지금 소비 중인 버전이 이것인가"는 DataVersionParityTest 가 별도로 건다.
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.7.json");
        registry.add("hmb.data.economy-file", () -> "../data/players/economy.v4.json");
        registry.add("hmb.data.bots-file", () -> "../data/players/bots.v4.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v2.json");
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private EconomyService economyService;

    @Value("${hmb.data.economy-file}")
    private String economyFile;

    // ══════════════════════ 1. 로스터 v2.7 ══════════════════════

    @Test
    void v27ImportsAllRowsAndRecordsVersions() {
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single())
                .as("v2.7 은 행을 더하지도 지우지도 않는다(표시명 + active 레이어)").isEqualTo(182L);

        assertThat(jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'players_version'")
                .query(String.class).single()).isEqualTo("v2.7");
        assertThat(jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'economy_version'")
                .query(String.class).single()).isEqualTo("v4");
        assertThat(jdbcClient.sql("SELECT value FROM meta_kv WHERE key = 'bots_version'")
                .query(String.class).single()).isEqualTo("v4");

        // 부팅 임포트는 아무것도 잠그지 않는다 — 잠금은 어드민 API 만 세운다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE admin_locked <> 0")
                .query(Long.class).single()).isZero();
    }

    /**
     * <b>활성 62 / 은퇴 120</b> — 은퇴는 <b>행 삭제가 아니라 플래그</b>다(보유분은 계속 보인다,
     * {@code CatalogController} 의 {@code active = 1 OR 보유 > 0}).
     *
     * <p>포지션 분포를 같이 세는 이유: 총계만 보면 62 가 <b>엉뚱한 62</b> 여도 통과한다. 실제로
     * 이 그리드(GK10/DF17/MF19/FW16)가 명세의 산출물이고, 한 포지션이 통째로 비면 덱을 못 세운다.
     */
    @Test
    void activeGridIs62WithTheSpecifiedPositionMix() {
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE active = 1")
                .query(Long.class).single()).as("활성").isEqualTo(62L);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE active = 0")
                .query(Long.class).single()).as("은퇴(비활성)").isEqualTo(120L);

        for (Map.Entry<String, Integer> e : ACTIVE_BY_POSITION.entrySet()) {
            assertThat(jdbcClient.sql(
                            "SELECT COUNT(*) FROM players WHERE active = 1 AND position = ?")
                    .param(e.getKey()).query(Long.class).single())
                    .as("활성 " + e.getKey()).isEqualTo(e.getValue().longValue());
        }

        // 은퇴시키면서 등급까지 내리지 않았다(U-D1: 기보유 유저 손실 0).
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM players WHERE active = 0 AND grade = 'LEGEND'"
                                + " AND id IN ('P001','P002','P003')")
                .query(Long.class).single())
                .as("구 LEGEND 는 은퇴해도 등급이 LEGEND 로 남는다").isEqualTo(3L);
    }

    /**
     * <b>스타터 최상위 후보(#209)가 실제로 지급 가능한가</b> — pool 의 10종이 전부 <b>활성 LEGEND</b>다.
     *
     * <p>pool 이 카탈로그와 어긋나면 가입 지급 경로가 그 id 를 건너뛴다(= 최상위 없이 가입).
     * v2.7 이 P174·P178·P180·P181·P182 를 켠 것과 economy v4 가 pool 을 5종 → 10종으로 넓힌 것은
     * <b>한 세트</b>라, 둘 중 하나만 배포되면 이 단언이 깨진다.
     */
    @Test
    void starterTopPoolIsExactlyTheTenActiveLegends() {
        EconomyService.StarterTop starterTop = economyService.snapshot().economy()
                .orElseThrow(() -> new AssertionError("economy v4 로드 실패")).starterTop();
        assertThat(starterTop).as("v4 에 starterTop 블록이 없다").isNotNull();
        assertThat(starterTop.pool()).containsExactlyInAnyOrderElementsOf(ACTIVE_LEGENDS);
        assertThat(starterTop.count()).isEqualTo(1);

        assertThat(jdbcClient.sql(
                        "SELECT id FROM players WHERE grade = 'LEGEND' AND active = 1 ORDER BY id")
                .query(String.class).list())
                .as("활성 LEGEND 집합이 starterTop.pool 과 다르다")
                .containsExactlyElementsOf(ACTIVE_LEGENDS);
    }

    // ══════════════════════ 2. shortName 임포트 (#411) ══════════════════════

    /**
     * <b>{@code shortName} 이 DB 까지 도착한다</b>(V41 {@code players.short_name}).
     *
     * <p>v2.6 이 이 필드를 발행한 뒤로 서버는 그것을 <b>버리고 있었다</b> — 임포터가 읽지 않았고
     * 컬럼도 없었다. web 은 값이 없으면 풀네임으로 폴백하도록 만들어져 있어서 <b>화면이 정상으로
     * 보였고</b>, 그래서 이 결손은 어느 게이트에도 안 걸렸다.
     */
    @Test
    void shortNameIsImportedForEveryRow() {
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM players WHERE short_name IS NULL OR short_name = ''")
                .query(Long.class).single())
                .as("v2.7 은 182행 전부 shortName 을 싣는다 — 비어 있으면 임포트가 흘린 것")
                .isZero();

        // 표본 — 풀네임과 **다른** 행이 실제로 있어야 이 필드가 의미를 갖는다(같기만 하면
        // "풀네임을 복사했다"와 구분되지 않는다).
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM players WHERE short_name <> name")
                .query(Long.class).single())
                .as("shortName 이 전부 풀네임과 같다 = 실제로는 안 실린 것과 구분 불가").isGreaterThan(0L);

        assertThat(jdbcClient.sql("SELECT short_name FROM players WHERE id = 'P173'")
                .query(String.class).single()).isEqualTo("보날두");
    }

    /**
     * <b>활성 62종 안에서 {@code shortName} 은 유일하다</b> — 밀집 UI 에서 두 선수가 같은 라벨로
     * 보이면 교체·전술보드에서 오조작이 난다.
     *
     * <p>⚠️ <b>전역 유일이 아니다</b>(그렇게 걸면 red 다): "루이스"(P101·P118)가 <b>둘 다 은퇴</b>해
     * 비활성 구간에 중복으로 남는다(`data/CLAUDE.md` §14 주석). 계약을 게임에서 실제로 마주치는
     * 집합에 맞춘다.
     */
    @Test
    void shortNameIsUniqueAmongActiveUnits() {
        List<String> dupes = jdbcClient.sql(
                        "SELECT short_name FROM players WHERE active = 1"
                                + " GROUP BY short_name HAVING COUNT(*) > 1")
                .query(String.class).list();
        assertThat(dupes).as("활성 카탈로그에 중복 shortName").isEmpty();
    }

    // ══════════════════════ 3. economy v4 의 승계 (#453 재발 방지) ══════════════════════

    /**
     * <b>#251 · #368 · #408 블록이 v4 에 살아 있다</b>.
     *
     * <p><b>왜 발행물 JSON 을 직접 읽는가</b>: {@link EconomyService} 의 접근자 셋은 전부
     * <b>last-known-good 기본값</b>을 갖고 있고(override 트랩 대비, 각 상수 javadoc 참조) 그 기본값이
     * 하필 발행물의 값과 <b>같다</b>. 즉 블록이 통째로 사라져도 접근자는 같은 값을 계속 돌려준다 —
     * 접근자로 재는 계약은 이 사고를 <b>원리적으로</b> 못 잡는다. 관측 지점은 파일이어야 한다.
     */
    @Test
    void economyV4CarriesForwardTheThreePostPublishBlocks() throws IOException {
        JsonNode root = new ObjectMapper().readTree(new File(economyFile));
        assertThat(root.path("version").asText()).isEqualTo("v4");

        JsonNode gemReward = root.path("league").path("gemReward");
        assertThat(gemReward.isObject()).as("#251 league.gemReward 가 v4 에 없다").isTrue();
        assertThat(gemReward.path("completion").asInt()).isEqualTo(3000);
        assertThat(gemReward.path("rankBonus").path("1").asInt()).isEqualTo(6000);

        JsonNode dailyReward = root.path("league").path("dailyReward");
        assertThat(dailyReward.isObject()).as("#368 league.dailyReward 가 v4 에 없다").isTrue();
        assertThat(dailyReward.path("slotsPerDay").asInt()).isEqualTo(18);
        assertThat(dailyReward.path("currency").asText()).isEqualTo("GEM");

        JsonNode missionReward = root.path("mission").path("reward");
        assertThat(missionReward.isObject()).as("#408 mission.reward 가 v4 에 없다").isTrue();
        assertThat(missionReward.path("EASY").asInt()).isEqualTo(100);
        assertThat(missionReward.path("NORMAL").asInt()).isEqualTo(200);
        assertThat(missionReward.path("HARD").asInt()).isEqualTo(300);
    }

    /** 그리고 서버가 그 값을 실제로 그렇게 읽는다(배선 — 위 계약과 역할이 다르다). */
    @Test
    void serverReadsTheCarriedForwardValues() {
        assertThat(economyService.leagueGemReward().amountFor(1)).isEqualTo(9000);
        assertThat(economyService.leagueDailyReward().slotsPerDay()).isEqualTo(18);
        assertThat(economyService.leagueDailyReward().isBig(9)).isTrue();
        assertThat(economyService.dailyMissionReward().amountFor("HARD")).isEqualTo(300);
    }

    /**
     * <b>{@code starterPack} 은 은퇴 유닛을 가리키지 않는다</b> — v4 가 2슬롯을 재매핑한 이유다.
     * 가리키면 가입 지급이 그 카드를 건너뛰거나(id 검증) 은퇴 카드를 신규 발급한다.
     */
    @Test
    void starterPackContainsOnlyActiveUnits() {
        List<String> pack = economyService.snapshot().economy()
                .orElseThrow(() -> new AssertionError("economy v4 로드 실패")).starterPack();
        assertThat(pack).isNotEmpty();
        for (String id : pack) {
            assertThat(jdbcClient.sql("SELECT active FROM players WHERE id = ?").param(id)
                    .query(Integer.class).optional())
                    .as("starterPack 이 카탈로그에 없는 id 를 가리킨다: " + id).isPresent();
            assertThat(jdbcClient.sql("SELECT active FROM players WHERE id = ?").param(id)
                    .query(Integer.class).single())
                    .as("starterPack 이 은퇴 유닛을 가리킨다: " + id).isEqualTo(1);
        }
    }
}
