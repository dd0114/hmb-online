package online.hmb.meta;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.springframework.stereotype.Service;

/**
 * 실효 AI 모드 보관소 (#471 AC3).
 *
 * <p><b>왜 서버가 이걸 아는가.</b> hero 요구는 <i>"클로드 로그인 안되어있으면 게임시작할때 안내말만하고
 * 스태틱 엔진으로 써있어야함"</i> 이다. 로그인 여부를 아는 것은 <b>AI 실행기 프로세스뿐</b>이고
 * (그 머신의 {@code claude} CLI 상태다), 안내를 띄워야 하는 것은 <b>웹</b>이다. 둘을 잇는 것이
 * 이 클래스다 — 실행기가 기동 프리플라이트 결과를 {@code POST /internal/ai-mode} 로 자기신고하고,
 * 웹은 {@code GET /api/config} 의 {@code ai} 로 읽는다.
 *
 * <p><b>미신고 = {@code unknown} 이지 {@code stub} 이 아니다.</b> Java 가 먼저 뜨고 실행기가 몇 초 뒤
 * 붙으므로, 그 창에서 {@code stub} 이라 답하면 로그인돼 있는 사용자에게 "스텁 엔진" 배너가 번쩍인다.
 * 모르는 것은 모른다고 말한다 — 웹은 {@code unknown} 에 아무것도 그리지 않는다.
 *
 * <p><b>왜 TTL 이 있나.</b> 실행기가 죽으면 마지막 신고가 영원히 남아 "live" 라고 거짓말한다.
 * 실행기는 {@code AI_MODE_HEARTBEAT_MS}(60초)마다 갱신하므로, 그보다 넉넉히 긴 {@link #TTL} 을
 * 넘긴 신고는 만료돼 다시 {@code unknown} 이 된다. 판정에 {@link Clock} 빈을 주입받는 이유는
 * 테스트가 시간을 고정할 수 있어야 하기 때문이다(이 리포의 {@code @Primary Clock} 관례).
 *
 * <p>인메모리다 — 프로세스 수명 밖으로 남길 이유가 없다(재기동하면 실행기가 다시 신고한다).
 */
@Service
public class AiModeService {

    /** 신고 유효 기간. 실행기 하트비트(60초)의 5배 — 일시적 네트워크 실패로 배너가 깜빡이지 않게. */
    public static final Duration TTL = Duration.ofMinutes(5);

    public static final String MODE_LIVE = "live";
    public static final String MODE_STUB = "stub";
    public static final String MODE_UNKNOWN = "unknown";

    private final Clock clock;
    private volatile Report last;

    public AiModeService(Clock clock) {
        this.clock = clock;
    }

    /** 실행기 자기신고. 같은 실행기가 반복 신고(하트비트)하는 것이 정상이다. */
    public void report(String mode, String reason, String wanted, String effective) {
        this.last = new Report(mode, reason, wanted, effective, clock.instant());
    }

    /** 현재 모드. 미신고·만료면 {@code unknown}. */
    public AiModeView current() {
        Report r = this.last;
        if (r == null) {
            return new AiModeView(MODE_UNKNOWN, "no-report", null, null);
        }
        if (Duration.between(r.at(), clock.instant()).compareTo(TTL) > 0) {
            return new AiModeView(MODE_UNKNOWN, "stale-report", r.wanted(), r.effective());
        }
        return new AiModeView(r.mode(), r.reason(), r.wanted(), r.effective());
    }

    /**
     * 웹이 보는 형태. {@code mode} 만으로 화면이 갈리고 {@code reason} 은 안내 문구·진단용이다
     * (사유 어휘의 단일 출처는 실행기의 {@code AI_MODE_REASONS}).
     */
    public record AiModeView(String mode, String reason, String wanted, String effective) {
    }

    private record Report(String mode, String reason, String wanted, String effective, Instant at) {
    }
}
