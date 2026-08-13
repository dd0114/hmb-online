package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;

/**
 * #493 W10 — <b>튜토리얼 고정 로스터는 "얼굴 캐릭터가 있는 선수"로 이루어진다.</b>
 *
 * <p>hero: <i>"튜토리얼 선수들 다양하게하자 지금 튜토리얼 선수들 다 일반선수들이라 재미없어.
 * 얼굴 케릭터 있는거로하자."</i>
 *
 * <p>그 요구가 걸리는 자리는 화면 코드가 아니라 <b>로스터 데이터</b>다 — web 은 {@code playerId} 로
 * 아트를 조인하므로({@code apps/web/src/common/char-assets-store.charRefFor}) 조인이 성립하는 선수를
 * 자산에 구우면 그것으로 끝이고, 반대로 굽는 표가 되돌아가면 <b>web 을 한 줄도 안 고쳤는데</b> 얼굴이
 * 통째로 사라진다. 그래서 계약을 자산에 건다. 셋을 본다:
 * <ol>
 *   <li>아트 매핑({@code data/players/player-chars.v2.json})의 {@code rule} 이
 *       {@code grade-default-unit}(= 등급 공용 기본 유닛 = "일반 선수 얼굴")이 <b>아니다</b></li>
 *   <li>카탈로그 등급이 <b>DIA 이상</b> — web 의 노출 정책이 그 아래를 가린다
 *       ({@code icon-policy.CHAR_ART_MIN_GRADE}, #285). 아트가 있어도 등급이 낮으면 안 뜬다.</li>
 *   <li><b>{@code active: true}</b> — {@code GET /api/players} 가 {@code active=1 OR 보유>0} 로 자르므로
 *       비활성 선수는 신규 유저의 카탈로그 응답에 아예 없다. 그러면 이름도 등급도 못 잡고, 등급이
 *       없으면 아트가 fail-closed 로 닫힌다(구 LEGEND 14명이 정확히 이 상태라 못 쓴다).</li>
 * </ol>
 * 그리고 <b>같은 아트 파일이 한 경기에 두 번 나오지 않는다</b>(hero: "다양하게").
 *
 * <p>⚠️ <b>away 는 전원을 요구하지 않는다 — 구조적 상한이다.</b> 수비수 아트는 4종
 * ({@code lupus·leo·bark·seokdijk})뿐인데 4-3-3 두 팀이면 DF 슬롯이 8칸이다. hero 우선순위대로
 * home(마이 팀)에 4종을 다 주고, away 백4 는 일반 선수로 둔다.
 *
 * <p>⚠️ <b>스프링을 띄우지 않는다.</b> 테스트 컨텍스트의 카탈로그는 픽스처
 * ({@code src/test/resources/fixtures/players.v1.json})라 <b>출하 카탈로그의 성질을 관측할 수 없다</b>
 * — 그 위에서 재면 P182·P015 같은 실제 id 가 전부 "없음"으로 떨어져 계약이 공허해진다. 이 클래스는
 * 출하 발행물과 출하 자산을 <b>직접</b> 읽는다.
 */
class TutorialRosterArtTest {

    private static final Path ASSET = Path.of("src/main/resources/tutorial/tutorial-match.json.gz");
    private static final Path CHARS = Path.of("../data/players/player-chars.v2.json");
    private static final Path APPLICATION_YML = Path.of("src/main/resources/application.yml");

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void everyHomePlayerHasItsOwnFaceAndNoArtIsUsedTwice() throws Exception {
        JsonNode asset = readAsset();
        Map<String, String> artOf = artByPlayer();
        Map<String, JsonNode> catalog = catalogById();

        Map<String, String> seenArt = new LinkedHashMap<>();
        Map<String, Integer> faces = new LinkedHashMap<>();
        for (String side : List.of("home", "away")) {
            List<String> ids = new ArrayList<>();
            asset.path("selectData").path(side).path("players")
                    .forEach(p -> ids.add(p.path("playerId").asText()));
            assertThat(ids).as(side + " 선발").hasSize(11);

            int withFace = 0;
            for (String id : ids) {
                JsonNode row = catalog.get(id);
                assertThat(row).as(id + " 이 출하 카탈로그에 없습니다").isNotNull();
                assertThat(row.path("active").asBoolean(true))
                        .as(id + " 은 active 여야 신규 유저 화면에 이름·등급이 뜬다").isTrue();

                String art = artOf.get(id);
                if (art == null) {
                    continue;   // 등급 공용 아트 = 일반 선수(away 백4 의 구조적 상한)
                }
                assertThat(row.path("grade").asText())
                        .as(id + " 은 아트가 있는데 등급이 DIA 미만이라 노출 정책이 가린다")
                        .isIn("DIA", "LEGEND");
                assertThat(seenArt).as("같은 아트를 " + id + " 와 " + seenArt.get(art) + " 가 같이 쓴다")
                        .doesNotContainKey(art);
                seenArt.put(art, id);
                withFace++;
            }
            faces.put(side, withFace);
        }

        assertThat(faces.get("home")).as("마이 팀은 11명 전원이 얼굴 캐릭터다(hero W10)").isEqualTo(11);
        assertThat(faces.get("away")).as("상대도 남는 얼굴로 최대한 채운다(DF 아트 4종이 구조적 상한)")
                .isGreaterThanOrEqualTo(6);
    }

