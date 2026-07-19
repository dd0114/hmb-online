package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import online.hmb.match.ConditionService;
import org.junit.jupiter.api.Test;

/**
 * 컨디션 '당일' 전환(이슈 #98 계약 A) 단위 검증 — 롤 입력이 매치시드에서 **날짜시드**로 바뀐다:
 * {@code sha256(userId + ":" + kstDate + ":cond:" + playerId)}. 바이트 규약(첫 8바이트 unsigned/2^64)과
 * 배율(min-mul/max-mul) 로직은 불변이어야 한다(회귀).
 *
 * <p>Clock 은 주입식 — 테스트가 KST 자정 경계를 고정 시각으로 재현한다({@code LocalDate.now()} 직접
 * 호출 금지). 존은 config({@code hmb.match.condition.zone}) 로 주입된 Clock 이 들고 있다.
 */
class ConditionDailyRollTest {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");

    private static ConditionService at(String instant) {
        return new ConditionService(0.85, 1.10, Clock.fixed(Instant.parse(instant), KST));
    }

    // ── 날짜(KST) 경계 ────────────────────────────────────────────────────

    @Test
    void todayDateUsesKstNotUtc() {
        // 2026-07-19T14:59:59Z = KST 2026-07-19 23:59:59 (아직 19일)
        assertThat(at("2026-07-19T14:59:59Z").todayDate()).isEqualTo("2026-07-19");
        // 2026-07-19T15:00:00Z = KST 2026-07-20 00:00:00 (자정 넘어 20일)
        assertThat(at("2026-07-19T15:00:00Z").todayDate()).isEqualTo("2026-07-20");
    }

    @Test
    void rollFlipsExactlyAtKstMidnight() {
        ConditionService before = at("2026-07-19T14:59:59Z");
        ConditionService justBefore = at("2026-07-19T00:00:01Z"); // 같은 KST 날짜(19일 09:00)
        ConditionService after = at("2026-07-19T15:00:00Z");

        double b = before.rollToday("U1", "P001");
        assertThat(justBefore.rollToday("U1", "P001")).isEqualTo(b); // 같은 날 = 하루 고정
        assertThat(after.rollToday("U1", "P001")).isNotEqualTo(b);   // 자정 넘으면 갱신
    }

    // ── 결정론 / 시드 분리 ────────────────────────────────────────────────

    @Test
    void sameUserDatePlayerIsDeterministic() {
        ConditionService svc = at("2026-07-19T03:00:00Z");
        double first = svc.rollDaily("U1", "2026-07-19", "P001");
        assertThat(svc.rollDaily("U1", "2026-07-19", "P001")).isEqualTo(first);
        assertThat(first).isBetween(0.0, 1.0);
    }

    @Test
    void differentUserOrDateOrPlayerGivesDifferentValue() {
        ConditionService svc = at("2026-07-19T03:00:00Z");
        double base = svc.rollDaily("U1", "2026-07-19", "P001");
        assertThat(svc.rollDaily("U2", "2026-07-19", "P001")).isNotEqualTo(base);
        assertThat(svc.rollDaily("U1", "2026-07-20", "P001")).isNotEqualTo(base);
        assertThat(svc.rollDaily("U1", "2026-07-19", "P002")).isNotEqualTo(base);
    }

    @Test
    void rollTodayEqualsRollDailyWithTodayDate() {
        ConditionService svc = at("2026-07-19T03:00:00Z");
        assertThat(svc.rollToday("U1", "P007"))
                .isEqualTo(svc.rollDaily("U1", svc.todayDate(), "P007"));
    }

    /** 날짜시드는 기존 바이트 규약(prefix + ":cond:" + playerId)을 그대로 재사용한다. */
    @Test
    void dailyRollReusesExistingByteContract() {
        ConditionService svc = at("2026-07-19T03:00:00Z");
        assertThat(svc.rollDaily("U1", "2026-07-19", "P001"))
                .isEqualTo(svc.roll("U1:2026-07-19", "P001"));
    }

    /** 원시 roll(seed 임의 문자열)의 값은 회귀 없이 유지(엔진/재현 계열 바이트 규약 고정). */
    @Test
    void rawRollByteContractUnchanged() {
        ConditionService svc = at("2026-07-19T03:00:00Z");
        double v = svc.roll("seedhex", "P001");
        assertThat(v).isBetween(0.0, 1.0);
        // sha256("seedhex:cond:P001") 첫 8바이트 / 2^64 — 고정 기대값(회귀 가드)
        assertThat(v).isEqualTo(expectedRoll("seedhex:cond:P001"));
    }

    private static double expectedRoll(String input) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(input.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            java.math.BigInteger unsigned = new java.math.BigInteger(1, java.util.Arrays.copyOf(d, 8));
            return new java.math.BigDecimal(unsigned)
                    .divide(new java.math.BigDecimal(java.math.BigInteger.ONE.shiftLeft(64)),
                            java.math.MathContext.DECIMAL64)
                    .doubleValue();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ── 배율 회귀(불변) ───────────────────────────────────────────────────

    @Test
    void scaleAttributeUnchanged() {
        ConditionService svc = at("2026-07-19T03:00:00Z");
        assertThat(svc.scaleAttribute(40, 0.0)).isEqualTo(34);  // 40 × 0.85
        assertThat(svc.scaleAttribute(40, 1.0)).isEqualTo(44);  // 40 × 1.10
        assertThat(svc.scaleAttribute(100, 1.0)).isEqualTo(100); // 클램프
        assertThat(svc.scaleAttribute(0, 1.0)).isEqualTo(0);
        assertThat(svc.minMul()).isEqualTo(0.85);
        assertThat(svc.maxMul()).isEqualTo(1.10);
    }
}
