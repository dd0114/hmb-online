package online.hmb.trade;

import java.security.SecureRandom;
import org.springframework.stereotype.Component;

/** 프로덕션 트레이드 시드 공급자 — SecureRandom 128-bit hex(Gacha 시드와 동일 규약). */
@Component
public class SecureTradeSeedSource implements TradeSeedSource {

    private final SecureRandom secureRandom = new SecureRandom();

    @Override
    public String newSeed() {
        byte[] bytes = new byte[16]; // 128 bit
        secureRandom.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
