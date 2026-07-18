package online.hmb.league;

import java.security.SecureRandom;
import org.springframework.stereotype.Component;

/** 기본 시즌 seed 공급 — SecureRandom 16바이트 hex(감사·재현용, 결정론 계약 밖). */
@Component
public class SecureLeagueSeedSource implements LeagueSeedSource {

    private final SecureRandom secureRandom = new SecureRandom();

    @Override
    public String newSeed() {
        byte[] bytes = new byte[16];
        secureRandom.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
