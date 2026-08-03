package online.hmb.meta;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.common.ApiException;
import online.hmb.growth.GrowthService;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 타 유저 선수단 조회 {@code GET /api/users/{targetUserId}/squad} (#432).
 *
 * <p><b>무엇을 주나</b>: 그 유저의 <b>지금 활성 덱</b>(벤치 포함)이다 — "이 유저가 어떤 선수단을
 * 굴리나"이지 "그 경기에 뭘 냈나"가 아니다. 후자는 이미 다른 표면이 갖고 있다
 * ({@code MatchDetail.opponent.deck} = 매치 스냅샷, 원정 고스트 = {@code bots.deck_json} 박제).
 * <b>두 축을 섞지 않는다.</b> 대가는 적어 둔다: 고스트는 도전 생성 시점에 굽기 때문에 정찰 후
 * 상대가 덱을 바꾸면 실제로 맞붙는 팀은 정찰한 스쿼드와 다를 수 있다 — 두 축이 다르다는 것의
 * 귀결이지 결함이 아니고, 화면이 "지금 스쿼드"라고 말하면 거짓이 아니다.
 *
 * <p><b>공개 범위</b>(hero 확정 2026-08-02 결정 ③ A안): 이름·포지션·등급·★·OVR·능력치 +
 * <b>"지시 있음" 여부만</b>. 지시문 내용·팀 지시·팀 전술·컨디션은 비공개다. 이 선은
 * {@code MatchService.toDetailFor} 가 긋는 선과 같고, <b>같은 방식</b>으로 긋는다 —
 * 지울 것을 열거하지 않고 <b>허용할 것만 담은 새 record</b> 로 재조립한다.
 * {@link DeckService.DeckResponse}/{@link DeckService.SlotDto} 를 그대로 흘리면
 * {@code promptText}·{@code teamPrompt} 가 딸려 나간다.
 *
 * <p>⚠️ <b>읽기 전용이다.</b> {@code GET /api/deck} 은 조회하면서 AI 인풋 프리워밍을 태우는데
 * (그건 자기 덱이라 정당하다), 그걸 여기로 옮기면 <b>남의 화면을 보는 것만으로 AI 예산이 나간다</b>.
 */
@Service
public class UserSquadService {

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;
    private final DeckService deckService;
    private final GrowthService growthService;
    private final UserSquadAccess access;

    public UserSquadService(JdbcClient jdbcClient,
                            ObjectMapper objectMapper,
                            DeckService deckService,
                            GrowthService growthService,
                            UserSquadAccess access) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.deckService = deckService;
        this.growthService = growthService;
        this.access = access;
    }

    /**
     * @param star  카드 성. @param ovr 유효 OVR. @param attributes <b>성장 반영</b> 유효 능력치.
     * @param hasPrompt 지시가 있는지 <b>여부만</b> — 내용은 어떤 필드로도 나가지 않는다.
     */
    public record SquadSlot(String playerId, String role, int slotIndex, String name, String position,
                            String grade, int star, double ovr, Map<String, Object> attributes,
                            boolean hasPrompt) {
    }

    /** @param rating 원정 레이팅(없으면 0) · @param streak 원정 연승(없으면 0). */
    public record SquadResponse(String userId, String nickname, int rating, int streak,
                                String formation, List<SquadSlot> slots) {
    }

    /**
     * 자격 밖·없는 유저·덱 없는 유저는 전부 <b>404</b>다.
     *
     * <p>403 이 아닌 이유: 이 리포에는 {@code forbidden} 팩토리가 없고, {@code MatchService.getViewable}
     * 이 비허용 접근에 {@code notFound} 를 던져 <b>존재 자체를 숨긴다</b>. 403 은 "그 id 는 실재한다"를
     * 흘리므로 자격 밖 유저를 열거하는 도구가 된다.
     */
    public SquadResponse squadOf(String viewerId, String targetUserId) {
        String nickname = jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(targetUserId)
                .query(String.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("선수단을 찾을 수 없습니다"));
        if (!access.canView(viewerId, targetUserId)) {
            throw ApiException.notFound("선수단을 찾을 수 없습니다");
        }

        DeckService.DeckResponse deck;
        try {
            deck = deckService.getActiveDeck(targetUserId);
        } catch (ApiException e) {
            throw ApiException.notFound("선수단을 찾을 수 없습니다");
        }

        Map<String, CatalogRow> catalog = catalogOf(deck.slots().stream()
                .map(DeckService.SlotDto::playerId).toList());

        List<SquadSlot> slots = new ArrayList<>();
        for (DeckService.SlotDto slot : deck.slots()) {
            CatalogRow row = catalog.get(slot.playerId());
            if (row == null) {
                continue;   // 카탈로그에서 사라진 선수 — 이름조차 없는 카드를 그리게 하지 않는다.
            }
            // 능력치는 **성장 반영 유효치**다(카탈로그 기본치가 아니다). 진행도(caps/statAdd/startLo)를
            // 담는 성장 상세 맵 경로는 쓰지 않는다 — 공개 범위가 한 칸 넓어진다(#431 코멘트).
            Map<String, Object> attributes =
                    growthService.effectiveAttributes(targetUserId, slot.playerId(), row.attributes());
            slots.add(new SquadSlot(slot.playerId(), slot.role(), slot.slotIndex(),
                    row.name(), row.position(), row.grade(),
                    growthService.cardStar(targetUserId, slot.playerId()),
                    growthService.ovrOf(row.position(), attributes),
                    attributes,
                    slot.promptText() != null && !slot.promptText().isBlank()));
        }

        return new SquadResponse(targetUserId, nickname, ratingOf(targetUserId), streakOf(targetUserId),
                deck.formation(), slots);
    }

    private int ratingOf(String userId) {
        return jdbcClient.sql("SELECT rating FROM user_ratings WHERE user_id = ?")
                .param(userId).query(Integer.class).optional().orElse(0);
    }

    private int streakOf(String userId) {
        return jdbcClient.sql("SELECT streak FROM away_streaks WHERE user_id = ?")
                .param(userId).query(Integer.class).optional().orElse(0);
    }

    private record CatalogRow(String name, String position, String grade, Map<String, Object> attributes) {
    }

    private Map<String, CatalogRow> catalogOf(List<String> playerIds) {
        Map<String, CatalogRow> out = new LinkedHashMap<>();
        if (playerIds.isEmpty()) {
            return out;
        }
        String placeholders = String.join(",", playerIds.stream().map(id -> "?").toList());
        jdbcClient.sql("SELECT id, name, position, grade, attributes_json FROM players WHERE id IN ("
                        + placeholders + ")")
                .params(List.copyOf(playerIds))
                .query((rs, n) -> Map.entry(rs.getString("id"),
                        new CatalogRow(rs.getString("name"), rs.getString("position"),
                                rs.getString("grade"), parseAttributes(rs.getString("attributes_json")))))
                .list()
                .forEach(e -> out.put(e.getKey(), e.getValue()));
        return out;
    }

    /** 카탈로그 원본 능력치 — 성장 설정이 없을 때 {@code effectiveAttributes} 가 되돌려주는 폴백값. */
    private Map<String, Object> parseAttributes(String json) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (json == null || json.isBlank()) {
            return out;
        }
        try {
            JsonNode node = objectMapper.readTree(json);
            node.properties().forEach(e -> out.put(e.getKey(), e.getValue().numberValue()));
        } catch (Exception e) {
            return out;
        }
        return out;
    }
}
