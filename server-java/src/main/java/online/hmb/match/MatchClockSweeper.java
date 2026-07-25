package online.hmb.match;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 매치 시계 스위퍼 (P4-D1, LLD-e2-flow-clock §7.4).
 *
 * <p><b>이게 "화면을 안 봐도 경기가 진행된다"의 실체다</b>: 아무도 보고 있지 않은 매치도 전반 종료 →
 * 감독시간 → 후반 시뮬로 넘어간다. 보고 있는 화면은 GET 이 같은 로직을 지연 평가하므로(MatchController)
 * 스위퍼가 죽어도 정확하고, 스위퍼는 안 보는 매치도 진행시킨다 — 둘은 서로의 백스톱이다.
 *
 * <p>테스트는 {@link #sweep()} 을 직접 호출한다(타이밍 비의존 — JobLeaseSweeper 와 동일 규율).
 */
@Component
public class MatchClockSweeper {

    private static final Logger log = LoggerFactory.getLogger(MatchClockSweeper.class);

    private final MatchClockService clockService;

    public MatchClockSweeper(MatchClockService clockService) {
        this.clockService = clockService;
    }

    @Scheduled(fixedDelayString = "${hmb.match.clock.sweep-interval-ms}")
    public int sweep() {
        int advanced = clockService.advanceAllDue();
        if (advanced > 0) {
            log.info("match clock sweep: {} matches advanced", advanced);
        }
        return advanced;
    }
}