    /**
     * 자산 자체가 "유저가 이긴다 + 볼거리가 있다"를 만족한다.
     *
     * <p>{@code TutorialMatchTest} 는 <b>승리</b>만 본다(자산의 스코어를 그대로 인용하므로 1:0 짜리
     * 자산으로 다시 구워도 통과한다). 굽는 스크립트의 밴드({@code acceptable})가 실제로 지켜졌는지는
     * 자산에 대고 물어야 관측된다 — 스크립트를 손으로 우회해 굽는 경로가 있기 때문이다
     * (예: {@code MAX_SEEDS} 를 늘리고 조건을 낮추는 임시 수정).
     */
    @Test
    void theBakedScoreIsAWinWithSomethingToWatch() throws Exception {
        JsonNode asset = readAsset();
        int home = asset.path("finalScore").path("home").asInt();
        int away = asset.path("finalScore").path("away").asInt();
        assertThat(home - away).as("한눈에 이긴 경기여야 한다").isGreaterThanOrEqualTo(2);
        assertThat(home + away).as("골이 4~6개 = 볼거리 밴드(#493 W10)").isBetween(4, 6);
        assertThat(away).as("상대도 한 골은 넣는다 — 학살은 튜토리얼의 그림이 아니다")
                .isGreaterThanOrEqualTo(1);
        JsonNode h1 = asset.path("halves").get(0);
        assertThat(h1.path("score").path("home").asInt())
                .as("전반(탭 투어 구간)에도 우리 골이 있어야 한다").isGreaterThanOrEqualTo(1);
    }

    // ── 읽기 ─────────────────────────────────────────────────────────────────

    private JsonNode readAsset() throws Exception {
        assertThat(Files.exists(ASSET)).as("출하 자산 " + ASSET).isTrue();
        try (GZIPInputStream gz = new GZIPInputStream(new ByteArrayInputStream(Files.readAllBytes(ASSET)))) {
            return mapper.readTree(gz);
        }
    }

    /** 차별화 아트만 담는다(등급 공용 유닛은 뺀다) — key=playerId, value=`axis/id`(= 실제 아트 파일). */
    private Map<String, String> artByPlayer() throws Exception {
        JsonNode chars = mapper.readTree(Files.readString(CHARS));
        Map<String, String> out = new LinkedHashMap<>();
        for (JsonNode d : chars.path("detail")) {
            if ("grade-default-unit".equals(d.path("rule").asText())) {
                continue;
            }
            out.put(d.path("playerId").asText(), d.path("axis").asText() + "/" + d.path("id").asText());
        }
        assertThat(out).as("아트 매핑 발행물이 비어 있으면 이 계약은 공허하다").isNotEmpty();
        return out;
    }

    /**
     * <b>서버가 실제로 임포트하는</b> 카탈로그를 읽는다 — 파일명을 여기 박으면 다음 버전 스위치에서
     * 조용히 낡는다({@code DataVersionParityTest} 와 같은 이유).
     */
    private Map<String, JsonNode> catalogById() throws Exception {
        String yml = Files.readString(APPLICATION_YML);
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("players-file:\\s*(\\S+)").matcher(yml);
        assertThat(m.find()).as("application.yml 에서 players-file 을 못 찾았다").isTrue();
        Path players = Path.of(m.group(1));
        assertThat(Files.exists(players)).as("카탈로그 " + players).isTrue();
        Map<String, JsonNode> out = new LinkedHashMap<>();
        for (JsonNode p : mapper.readTree(Files.readString(players))) {
            out.put(p.path("id").asText(), p);
        }
        return out;
    }
}
