package online.hmb.away;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.Scheduled;

/**
 * 주간 시즌 마감 스윕(#245 hero E5).
 *
 * <p>주기가 길어도 되는 이유: 마감 판정이 "지금이 몇 주차인가"가 아니라 <b>ends_at 을 지난 ACTIVE 행이
 * 있는가</b> 라서, 늦게 돌아도 밀린 시즌이 순서대로 정산된다(서버가 며칠 꺼져 있어도 보상이 사라지지
 * 않는다). 그래서 시계 스위퍼(1s)·잡 스위퍼(10s)와 달리 분 단위로 충분하다.
 */
@Configuration
@EnableConfigurationProperties(AwaySeasonService.SeasonRewards.class)
public class AwaySeasonSweeper {

    private static final Logger log = LoggerFactory.getLogger(AwaySeasonSweeper.class);

    private final AwaySeasonService seasonService;

    public AwaySeasonSweeper(AwaySeasonService seasonService) {
        this.seasonService = seasonService;
    }

    @Scheduled(fixedRateString = "${hmb.away.season.sweep-interval-ms}")
    public void sweep() {
        try {
            int closed = seasonService.sweepDueSeasons();
            if (closed > 0) {
                log.info("away season sweep: {} season(s) closed", closed);
            }
        } catch (RuntimeException e) {
            // 스윕이 죽어도 서비스는 계속 돈다 — 다음 주기가 다시 시도한다.
            log.warn("away season sweep failed: {}", e.toString());
        }
    }
}
