package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import online.hmb.match.MatchClockService;
import org.junit.jupiter.api.Test;

/**
 * 만료 판정 술어 (P4-E2 #170). Spring 부팅 없이 경계만 본다 — 특히 <b>정확 동치</b>:
 * `now == phaseEndsAt` 인 순간 그 단계는 이미 끝난 것이다(LLD §7.2 `<= now`).
 * 통합 테스트는 항상 "과거로 밀어" 만료시키므로 이 경계는 여기서만 잡힌다(독립검증 minor).
 */
class MatchClockDuePredicateTest {

    private static final String T = "2026-07-25T12:00:00.000Z";

    @Test
    void boundaryEqualityCountsAsDue() {
        assertThat(MatchClockService.isDue(T, T)).isTrue();
    }

    @Test
    void beforeBoundaryIsNotDue() {
        assertThat(MatchClockService.isDue("2026-07-25T11:59:59.999Z", T)).isFalse();
    }

    @Test
    void afterBoundaryIsDue() {
        assertThat(MatchClockService.isDue("2026-07-25T12:00:00.001Z", T)).isTrue();
    }

    @Test
    void noWindowIsNeverDue() {
        assertThat(MatchClockService.isDue(T, null)).isFalse();
    }

    @Test
    void fixedWidthFormatMakesStringOrderEqualTimeOrder() {
        // 밀리초를 생략하는 Instant.toString() 이었다면 ".000Z" < "Z" 라 순서가 뒤집힌다.
        String early = MatchClockService.format(java.time.Instant.parse("2026-07-25T12:00:00Z"));
        String later = MatchClockService.format(java.time.Instant.parse("2026-07-25T12:00:00.500Z"));
        assertThat(early).isLessThan(later);
        assertThat(MatchClockService.isDue(early, later)).isFalse();
        assertThat(MatchClockService.isDue(later, early)).isTrue();
    }
}
