package online.hmb.match;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * 컨디션(AC-C1, LLD-p2-server §3) — 시드 결정론 롤 + SelectData 능력치 배율.
 *
 * <p>condition(playerId) = scale(sha256(seedPrefix + ':cond:' + playerId)) ∈ [0.0, 1.0):
 * sha256 첫 8바이트를 unsigned 64bit 로 본 뒤 2^64 로 나눈다(엔진 시드 파생과 동일 계열,
 * {@code Hashes.deriveUint64Seed} 와 같은 바이트 규약).
 *
 * <p><b>당일 컨디션(이슈 #98 계약 A)</b>: seedPrefix 는 매치 시드가 아니라 <b>{@code userId:kstDate}</b>
 * 다 — 즉 {@code sha256(userId + ':' + yyyy-MM-dd + ':cond:' + playerId)}. 같은 유저·같은 날이면
 * 매치와 무관하게 값이 고정되고 KST 자정에 갱신된다(덱/선수 리스트 상시 표시의 전제).
 * 날짜는 주입된 {@link Clock}(존 = {@code hmb.match.condition.zone}) 으로만 읽는다 —
 * {@code LocalDate.now()} 직접 호출 금지(테스트가 시각을 고정할 수 있어야 한다).
 * 매치 생성/킥오프 재캡처는 이 값을 {@code matches.conditions_json} 에 그대로 스냅샷하므로
 * 엔진 입력·재현 계약은 불변이다.
 *
 * <p>능력치 배율: {@code attr × (minMul + condition × (maxMul-minMul))} → 반올림 후 0..100 클램프
 * (config {@code hmb.match.condition.min-mul}=0.85 / {@code max-mul}=1.10). 12시(1.0)=+10% /
 * 6시(0.0)=-15%. 컨디션 롤이 없는 선수(예: 봇)는 배율 미적용(원본 능력치).
 */
@Service
public class ConditionService {

    private static final BigDecimal TWO_POW_64 = new BigDecimal(BigInteger.ONE.shiftLeft(64));

    private final double minMul;
    private final double maxMul;
    private final Clock clock;

    public ConditionService(@Value("${hmb.match.condition.min-mul}") double minMul,
                            @Value("${hmb.match.condition.max-mul}") double maxMul,
                            Clock clock) {
        this.minMul = minMul;
        this.maxMul = maxMul;
        this.clock = clock;
    }

    /** 오늘 날짜(Clock 존 = KST) {@code yyyy-MM-dd} — 컨디션 시드의 날짜 성분. */
    public String todayDate() {
        return LocalDate.now(clock).format(DateTimeFormatter.ISO_LOCAL_DATE);
    }

    /**
     * 임의 시각의 날짜(Clock 존 = KST) {@code yyyy-MM-dd}. 매치는 {@code matches.created_at} 을 이
     * 메서드로 변환해 컨디션 날짜를 <b>생성 시점에 앵커</b>한다(브리핑 중 자정 통과 시에도 시드 고정).
     */
    public String dateOf(Instant instant) {
        return LocalDate.ofInstant(instant, clock.getZone()).format(DateTimeFormatter.ISO_LOCAL_DATE);
    }

    /** 오늘(KST) 컨디션 — {@code rollDaily(userId, todayDate(), playerId)}. */
    public double rollToday(String userId, String playerId) {
        return rollDaily(userId, todayDate(), playerId);
    }

    /** 날짜시드 컨디션 ∈ [0,1) — sha256(userId:date:cond:playerId). 결정론(같은 유저·날짜·선수). */
    public double rollDaily(String userId, String date, String playerId) {
        return roll(userId + ":" + date, playerId);
    }

    /** condition ∈ [0,1) — sha256(seedPrefix:cond:playerId) 첫 8바이트 / 2^64. 바이트 규약(불변). */
    public double roll(String seedPrefix, String playerId) {
        byte[] digest = sha256(seedPrefix + ":cond:" + playerId);
        byte[] first8 = new byte[8];
        System.arraycopy(digest, 0, first8, 0, 8);
        BigInteger unsigned = new BigInteger(1, first8);
        return new BigDecimal(unsigned).divide(TWO_POW_64, MathContext.DECIMAL64).doubleValue();
    }

    /** 능력치 1개에 컨디션 배율 적용 → 반올림 후 0..100 클램프. */
    public int scaleAttribute(int attr, double condition) {
        double mul = minMul + condition * (maxMul - minMul);
        long scaled = Math.round(attr * mul);
        if (scaled < 0) {
            return 0;
        }
        if (scaled > 100) {
            return 100;
        }
        return (int) scaled;
    }

    public double minMul() {
        return minMul;
    }

    public double maxMul() {
        return maxMul;
    }

    private static byte[] sha256(String input) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** BigDecimal 반올림 헬퍼(테스트에서 조건→배율 검증에 쓰지 않지만 명세 노출용). */
    static double rounded(double value, int scale) {
        return BigDecimal.valueOf(value).setScale(scale, RoundingMode.HALF_UP).doubleValue();
    }
}
