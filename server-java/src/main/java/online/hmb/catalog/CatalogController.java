package online.hmb.catalog;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/players — 카탈로그 전체 + owned/ownedCount 병합(도감·덱 화면 공용, AC-S3).
 *
 * <p><b>#207 비활성 유닛 정책</b>: {@code active=0} 은 목록에서 빠지되 <b>보유분은 계속 보인다</b>
 * ({@code WHERE p.active = 1 OR 보유수 > 0}). 이유는 이 엔드포인트가 도감<b>과</b> 덱 편성 화면
 * 공용이기 때문이다 — 무조건 걸러 버리면 이미 가진 카드가 덱 화면에서 사라져 사실상
 * <b>뺏는 것</b>이 되고, 그건 U-D1(조합안 = 기보유 유저 손실 0)에 정면으로 어긋난다.
 * 차단 대상은 <b>신규 획득</b>이지 보유가 아니다.
 *
 * <p>그 결과 보유한 비활성 유닛은 목록에 남는데, 클라가 그걸 <b>비활성으로 표기할 수단이 없었다</b>
 * (U-D7) — 유저에겐 "도감에 있는데 아무리 뽑아도 안 나온다"가 된다. 그래서 {@code active} 를
 * 응답에 그대로 실어 내려준다. <b>필터는 그대로고 노출만 추가</b>다.
 */
@RestController
public class CatalogController {

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public CatalogController(JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    @GetMapping("/api/players")
    public List<CatalogPlayer> players(@RequestAttribute("userId") String userId) {
        return jdbcClient.sql("""
                        SELECT p.id, p.name, p.position, p.grade, p.attributes_json, p.active,
                               COALESCE(up.count, 0) AS owned_count
                        FROM players p
                        LEFT JOIN user_players up ON up.player_id = p.id AND up.user_id = ?
                        WHERE p.active = 1 OR COALESCE(up.count, 0) > 0
                        ORDER BY p.id
                        """)
                .param(userId)
                .query((rs, rowNum) -> new CatalogPlayer(
                        rs.getString("id"),
                        rs.getString("name"),
                        rs.getString("position"),
                        rs.getString("grade"),
                        parseAttributes(rs.getString("attributes_json")),
                        rs.getInt("owned_count") > 0,
                        rs.getInt("owned_count"),
                        rs.getInt("active") == 1))
                .list();
    }

    private Map<String, Object> parseAttributes(String json) {
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {
            });
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("players.attributes_json 파싱 실패: " + e.getMessage(), e);
        }
    }
}
