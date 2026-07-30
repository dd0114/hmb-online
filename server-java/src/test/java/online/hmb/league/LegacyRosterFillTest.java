package online.hmb.league;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;
import org.junit.jupiter.api.Test;

/**
 * #328 — <b>포지션이 마른 풀</b>에서도 필드 슬롯에 골키퍼가 앉지 않는다.
 *
 * <p>독립검증 MAJ-2 가 잡은 구멍: `takeLegacyAt` 이 null 을 주면 선발 루프가 그 슬롯을 못 채우고
 * 넘어가는데, 뒤의 <b>벤치 채움 루프가 남은 골키퍼를 선발 슬롯에 도로 밀어 넣었다</b>.
 * 즉 `takeLegacyAt` 의 GK 배제는 문제를 호출자에게 미룬 것뿐이었다(실측: 필드 슬롯 GK 7명).
 *
 * <p><b>왜 통합 테스트로는 못 잡나</b>: 팀마다 풀 사본을 새로 뜨므로 실 카탈로그(DF 54·MF 62·FW 51)
 * 로도 픽스처 카탈로그(각 6)로도 포지션이 소진되지 않는다. 그래서 마른 풀을 직접 만들어 태운다.
 * 이 테스트가 {@code online.hmb.league} 패키지에 있는 이유도 그것이다 — {@code sampleRosterLegacy}
 * 를 public 으로 넓히는 대신 <b>같은 패키지</b>에서 package-private static 으로 부른다
 * (인스턴스 상태는 rosterSize 하나뿐이라 static 이 자연스럽다 — 18인자 생성자를 흉내낼 필요가 없다).
 */
class LegacyRosterFillTest {

