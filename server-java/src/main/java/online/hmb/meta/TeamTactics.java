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

    /** 슬라이더 중앙 = web {@code DEFAULT_TEAM_TACTICS}(deck/tactics-logic.ts) — "안 건드림"의 값. */
    public static final double NEUTRAL = 0.5;

    private TeamTactics() {
    }

    /**
     * 전 축이 중앙값인가 = <b>유저가 슬라이더를 건드리지 않았다</b>.
     *
     * <p>왜 필요한가(#215 W2): 브리핑 UI 는 수동 전술 모드가 기본이라 손대지 않아도 킥오프에
     * {@code {0.5,0.5,0.5,0.5}} 를 항상 실어 보낸다. 이걸 "지정된 전술"로 보면 <b>아무것도 바꾸지 않은
     * 유저의 모든 경기가</b> 재사용(콜0)이 아니라 패치로 가서, "무변경이면 즉시 시작"이 영원히 발동하지
     * 않는다. 중앙 = 선호 없음이므로 미지정과 같게 취급한다.
     *
     * <p>전 축을 정확히 0.5 로 <b>의도해서</b> 맞춘 유저와는 구별되지 않는다 — 그 경우 AI 가 전술 블록
     * 없이(=자율) 만든 A 를 쓴다. 중앙 지정과 자율은 의미가 사실상 같아 수용한 트레이드오프다.
     */
    public static boolean isNeutral(JsonNode node) {
        if (node == null || !node.isObject()) {
            return false;
        }
        for (String field : FIELDS) {
            JsonNode value = node.get(field);
            if (value == null || !value.isNumber() || value.asDouble() != NEUTRAL) {
                return false;
            }
        }
        return true;
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
