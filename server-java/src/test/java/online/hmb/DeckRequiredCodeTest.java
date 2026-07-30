package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #319 — <b>덱 없이 매치를 만들려 하면 전용 코드 {@code DECK_REQUIRED}</b>.
 *
 * <p>거부는 원래도 하고 있었다(세 경로 모두 활성 덱을 재검증한다). 없던 것은 <b>코드</b>다 —
 * {@code 404 NOT_FOUND} 라 클라가 <b>문구로</b> 404 를 구분해야 했다(web #286 W3.5 의 임시 폴백).
 *
 * <p>⚠️ <b>{@code GET /api/deck} 의 404 는 건드리지 않는다</b>. 거기서의 404 는 "새 유저 = 빈 덱"
 * 이라는 <b>정상</b>이고, web 의 {@code useDeck} 은 404 만 {@code null} 로 정규화한다 — 공용 조회까지
 * 400 으로 바꾸면 "덱이 없다"가 "아직 모른다"로 읽혀 덱 없는 유저 가드 3층이 통째로 뒤집힌다.
 * 그래서 이 파일은 <b>양방향</b>이다: 매치 생성은 새 코드, 덱 조회는 무회귀.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class DeckRequiredCodeTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Test
    void 연습_매치_생성은_덱이_없으면_DECK_REQUIRED() {
        String token = login("dr_practice");
        ResponseEntity<Map> res = authPost("/api/matches", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("DECK_REQUIRED");
    }

    @Test
    void 리그_다음경기도_덱이_없으면_DECK_REQUIRED() {
        String token = login("dr_league");
        assertThat(authPost("/api/league/start", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        ResponseEntity<Map> res = authPost("/api/league/next-match", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("DECK_REQUIRED");
    }

    @Test
    void 원정도_덱이_없으면_DECK_REQUIRED_이지_NO_OPPONENT_이_아니다() {
        // ⚠️ 이 구분이 4R blocker 의 재발 방지선이다 — 내 덱이 문제인데 "상대가 없다"고 말하면
        // 유저가 할 수 있는 게 0인 막다른 토스트가 된다.
        setupOpponentWithDeck("dr_away_opp");
        String token = login("dr_away");
        ResponseEntity<Map> res = authPost("/api/away/matches", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("DECK_REQUIRED");
    }

    @Test
    void 덱_조회_404_는_그대로다() {
        // 무회귀 축. 이걸 400 으로 만들면 web 의 덱 없는 유저 판정이 조용히 뒤집힌다.
        String token = login("dr_get");
        ResponseEntity<Map> res = authGet("/api/deck", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody().get("code")).isEqualTo("NOT_FOUND");
    }
}
