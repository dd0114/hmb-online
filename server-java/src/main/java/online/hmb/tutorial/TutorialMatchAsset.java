package online.hmb.tutorial;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.SoftReference;
import java.util.zip.GZIPInputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/**
 * #493 W6-v3 — <b>미리 구운 튜토리얼 매치</b> 자산.
 *
 * <p>hero verbatim: <i>"선수도 보유 선수말고 그냥 튜토리얼선수로 한다고생각하고 진행하게 하자.
 * 그래야 시드값이 안바뀌어. … 모든유저가 같은 결과를 보는거야. … 게임도 이겨야해."</i>
 *
 * <p><b>왜 매번 시뮬하지 않고 구웠나</b>(설계 판단, Decision log):
 * <ul>
 *   <li>"반드시 승리"는 <b>엔진 버전에 걸린 성질</b>이다. 고정 입력 + 고정 시드로 매번 러너를 태우면
 *       엔진이 한 번 바뀌는 순간 튜토리얼이 조용히 패배로 뒤집힌다 — 그리고 그 사실을 잡을 계약을
 *       서버에 둘 수 없다(서버 테스트의 러너는 {@code FakeEngineRunner} 다). 구우면 그 위험이 0 이다.</li>
 *   <li>"대기 0" 이 문자 그대로가 된다(AI 호출 0 <b>+ 러너 왕복 0</b>).</li>
 *   <li>그럼에도 <b>기존 플로우 밖으로 나가지 않는다</b> — 자산은 {@code match_halves} 의 같은 열로
 *       들어가므로 관전(로그 서빙)·결과·보상 봉투·정산이 전부 평소 경로다(새 뷰 경로 발명 0).</li>
 * </ul>
 *
 * <p><b>재현 가능하다</b>: {@code matchSeed} 를 그대로 싣고 하프 시드는 서버의
 * {@code Hashes.halfSeed} 와 <b>같은 식</b>으로 구웠다 — 굽는 스크립트
 * ({@code tools/bake-tutorial-match.mjs})를 다시 돌리면 같은 로그가 나온다(엔진 버전이 같다면).
 *
 * <p><b>메모리</b>: 원본 JSON 은 ~3.9MB 라 gzip(~0.47MB)으로 리소스에 넣고, 파싱 결과는
 * {@link SoftReference} 로만 들고 있는다 — 튜토리얼 매치는 유저당 1회라 상주시킬 이유가 없고,
 * 메모리 압박이 오면 GC 가 회수한다.
 */
@Component
public class TutorialMatchAsset {

    private static final Logger log = LoggerFactory.getLogger(TutorialMatchAsset.class);

    /** 굽는 스크립트의 출력 경로와 짝 — 바꾸면 {@code tools/bake-tutorial-match.mjs} 도 같이. */
    static final String RESOURCE = "tutorial/tutorial-match.json.gz";

    private final ObjectMapper objectMapper;
    private volatile SoftReference<JsonNode> cached = new SoftReference<>(null);

    public TutorialMatchAsset(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** 자산이 실려 있나 — 없으면 튜토리얼 매치 기능 전체가 꺼진다(부팅은 죽이지 않는다). */
    public boolean available() {
        return new ClassPathResource(RESOURCE).exists();
    }

    /** 굽는 데 쓴 매치 시드(hex) — {@code matches.seed} 에 그대로 박아 재현 가능성을 남긴다. */
    public String matchSeed() {
        return root().path("matchSeed").asText();
    }

    /** 구운 로그의 상대 로스터가 어느 시드봇인가 — {@code matches.bot_id} 가 이 값이어야 이름이 맞는다. */
    public String awayBotId() {
        return root().path("awayBotId").asText();
    }

    /** 구울 때의 엔진 버전 — {@code matches.engine_version} 에 그대로 들어간다(무엇으로 돌았나의 답). */
    public String engineVersion() {
        return root().path("engineVersion").asText("unknown");
    }

    /** 최종 스코어(유저=home). 계약이 "유저가 이긴다"를 자산 자체에 대고 검사할 때 쓴다. */
    public int finalHome() {
        return root().path("finalScore").path("home").asInt();
    }

    public int finalAway() {
        return root().path("finalScore").path("away").asInt();
    }

    /** 두 팀 로스터(엔진 입력) — 유저 보유 카드와 무관한 <b>고정 로스터</b>다. */
    public JsonNode selectData() {
        return root().path("selectData");
    }

    /**
     * 한 하프분 구운 결과. {@code MatchOrchestrator} 가 러너 응답 자리에 그대로 끼워 넣는다.
     */
    public record BakedHalf(String halfSeed, JsonNode homeInput, JsonNode awayInput,
                            JsonNode matchLog, JsonNode resumeState, String lastHash,
                            long playbackMs, String effectiveConfigHash) {
    }

    public BakedHalf half(int half) {
        for (JsonNode node : root().path("halves")) {
            if (node.path("half").asInt() == half) {
                JsonNode resume = node.path("resumeState");
                return new BakedHalf(
                        node.path("halfSeed").asText(),
                        node.path("homeInput"),
                        node.path("awayInput"),
                        node.path("matchLog"),
                        resume.isNull() || resume.isMissingNode() ? null : resume,
                        node.path("lastHash").isNull() ? null : node.path("lastHash").asText(null),
                        node.path("playbackMs").asLong(0L),
                        node.path("effectiveConfigHash").isNull()
                                ? null : node.path("effectiveConfigHash").asText(null));
            }
        }
        throw new IllegalStateException("튜토리얼 자산에 half " + half + " 가 없습니다");
    }

    private JsonNode root() {
        JsonNode hit = cached.get();
        if (hit != null) {
            return hit;
        }
        synchronized (this) {
            JsonNode again = cached.get();
            if (again != null) {
                return again;
            }
            JsonNode loaded = load();
            cached = new SoftReference<>(loaded);
            return loaded;
        }
    }

    private JsonNode load() {
        ClassPathResource resource = new ClassPathResource(RESOURCE);
        try (InputStream raw = resource.getInputStream();
             GZIPInputStream gz = new GZIPInputStream(new ByteArrayInputStream(raw.readAllBytes()))) {
            JsonNode node = objectMapper.readTree(gz);
            log.info("tutorial match asset loaded: seed={} score={}:{} engine={}",
                    node.path("matchSeed").asText(), node.path("finalScore").path("home").asInt(),
                    node.path("finalScore").path("away").asInt(), node.path("engineVersion").asText());
            return node;
        } catch (IOException e) {
            throw new IllegalStateException("튜토리얼 매치 자산을 읽지 못했습니다: " + RESOURCE, e);
        }
    }
}
