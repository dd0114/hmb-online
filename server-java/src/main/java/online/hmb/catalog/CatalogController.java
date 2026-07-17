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
 * GET /api/players — 카탈로그 전체(110명) + owned/ownedCount 병합(도감·덱 화면 공용, AC-S3).
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
                        SELECT p.id, p.name, p.position, p.grade, p.attributes_json,
                               COALESCE(up.count, 0) AS owned_count
                        FROM players p
                        LEFT JOIN user_players up ON up.player_id = p.id AND up.user_id = ?
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
                        rs.getInt("owned_count")))
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

    public record CatalogPlayer(String id, String name, String position, String grade,
                                 Map<String, Object> attributes, boolean owned, int ownedCount) {
    }
}
