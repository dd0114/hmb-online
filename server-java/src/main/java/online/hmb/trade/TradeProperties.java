package online.hmb.trade;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 트레이드 런타임 오버라이드(#149) — {@code hmb.trade.*}.
 *
 * <p>레어도별 카운트다운의 SoT 는 economy {@code trade.waitHours[grade]}(시간 단위)다. 데모/로컬에서
 * 시간 단위는 관전이 불가능하므로 <b>초 단위 오버라이드</b>를 둔다(하드코딩 금지 — 값은 전부 config):
 *
 * <pre>
 * hmb:
 *   trade:
 *     wait-seconds: {}          # 기본 비움 = 무회귀(waitHours 사용)
 *       # GOLD: 10              # 이 등급만 10초로
 * </pre>
 *
 * <p>env 로도 주입한다: {@code HMB_TRADE_WAITSECONDS_GOLD=10} (relaxed binding — 대시 제거·대문자).
 * env 로 들어온 키는 소문자로 정규화되므로 조회는 대소문자 무시로 한다.
 */
@Component
@ConfigurationProperties(prefix = "hmb.trade")
public class TradeProperties {

    /** grade(BRONZE|SILVER|GOLD|DIA|LEGEND) → 대기 초. 비어 있으면 economy waitHours 를 쓴다. */
    private Map<String, Integer> waitSeconds = new LinkedHashMap<>();

    public Map<String, Integer> getWaitSeconds() {
        return waitSeconds;
    }

    public void setWaitSeconds(Map<String, Integer> waitSeconds) {
        this.waitSeconds = waitSeconds == null ? new LinkedHashMap<>() : waitSeconds;
    }

    /** 해당 등급의 초 단위 오버라이드(대소문자 무시). 없으면 empty → 호출측이 waitHours 로 폴백. */
    public Optional<Integer> waitSecondsFor(String grade) {
        if (grade == null || waitSeconds.isEmpty()) {
            return Optional.empty();
        }
        for (Map.Entry<String, Integer> e : waitSeconds.entrySet()) {
            if (e.getKey() != null && e.getKey().toLowerCase(Locale.ROOT).equals(grade.toLowerCase(Locale.ROOT))
                    && e.getValue() != null) {
                return Optional.of(e.getValue());
            }
        }
        return Optional.empty();
    }
}
