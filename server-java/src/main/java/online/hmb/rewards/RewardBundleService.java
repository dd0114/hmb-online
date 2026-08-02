package online.hmb.rewards;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import online.hmb.common.ApiException;
import online.hmb.common.Ulid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * <b>보상 봉투</b>(#405 W2b, 설계 §2.9) — hero 요구 *"앞으로 모든 보상이 이 탭 구조를 쓴다"*.
 *
 * <p>그래서 매치 전용 응답이 아니라 <b>공용 계약</b>이다. E5(데일리 미션)·리그·우편이
 * {@code source} 만 바꿔 그대로 재사용한다.
 *
 * <pre>
 * RewardBundle {
 *   bundleId, source: MATCH|MISSION|LEAGUE|MAIL, sourceRef, acknowledgedAt,
 *   sections: [ { kind:"CURRENCY", entries:[{code, amount}] },
 *               { kind:"GROWTH",   entries:[{playerId, name, position, grade,
 *                                            xpGained, levelBefore, levelAfter,
 *                                            pendingChoices:[{choiceId, level,
 *                                                             candidates:[{stat,gain}]}]}] } ]
 * }
 * </pre>
 *
 * <p><b>재화는 코드만 싣는다</b>({@code {"code":"POINT","amount":120}}) — 이름·심볼은 economy 표기
 * 메타의 몫이고 서버 문자열에 박으면 표기 변경이 곧 배포가 된다(#232). 화면은 {@code <Amount code=… />}
 * 로 그린다.
 *
 * <p><b>멱등</b>은 {@code UNIQUE(source, source_ref, user_id)} 다. 같은 매치가 두 번 정산 시도되어도
 * 봉투는 하나이고, ack 도 이미 확인된 봉투에 다시 오면 200 이다(재시도가 에러가 되면 클라가 영원히
 * 재시도한다).
 */
@Service
public class RewardBundleService {

    private static final Logger log = LoggerFactory.getLogger(RewardBundleService.class);

    public static final String SOURCE_MATCH = "MATCH";
    public static final String KIND_CURRENCY = "CURRENCY";
    public static final String KIND_GROWTH = "GROWTH";

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public RewardBundleService(JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    /** 섹션 한 칸 — {@code kind} 는 web 의 섹션 레지스트리 키다(설계 §2.9.1). */
    public record Section(String kind, List<Map<String, Object>> entries) {
    }

    public record Bundle(String bundleId, String source, String sourceRef, String acknowledgedAt,
                         List<Map<String, Object>> sections) {
    }

    /**
     * 봉투 생성(멱등). <b>빈 봉투는 만들지 않는다</b> — 확인할 것이 없는 오버레이가 뜨면 유저는
     * 매 경기 의미 없는 [확인]을 한 번 더 눌러야 한다.
     *
     * @return 생성됐거나 이미 있던 봉투 id. 실을 것이 없으면 empty.
     */
    public Optional<String> create(String userId, String source, String sourceRef, List<Section> sections) {
        List<Section> live = sections.stream().filter(s -> s.entries() != null && !s.entries().isEmpty()).toList();
        if (live.isEmpty()) {
            return Optional.empty();
        }
        String id = Ulid.next();
        try {
            int inserted = jdbcClient.sql("""
                            INSERT OR IGNORE INTO reward_bundles(id, user_id, source, source_ref,
                                sections_json, created_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                            """)
                    .params(id, userId, source, sourceRef, toJson(live), Instant.now().toString())
                    .update();
            if (inserted == 1) {
                return Optional.of(id);
            }
        } catch (RuntimeException e) {
            // 보상 봉투는 **표시용**이다 — 실패가 정산(원장·전적)을 되돌리면 안 된다.
            log.warn("보상 봉투 생성 실패 source={} ref={}: {}", source, sourceRef, e.toString());
            return Optional.empty();
        }
        return find(userId, source, sourceRef).map(Bundle::bundleId);
    }

    public Optional<Bundle> find(String userId, String source, String sourceRef) {
        return jdbcClient.sql("""
                        SELECT id, source, source_ref, sections_json, acknowledged_at
                        FROM reward_bundles WHERE user_id = ? AND source = ? AND source_ref = ?
                        """)
                .params(userId, source, sourceRef)
                .query(this::map)
                .optional();
    }

    /** 매치 결과 화면이 쓰는 조회 — 없으면 empty(W2b 이전에 끝난 매치는 봉투가 없다). */
    public Optional<Bundle> ofMatch(String userId, String matchId) {
        return find(userId, SOURCE_MATCH, matchId);
    }

    /**
     * 확인 처리. <b>멱등</b> — 이미 확인된 봉투에 다시 와도 200 이고 시각은 <b>처음 것을 유지</b>한다
     * (CAS `WHERE acknowledged_at IS NULL`). 덮어쓰면 "언제 봤나"가 재시도마다 미래로 밀린다.
     */
    public Bundle acknowledge(String userId, String bundleId) {
        Bundle bundle = byId(userId, bundleId)
                .orElseThrow(() -> ApiException.notFound("보상을 찾을 수 없습니다: " + bundleId));
        if (bundle.acknowledgedAt() == null) {
            jdbcClient.sql("""
                            UPDATE reward_bundles SET acknowledged_at = ?
                            WHERE id = ? AND user_id = ? AND acknowledged_at IS NULL
                            """)
                    .params(Instant.now().toString(), bundleId, userId)
                    .update();
        }
        return byId(userId, bundleId).orElse(bundle);
    }

    public Optional<Bundle> byId(String userId, String bundleId) {
        return jdbcClient.sql("""
                        SELECT id, source, source_ref, sections_json, acknowledged_at
                        FROM reward_bundles WHERE id = ? AND user_id = ?
                        """)
                .params(bundleId, userId)
                .query(this::map)
                .optional();
    }

    /** 재화 엔트리 — <b>코드와 수량만</b>. 이름·심볼은 여기 오지 않는다(#232). */
    public static Map<String, Object> currency(String code, long amount) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("amount", amount);
        return m;
    }

    private Bundle map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new Bundle(rs.getString("id"), rs.getString("source"), rs.getString("source_ref"),
                rs.getString("acknowledged_at"), readSections(rs.getString("sections_json")));
    }

    private List<Map<String, Object>> readSections(String json) {
        try {
            return objectMapper.readValue(json, new TypeReference<List<Map<String, Object>>>() { });
        } catch (Exception e) {
            log.warn("sections_json 파싱 실패: {}", e.toString());
            return List.of();
        }
    }

    private String toJson(List<Section> sections) {
        try {
            List<Map<String, Object>> raw = new ArrayList<>();
            for (Section s : sections) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("kind", s.kind());
                m.put("entries", s.entries());
                raw.add(m);
            }
            return objectMapper.writeValueAsString(raw);
        } catch (Exception e) {
            throw new IllegalStateException("sections_json 직렬화 실패: " + e.getMessage(), e);
        }
    }
}
