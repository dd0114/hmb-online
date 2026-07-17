package online.hmb.common;

import java.security.SecureRandom;
import java.time.Instant;

/**
 * ULID 생성 유틸 (시간순 정렬 PK). 48bit ms timestamp + 80bit random, Crockford Base32.
 * 결정론 엔진과 무관한 서버측 ID 생성(요청마다 SecureRandom 사용은 허용 — PRD §2-5는
 * engine 도메인의 결정론 규칙이며 server-java ID 채번에는 적용되지 않는다).
 */
public final class Ulid {
    private static final char[] CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final SecureRandom RANDOM = new SecureRandom();

    private Ulid() {
    }

    public static String next() {
        return next(Instant.now().toEpochMilli());
    }

    static String next(long timestampMs) {
        byte[] randomBytes = new byte[10];
        RANDOM.nextBytes(randomBytes);

        long time = timestampMs & 0xFFFFFFFFFFFFL; // 48 bits
        StringBuilder sb = new StringBuilder(26);

        // 48-bit timestamp -> 10 base32 chars
        for (int i = 9; i >= 0; i--) {
            int shift = i * 5;
            int idx = (int) ((time >>> shift) & 0x1F);
            sb.append(CROCKFORD[idx]);
        }

        // 80-bit randomness -> 16 base32 chars
        long randHi = ((long) (randomBytes[0] & 0xFF) << 32)
                | ((long) (randomBytes[1] & 0xFF) << 24)
                | ((long) (randomBytes[2] & 0xFF) << 16)
                | ((long) (randomBytes[3] & 0xFF) << 8)
                | (randomBytes[4] & 0xFF);
        long randLo = ((long) (randomBytes[5] & 0xFF) << 32)
                | ((long) (randomBytes[6] & 0xFF) << 24)
                | ((long) (randomBytes[7] & 0xFF) << 16)
                | ((long) (randomBytes[8] & 0xFF) << 8)
                | (randomBytes[9] & 0xFF);

        for (int i = 7; i >= 0; i--) {
            sb.append(CROCKFORD[(int) ((randHi >>> (i * 5)) & 0x1F)]);
        }
        for (int i = 7; i >= 0; i--) {
            sb.append(CROCKFORD[(int) ((randLo >>> (i * 5)) & 0x1F)]);
        }

        return sb.toString();
    }

    /** 세션 토큰 등 불투명 랜덤 토큰(ULID와 별도, 예측 불가 목적). */
    public static String opaqueToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(64);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
