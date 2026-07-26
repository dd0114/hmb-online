package online.hmb.meta;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import online.hmb.catalog.CatalogPlayer;
import online.hmb.common.TxRunner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 온보딩 진행 상태의 권위 (#209) — <b>튜토리얼 완료 플래그</b>와 <b>완료 시 덱 지급</b>.
 *
 * <p>지금까지 완료 여부는 클라 localStorage 에만 있었다. 덱 지급을 거기에 매달면 스토리지를
 * 지우는 것만으로 덱이 다시 지급된다 — 그래서 완료를 서버 컬럼({@code users.tutorial_done})으로
 * 올리고, 지급 멱등은 <b>플래그가 아니라 "활성 덱이 이미 있는가"</b>로 판정한다. 두 겹인 이유:
 * 플래그만 보면 (수동 다시보기 등으로) 플래그가 되돌려졌을 때 남의 덱을 덮어쓸 수 있고, 덱만 보면
 * 유저가 덱을 지운 뒤 재지급받는 경로가 열린다. 실제 파괴적 동작(교체)은 어느 쪽도 하지 않는다 —
 * <b>덱이 없을 때만 만든다</b>.
 */
@Service
public class OnboardingService {

    private static final Logger log = LoggerFactory.getLogger(OnboardingService.class);

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final DeckService deckService;
    private final ObjectMapper objectMapper;
    private final String defaultFormation;
    private final int benchMax;

    public OnboardingService(JdbcClient jdbcClient,
                             TxRunner txRunner,
                             DeckService deckService,
                             ObjectMapper objectMapper,
                             @Value("${hmb.starter.deck-formation}") String defaultFormation,
                             @Value("${hmb.deck.bench-max}") int benchMax) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.deckService = deckService;
        this.objectMapper = objectMapper;
        this.defaultFormation = defaultFormation;
        this.benchMax = benchMax;
    }

    /** 튜토리얼 완료 여부(GET /api/me 의 user.tutorialDone). */
    public boolean tutorialDone(String userId) {
        return jdbcClient.sql("SELECT tutorial_done FROM users WHERE id = ?")
                .param(userId)
                .query(Integer.class)
                .optional()
                .map(v -> v != 0)
                .orElse(false);
    }

    /**
     * 가입 시 지급된 최상위 유닛(연출용, #209 AC3). 없으면 empty
     * (구 유저 = 개편 이전 가입, 또는 economy 에 starterTop 이 없던 시점의 가입).
     */
    public Optional<CatalogPlayer> starterGrant(String userId) {
        return jdbcClient.sql("""
                        SELECT p.id, p.name, p.position, p.grade, p.attributes_json,
                               COALESCE(up.count, 0) AS owned_count
                        FROM starter_grants g
                        JOIN players p ON p.id = g.player_id
                        LEFT JOIN user_players up ON up.player_id = p.id AND up.user_id = g.user_id
                        WHERE g.user_id = ?
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
                .optional();
    }

    /**
     * 튜토리얼 완료(또는 건너뛰기) 처리 — <b>멱등</b>. 몇 번을 불러도 덱은 한 번만 생긴다.
     *
     * <p>건너뛰기도 같은 경로다(#209 D6): 덱이 없으면 경기 자체가 불가능해서, 온보딩을 건너뛴
     * 대가가 "플레이 불가"가 되면 안 된다.
     *
     * @return 이번 호출이 덱을 실제로 만들었는지(연출·안내 문구 판단용)
     */
    public Result complete(String userId) {
        return txRunner.run(() -> {
            jdbcClient.sql("UPDATE users SET tutorial_done = 1 WHERE id = ?")
                    .param(userId)
                    .update();

            if (hasActiveDeck(userId)) {
                return new Result(true, false, null);
            }
            List<DeckService.SlotDto> slots =
                    StarterDeckBuilder.build(ownedPlayers(userId), defaultFormation, benchMax);
            if (slots.isEmpty()) {
                // 보유 인원이 11명 미만 = 스타터 팩이 지급되지 않은 계정(economy 미발행 등).
                // 완료 플래그는 그대로 두고 덱만 건너뛴다 — 유저가 카드를 모으면 직접 구성할 수 있다.
                log.warn("tutorial complete for user {} but not enough owned players for a deck", userId);
                return new Result(true, false, null);
            }
            DeckService.DeckResponse deck = deckService.replaceDeck(userId,
                    new DeckService.DeckUpdateRequest(defaultFormation, slots));
            log.info("tutorial deck granted: user={} formation={} slots={}",
                    userId, defaultFormation, slots.size());
            return new Result(true, true, deck);
        });
    }

    private boolean hasActiveDeck(String userId) {
        Long count = jdbcClient.sql("SELECT COUNT(*) FROM decks WHERE user_id = ? AND is_active = 1")
                .param(userId)
                .query(Long.class)
                .single();
        return count != null && count > 0;
    }

    /** 보유 카드 → 배치 입력. overall = 능력치 9종 평균(web team-power.playerOverall 과 같은 정의). */
    private List<StarterDeckBuilder.OwnedPlayer> ownedPlayers(String userId) {
        return jdbcClient.sql("""
                        SELECT p.id, p.position, p.attributes_json
                        FROM user_players up JOIN players p ON p.id = up.player_id
                        WHERE up.user_id = ?
                        ORDER BY p.id
                        """)
                .param(userId)
                .query((rs, rowNum) -> new StarterDeckBuilder.OwnedPlayer(
                        rs.getString("id"),
                        rs.getString("position"),
                        overallOf(parseAttributes(rs.getString("attributes_json")))))
                .list();
    }

    private static double overallOf(Map<String, Object> attributes) {
        if (attributes.isEmpty()) {
            return 0;
        }
        double sum = 0;
        for (Object v : attributes.values()) {
            sum += v instanceof Number n ? n.doubleValue() : 0;
        }
        return sum / attributes.size();
    }

    private Map<String, Object> parseAttributes(String json) {
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {
            });
        } catch (Exception e) {
            throw new IllegalStateException("players.attributes_json 파싱 실패: " + e.getMessage(), e);
        }
    }

    /** 완료 처리 결과 — deck 은 이번에 만들었을 때만 채운다(아니면 null). */
    public record Result(boolean tutorialDone, boolean deckGranted, DeckService.DeckResponse deck) {
    }

    /** GET /api/me/starter-grant 응답 — 지급이 없으면 player=null(연출 생략). */
    public record StarterGrantResponse(boolean granted, CatalogPlayer player) {
    }
}