    /** GK 만 잔뜩 있고 아웃필드가 모자란 풀 — 폴백이 실제로 밟히는 유일한 조건. */
    private static Map<String, List<LeagueService.PlayerRow>> starvedPool() {
        Map<String, List<LeagueService.PlayerRow>> byGrade = new LinkedHashMap<>();
        List<LeagueService.PlayerRow> bronze = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            bronze.add(new LeagueService.PlayerRow("gk" + i, "BRONZE", "GK", 100));
        }
        for (int i = 0; i < 3; i++) {
            bronze.add(new LeagueService.PlayerRow("df" + i, "BRONZE", "DF", 100));
        }
        byGrade.put("BRONZE", bronze);
        return byGrade;
    }

    /**
     * 등급 라운드로빈이 <b>로스터 산출에서</b> 실제로 퍼지는가 (#328 독립검증 MAJ-3 M5).
     *
     * <p>`takeLegacyAt` 을 커서와 함께 직접 부르는 계약만으론 부족하다 — 변이체는 <b>호출부</b>의
     * `gradeCursor++` 를 고정하는 것이라 그 테스트를 통과한다(실측). 등급 분배는 이 폴백이
     * 지키겠다고 선언한 성질(v1 롤백의 목적)이므로 <b>산출물</b>에서 잰다.
     */
    @Test
    void legacyRosterSpreadsGradesAcrossOutfieldSlots() {
        Map<String, List<LeagueService.PlayerRow>> byGrade = new LinkedHashMap<>();
        Map<String, String> grade = new LinkedHashMap<>();
        for (String g : List.of("BRONZE", "SILVER", "GOLD", "DIA", "LEGEND")) {
            List<LeagueService.PlayerRow> rows = new ArrayList<>();
            for (String pos : List.of("DF", "DF", "MF", "MF", "FW", "FW")) {
                LeagueService.PlayerRow r =
                        new LeagueService.PlayerRow(g + "-" + pos + rows.size(), g, pos, 100);
                rows.add(r);
                grade.put(r.id(), g);
            }
            LeagueService.PlayerRow gk = new LeagueService.PlayerRow(g + "-gk", g, "GK", 100);
            rows.add(gk);
            grade.put(gk.id(), g);
            byGrade.put(g, rows);
        }
        List<LeagueService.PlayerRow> gkPool =
                byGrade.values().stream().flatMap(List::stream).filter(r -> "GK".equals(r.position())).toList();

        List<String> roster =
                LeagueService.sampleRosterLegacy(new SplittableRandom(7), gkPool, byGrade, "4-4-2", 15);

        List<String> outfieldGrades = roster.subList(1, 11).stream().map(grade::get).toList();
        /*
         * ⚠️ `containsAll` 로는 **부분 쏠림을 못 잡는다**(독립검증 MIN-B: B4/S3/G1/D1/L1 변이가 통과).
         * 라운드로빈의 실제 불변식은 "아웃필드 10칸 = 등급당 정확히 2" 다 — 분포로 단언한다.
         */
        Map<String, Long> dist = outfieldGrades.stream()
                .collect(java.util.stream.Collectors.groupingBy(g -> g, java.util.stream.Collectors.counting()));
        assertThat(dist).as("아웃필드 등급 분포 %s", outfieldGrades).isEqualTo(Map.of(
                "BRONZE", 2L, "SILVER", 2L, "GOLD", 2L, "DIA", 2L, "LEGEND", 2L));
    }

    /**
     * 가드는 <b>선발까지만</b>이다 — 벤치 골키퍼를 없애면 안 된다(독립검증 MIN-C: 과적용 변이가 생존했다).
     * 벤치는 피치에 서지 않으므로 GK 배제 이유가 없고, 봇 교체가 생기면 벤치 GK 가 필요해진다.
     */
    @Test
    void theGuardStopsAtTheStartingEleven_benchMayStillHoldGoalkeepers() {
        Map<String, List<LeagueService.PlayerRow>> byGrade = new LinkedHashMap<>();
        Map<String, String> position = new LinkedHashMap<>();
        List<LeagueService.PlayerRow> rows = new ArrayList<>();
        for (String pos : List.of("DF", "DF", "DF", "DF", "MF", "MF", "MF", "MF", "FW", "FW")) {
            rows.add(new LeagueService.PlayerRow(pos + rows.size(), "BRONZE", pos, 100));
        }
        for (int i = 0; i < 5; i++) {
            rows.add(new LeagueService.PlayerRow("gk" + i, "BRONZE", "GK", 100));
        }
        rows.forEach(r -> position.put(r.id(), r.position()));
        byGrade.put("BRONZE", rows);
        List<LeagueService.PlayerRow> gkPool = rows.stream().filter(r -> "GK".equals(r.position())).toList();

        List<String> roster =
                LeagueService.sampleRosterLegacy(new SplittableRandom(3), gkPool, byGrade, "4-4-2", 15);

        assertThat(roster).hasSize(15);
        assertThat(roster.subList(1, 11).stream().map(position::get))
                .as("선발 필드 슬롯엔 GK 가 없다").doesNotContain("GK");
        assertThat(roster.subList(11, 15).stream().map(position::get))
                .as("벤치엔 GK 가 남아야 한다 — 가드가 벤치까지 번지면 안 된다").contains("GK");
    }

    @Test
    void starvedPoolStillNeverPutsAGoalkeeperInAnOutfieldStarterSlot() {
        Map<String, String> position = new LinkedHashMap<>();
        Map<String, List<LeagueService.PlayerRow>> pool = starvedPool();
        for (List<LeagueService.PlayerRow> rows : pool.values()) {
            for (LeagueService.PlayerRow r : rows) {
                position.put(r.id(), r.position());
            }
        }
        List<LeagueService.PlayerRow> gkPool =
                pool.get("BRONZE").stream().filter(r -> "GK".equals(r.position())).toList();

        List<String> roster = LeagueService.sampleRosterLegacy(new SplittableRandom(42), gkPool, pool, "4-4-2", 15);

        // ⚠️ 마른 풀에선 로스터가 15명보다 **짧아진다**(실측 4명). 그게 이 가드의 의도다 —
        //    "팀은 반드시 15명"이 아니라 **"GK 를 필드에 세우느니 사람을 덜 세운다"** 가 보장이다.
        assertThat(roster).as("적어도 골키퍼는 선다").isNotEmpty();
        List<String> starters = roster.subList(0, Math.min(11, roster.size()));
        assertThat(position.get(starters.get(0))).as("slot0 = GK").isEqualTo("GK");
        List<String> outfield = starters.subList(1, starters.size()).stream().map(position::get).toList();
        assertThat(outfield)
                .as("필드 슬롯에 골키퍼가 없어야 — 있으면 그 수만큼 팀이 줄어든다 (실제 로스터 %s)", starters)
                .doesNotContain("GK");
    }
}
