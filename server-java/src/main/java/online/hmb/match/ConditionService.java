package online.hmb.match;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * 매치 컨디션(AC-C1, LLD-p2-server §3) — 시드 결정론 롤 + SelectData 능력치 배율.
 *
 * <p>condition(playerId) = scale(sha256(matchSeed + ':cond:' + playerId)) ∈ [0.0, 1.0):
 * sha256 첫 8바이트를 unsigned 64bit 로 본 뒤 2^64 로 나눈다(엔진 시드 파생과 동일 계열,
 * {@code Hashes.deriveUint64Seed} 와 같은 바이트 규약). 같은 매치 seed → 같은 컨디션(재현).
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

    public ConditionService(@Value("${hmb.match.condition.min-mul}") double minMul,
                            @Value("${hmb.match.condition.max-mul}") double maxMul) {
        this.minMul = minMul;
        this.maxMul = maxMul;
    }

    /** condition ∈ [0,1) — sha256(matchSeed:cond:playerId) 첫 8바이트 / 2^64. 결정론. */
    public double roll(String matchSeed, String playerId) {
        byte[] digest = sha256(matchSeed + ":cond:" + playerId);
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
