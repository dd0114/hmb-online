package online.hmb.match;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/conditions/today (openapi-v2 ConditionMap, 이슈 #98 요구 6) — 로그인 유저의 <b>보유
 * 선수</b> 당일 컨디션 {playerId: 0.0~1.0}. 덱/선수 리스트 상시 표시용.
 *
 * <p>값은 날짜시드 결정론 롤({@link ConditionService#rollDaily})이라 저장하지 않는다(파생값) —
 * 매치 생성/킥오프 재캡처가 같은 값을 {@code matches.conditions_json} 에 스냅샷하므로 엔진 입력·
 * 재현 계약은 그대로다. 보유 조회는 {@code user_players}(카탈로그 전체 아님).
 */
@RestController
public class ConditionsController {

    private final JdbcClient jdbcClient;
    private final ConditionService conditionService;

    public ConditionsController(JdbcClient jdbcClient, ConditionService conditionService) {
        this.jdbcClient = jdbcClient;
        this.conditionService = conditionService;
    }

    @GetMapping("/api/conditions/today")
    public Map<String, Double> today(@RequestAttribute("userId") String userId) {
        String date = conditionService.todayDate();
        Map<String, Double> conditions = new LinkedHashMap<>();
        jdbcClient.sql("SELECT player_id FROM user_players WHERE user_id = ? ORDER BY player_id")
                .param(userId)
                .query(String.class)
                .list()
                .forEach(playerId -> conditions.put(playerId,
                        conditionService.rollDaily(userId, date, playerId)));
        return conditions;
    }
}
