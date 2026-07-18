package online.hmb.meta;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import online.hmb.common.ApiException;

/**
 * 수동 팀 전술(P2-D4): {line, press, tempo, width} 각 0.0~1.0. 스냅샷 저장(PUT /api/presets/team)과
 * 매치 스냅샷(user_deck_json)에서 공용 검증. teamTactics 는 AI 컨텍스트로 전달된다(LLD-p2-server §4) —
 * AI 는 이 값을 베이스(A)로 받고 프롬프트로 보정만 한다(perf #82 A+B 구조와 정합).
 */
public final class TeamTactics {

    /** 4축 — zod manualTactics 와 필드명 일치(camelCase, LLD §4). */
    public static final List<String> FIELDS = List.of("line", "press", "tempo", "width");

    private TeamTactics() {
    }

    /** null/missing/JSON null 은 "미지정"으로 통과. 존재하면 4축 전부 필수 + 각 0..1. */
    public static void validate(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return;
        }
        if (!node.isObject()) {
            throw ApiException.validation("teamTactics는 객체여야 합니다");
        }
        for (String field : FIELDS) {
            JsonNode value = node.get(field);
            if (value == null || value.isNull() || !value.isNumber()) {
                throw ApiException.validation("teamTactics." + field + "가 없거나 숫자가 아닙니다");
            }
            double d = value.asDouble();
            if (d < 0.0 || d > 1.0) {
                throw ApiException.validation("teamTactics." + field + "는 0.0~1.0 범위여야 합니다");
            }
        }
    }
}
