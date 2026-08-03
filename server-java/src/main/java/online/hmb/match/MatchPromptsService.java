package online.hmb.match;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * {@code GET /api/matches/{id}/prompts} — <b>이 매치에 실제로 반영된</b> 지시 조회(#431).
 *
 * <p><b>왜 필요했나</b>: 쓰기({@code POST .../prompts})만 있고 읽기가 없었다. 그래서 후반에 선수
 * 상세를 열면 "방금 감독시간에 바꾼 지시"가 아니라 <b>덱에 저장된 옛 지시</b>가 떴다. 감독시간
 * 입력칸은 로컬 초안(`hmb.match.halftime-draft.<id>`)으로 버텼지만, 선수 상세는 "지금 이 선수에게
 * 걸린 지시"를 말해야 하는 자리라 초안으로 대체할 수 없다(다른 기기·새 세션엔 초안이 없다).
 *
 * <p><b>병합 규칙을 재발명하지 않는다</b>: 값은 {@link PromptContextBuilder#userPromptSet} 이
 * 만든다 — AI 잡 컨텍스트에 실리는 값과 <b>같은 함수</b>여야 화면과 경기가 갈리지 않는다.
 * 순서는 덱 ← pre ← halftime(뒤가 이긴다).
 *
 * <p><b>소유자 전용</b>: {@link MatchService#getOwned} 라 비소유자는 404 다({@code getViewable} 이
 * 아니다 — 원정 수비자에게 관전을 연 것과 지시문을 여는 것은 전혀 다른 문제고, 그쪽은
 * {@code toDetailFor} 가 명시적으로 막아 둔 정보다).
 */
@Service
public class MatchPromptsService {

    private final MatchService matchService;
    private final PromptContextBuilder contextBuilder;

    public MatchPromptsService(MatchService matchService, PromptContextBuilder contextBuilder) {
        this.matchService = matchService;
        this.contextBuilder = contextBuilder;
    }

    /**
     * @param phase 이 값이 <b>확정된 단계</b>: {@code halftime} = 감독시간에 쓴 것, {@code pre} =
     *     경기 전부터 유효한 것(브리핑 제출 <b>또는</b> 덱에 적혀 있던 값 — 둘 다 킥오프 시점에
     *     걸려 있던 지시라 화면에서 같은 뜻이다).
     */
    public record PromptEntry(String playerId, String text, String phase) {
    }

    public record MatchPrompts(String teamPrompt, List<PromptEntry> players) {
    }

    public MatchPrompts of(String userId, String matchId) {
        MatchService.MatchRow row = matchService.getOwned(userId, matchId);
        JsonNode snapshot = matchService.readJson(row.userDeckJson());
        // 로스터 한정은 **선발 + 벤치**다. 선수 상세는 벤치도 열리므로 11명으로 좁히면 벤치의 지시가
        // 조회에서만 사라진다(저장돼 있는데 못 읽는 것이 이 이슈의 증상이었다).
        Set<String> deckIds = matchService.snapshotPlayerIds(row);
        PromptContextBuilder.PromptSet set = contextBuilder.userPromptSet(
                matchId, snapshot, deckIds, PromptContextBuilder.HALFTIME_PHASES);
        Map<String, String> phases = contextBuilder.playerPromptPhases(
                matchId, PromptContextBuilder.HALFTIME_PHASES);

        List<PromptEntry> players = new ArrayList<>();
        set.playerPrompts().forEach((playerId, text) ->
                players.add(new PromptEntry(playerId, text, phases.getOrDefault(playerId, "pre"))));
        return new MatchPrompts(set.teamPrompt(), players);
    }
}
