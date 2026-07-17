package online.hmb.common;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Map;

/**
 * 해시·시드 파생 유틸 (매치플로우 결정론 계약).
 *
 * - canonicalJson: 키 알파벳 정렬 직렬화 — 같은 컨텍스트 → 같은 문자열 → 같은 잡 id
 *   (ai_jobs.id = sha256(canonicalJson(context))[:32], LLD §5.2 멱등/L1 재사용).
 * - halfSeed 파생(LLD §5.1 ERD 주석 "seed+':h1' 해시"): 엔진 시드 계약이 uint64 10진 문자열
 *   (shared TacticalInput.seed, R8 결정)이므로 sha256 첫 8바이트를 unsigned 10진수로 변환한다.
 *   matches.seed(hex)와 달리 러너로 나가는 시드는 전부 이 형식.
 */
public final class Hashes {

    private static final ObjectMapper CANONICAL = new ObjectMapper()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    private Hashes() {
    }

    public static String sha256Hex(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 중첩 Map까지 키 정렬된 canonical JSON. 입력은 Map/List/스칼라 트리(Jackson 변환 가능형). */
    public static String canonicalJson(Object tree) {
        try {
            // ORDER_MAP_ENTRIES_BY_KEYS는 Map 직렬화에만 적용되므로 먼저 Map 트리로 변환
            Object asMapTree = CANONICAL.convertValue(tree, Object.class);
            return CANONICAL.writeValueAsString(asMapTree);
        } catch (RuntimeException | Error e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("canonicalJson 실패", e);
        }
    }

    /** sha256(input) 첫 8바이트 → unsigned 64bit 10진 문자열 (엔진 시드 계약 형식). */
    public static String deriveUint64Seed(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(input.getBytes(StandardCharsets.UTF_8));
            byte[] first8 = new byte[8];
            System.arraycopy(digest, 0, first8, 0, 8);
            return new BigInteger(1, first8).toString(10);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * half 시뮬 시드: sha256(matchSeed + ":h" + half) → uint64 10진.
     * SimulateRequest.seed 및 match_halves.half_seed에 사용.
     */
    public static String halfSeed(String matchSeed, int half) {
        return deriveUint64Seed(matchSeed + ":h" + half);
    }

    /** 잡 컨텍스트 시드(side별 파생, LLD §5.2): sha256(matchSeed + ":h{half}:{side}") → uint64 10진. */
    public static String jobSeed(String matchSeed, int half, String side) {
        return deriveUint64Seed(matchSeed + ":h" + half + ":" + side);
    }

    /** ai_jobs.id = sha256(canonicalJson(context)) 앞 32 hex (LLD §5.2). */
    public static String jobId(Map<String, Object> context) {
        return sha256Hex(canonicalJson(context)).substring(0, 32);
    }
}
