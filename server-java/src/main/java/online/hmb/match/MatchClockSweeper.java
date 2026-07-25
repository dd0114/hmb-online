package online.hmb.match;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 매치 시계 스위퍼 (P4-D1, LLD-e2-flow-clock §7.4).
 *
 * <p><b>이게 "화면을 안 봐도 경기가 진행된다"의 실체다</b>: 아무도 보고 있지 않은 매치도 전반 종료 →
 * 감독시간 → 후반 시뮬로 넘어간다.
 *
 * <p>조회 경로(GET)는 <b>가벼운 전이만</b> 지연 평가한다({@link MatchClockService#advanceDueForRead}) —
 * 전반 종료·후반 종료 정산은 보고 있는 화면에서도 즉시 반영되지만, <b>후반 시작(엔진 RPC 동반)은 오직
 * 여기</b>서만 일어난다. 즉 이 스위퍼가 멈추면 감독시간에서 더 나아가지 않는다(유저의 수동
 * {@code POST /resume} 은 여전히 열려 있어 완전한 데드락은 아니다).
 *
 * <p>대부분의 테스트는 결정론을 위해 {@link #sweep()} 을 직접 호출한다(스케줄러가 끼면 단계가 앞서간다).
 * <b>스케줄러 배선 자체</b>는 {@code MatchClockSchedulerTest} 가 짧은 주기로 실제로 돌려 검증한다.
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
