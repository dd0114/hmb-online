package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * <b>발행물 버전은 두 곳에 있고, 어긋나면 배포가 조용히 구파일을 로드한다</b>(#450 W2).
 *
 * <p>{@code application.yml} 의 {@code hmb.data.*-file} 은 <b>로컬·테스트</b>가 읽는 값이고,
 * {@code Dockerfile} 의 {@code HMB_DATA_*} ENV 는 <b>컨테이너</b>에서 그 값을 <b>덮어쓴다</b>.
 * 그래서 yml 만 올리면 로컬은 새 데이터로 도는데 프로덕션은 구파일로 뜨고, <b>전 게이트가 green</b>
 * 이다 — 실제로 2026-07-27 v8 배포에서 그렇게 어긋나 있었다(yml=players.v2.3 / ENV=players.v2.1 →
 * #207 신규 LEGEND 8종이 프로덕션에 임포트되지 않은 채였다).
 *
 * <p>그 사고 뒤의 처방은 <b>주석 두 줄</b>("두 곳을 같이 올려라")이었고 그것으로 충분하지 않았다.
 * 이 클래스가 그 처방을 기계로 바꾼다.
 *
 * <p><b>왜 파일 텍스트를 읽는가</b>: Spring 컨텍스트를 띄워 프로퍼티를 물으면 <b>yml 쪽만</b>
 * 관측된다(Dockerfile 은 빌드 산출물이라 테스트 JVM 에 존재하지 않는다). 어긋남은 정의상
 * "두 텍스트가 다르다"이므로 두 텍스트를 직접 읽는 것이 이 계약의 유일한 관측 지점이다.
 */
class DataVersionParityTest {

    private static final Path APPLICATION_YML = Path.of("src/main/resources/application.yml");
    private static final Path DOCKERFILE = Path.of("Dockerfile");
    private static final Path DATA_DIR = Path.of("../data/players");

    /**
     * yml 키 → Dockerfile ENV 키. <b>여기에 없는 키가 한쪽에만 생기면 아래 키집합 계약이 잡는다</b> —
     * 이 표를 갱신하지 않고 다섯 번째 데이터 파일을 추가할 수 없다.
     */
    private static final Map<String, String> KEYS = new LinkedHashMap<>(Map.of(
            "players-file", "HMB_DATA_PLAYERSFILE",
            "economy-file", "HMB_DATA_ECONOMYFILE",
            "bots-file", "HMB_DATA_BOTSFILE",
            "league-file", "HMB_DATA_LEAGUEFILE"));

    /**
     * <b>이 웨이브가 스위치한 버전</b>(#450 W2). 다음 버전으로 올릴 때는
     * <b>대응하는 SeedTest 를 먼저 추가하고</b> 이 표를 갱신하라 — 여기가 빨개지는 것이 곧
     * "새 발행물을 소비하기 시작했는데 그 발행물을 임포트해 본 계약이 없다"는 경고다.
     */
    private static final Map<String, String> EXPECTED_FILENAMES = new LinkedHashMap<>(Map.of(
            "players-file", "players.v2.8.1.json",
            "economy-file", "economy.v4.json",
            "bots-file", "bots.v4.json",
            "league-file", "league.v2.json"));

    // ── yml: `    players-file: ../data/players/players.v2.7.json` (주석 줄은 제외)
    private static final Pattern YML_LINE =
            Pattern.compile("^\\s+([a-z]+-file):\\s*(\\S+)\\s*(?:#.*)?$");
    // ── Dockerfile: `    HMB_DATA_PLAYERSFILE=/app/data/players/players.v2.7.json \`
    private static final Pattern ENV_LINE =
            Pattern.compile("(HMB_DATA_[A-Z]+)=(\\S+?)\\s*\\\\?$");

    private static List<String> lines(Path p) {
        try {
            return Files.readAllLines(p, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("읽기 실패(테스트 cwd = server-java 인지 확인): " + p, e);
        }
    }

    /** application.yml 의 {@code hmb.data.*-file} 값들(주석 줄 무시). */
    private static Map<String, String> ymlDataFiles() {
        Map<String, String> out = new LinkedHashMap<>();
        for (String line : lines(APPLICATION_YML)) {
            if (line.stripLeading().startsWith("#")) {
                continue;
            }
            Matcher m = YML_LINE.matcher(line);
            if (m.matches()) {
                out.put(m.group(1), m.group(2));
            }
        }
        return out;
    }

    /** Dockerfile 의 {@code HMB_DATA_*} ENV 값들(주석 줄 무시). */
    private static Map<String, String> dockerDataFiles() {
        Map<String, String> out = new LinkedHashMap<>();
        for (String line : lines(DOCKERFILE)) {
            if (line.stripLeading().startsWith("#")) {
                continue;
            }
            Matcher m = ENV_LINE.matcher(line.strip());
            if (m.find()) {
                out.put(m.group(1), m.group(2));
            }
        }
        return out;
    }

    private static String fileNameOf(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? path : path.substring(slash + 1);
    }

    /**
     * <b>공허 방지</b> — 정규식이 아무것도 못 잡으면 아래 대조들이 "빈 집합끼리 같다"로 통과한다.
     * 그러면 이 클래스 전체가 침묵하는 green 이 된다(파일 형식을 손보다 들여쓰기가 바뀌기만 해도).
     */
    @Test
    void bothFilesActuallyDeclareAllFourDataPaths() {
        assertThat(ymlDataFiles().keySet())
                .as("application.yml 에서 hmb.data.*-file 을 하나도 못 읽었다 — 정규식/형식 확인")
                .containsExactlyInAnyOrderElementsOf(KEYS.keySet());
        assertThat(dockerDataFiles().keySet())
                .as("Dockerfile 에서 HMB_DATA_* 를 하나도 못 읽었다 — 정규식/형식 확인")
                .containsExactlyInAnyOrderElementsOf(KEYS.values());
    }

    /**
     * <b>이 클래스의 존재 이유</b> — 두 곳이 같은 발행물을 가리킨다.
     *
     * <p>디렉토리는 다르다(로컬 {@code ../data/players} vs 컨테이너 {@code /app/data/players}) —
     * 그게 ENV 가 존재하는 이유다. 어긋날 수 있는 축은 <b>파일명</b>뿐이므로 파일명으로 대조한다.
     */
    @Test
    void applicationYmlAndDockerfilePointAtTheSamePublishedFiles() {
        Map<String, String> yml = ymlDataFiles();
        Map<String, String> env = dockerDataFiles();

        for (Map.Entry<String, String> e : KEYS.entrySet()) {
            String ymlPath = yml.get(e.getKey());
            String envPath = env.get(e.getValue());
            assertThat(ymlPath).as("application.yml 에 " + e.getKey() + " 가 없다").isNotNull();
            assertThat(envPath).as("Dockerfile 에 " + e.getValue() + " 가 없다").isNotNull();
            assertThat(fileNameOf(envPath))
                    .as("두 곳이 어긋났다 — 컨테이너에서는 Dockerfile ENV 가 이깁니다. "
                            + e.getKey() + "=" + ymlPath + " vs " + e.getValue() + "=" + envPath)
                    .isEqualTo(fileNameOf(ymlPath));
        }
    }

    /** 가리키는 발행물이 실제로 존재한다 — 오타 한 글자면 부팅이 warn 후 <b>빈 카탈로그</b>로 뜬다. */
    @Test
    void everyReferencedPublishedFileExists() {
        for (String path : ymlDataFiles().values()) {
            Path resolved = DATA_DIR.resolve(fileNameOf(path));
            assertThat(Files.exists(resolved)).as("발행물 없음: " + resolved).isTrue();
        }
    }

    /**
     * 지금 소비 중인 버전이 <b>계약이 임포트해 본 버전</b>과 같다.
     *
     * <p>위 대조만으로는 <b>둘 다 구버전에 머무는 것</b>을 못 잡는다(어긋나지 않았으니 통과한다).
     * 그래서 웨이브가 스위치한 값을 여기에 못 박는다 — 다음 스위치는 이 상수와 SeedTest 를 함께
     * 갱신해야 통과한다.
     */
    @Test
    void consumedVersionsAreTheOnesCoveredBySeedTests() {
        Map<String, String> yml = ymlDataFiles();
        for (Map.Entry<String, String> e : EXPECTED_FILENAMES.entrySet()) {
            assertThat(fileNameOf(yml.get(e.getKey())))
                    .as(e.getKey() + " 를 올렸다면 대응 SeedTest 추가 후 이 상수도 갱신하라")
                    .isEqualTo(e.getValue());
        }
    }
}
