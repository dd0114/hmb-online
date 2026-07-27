package online.hmb.match;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 방치 매치 회수 스위퍼 (#217 AC3). 잠금을 켠 대가로 반드시 있어야 하는 <b>마지막 그물</b>이다 —
 * 수동 포기가 못 여는 구멍(시계 스위퍼도 죽고 유저도 안 돌아오는 경우)이 계정을 영구히 잠그면 안 된다.
 *
 * <p>주기가 길다(기본 10분). 시계 스위퍼(1s)·잡 스위퍼(10s)와 달리 여기서 다루는 건 "몇 시간째
 * 안 끝난" 매치라 촘촘히 돌 이유가 없다. 테스트는 {@link MatchLockService#sweepStale()} 을 직접 부른다.
 */
@Component
public class MatchAbandonSweeper {

    private final MatchLockService lockService;

    public MatchAbandonSweeper(MatchLockService lockService) {
        this.lockService = lockService;
    }

    @Scheduled(fixedDelayString = "${hmb.match.abandon.sweep-interval-ms}")
    public int sweep() {
        return lockService.sweepStale();
    }
}
