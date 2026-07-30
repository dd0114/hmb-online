package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import online.hmb.away.AwayService;
import online.hmb.away.AwaySeasonService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #286 W4 (#319) — 랭킹보드 2종 · 모드별 전적 · 리그 라운드 진행.
 *
 * <p>W5(web)가 이미 머지돼 있어 <b>소비자 타입이 계약의 정본</b>이다
 * ({@code apps/web/src/api/hooks-p286.ts}) — 여기 단언은 그 형상을 서버 쪽에서 박제한 것이다.
 * 필드 이름 하나가 어긋나면 화면은 에러가 아니라 <b>조용히 그 구역을 안 그린다</b>(부재 = 정상
 * 상태로 설계돼 있다). 그래서 형상은 테스트가 지켜야 한다 — 화면은 말해 주지 않는다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class HomeNavBoardsTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private AwayService awayService;

    @Resource
    private AwaySeasonService seasonService;

    // ── GET /api/away/rankings ─────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void 원정_랭킹은_시즌_마감과_같은_표를_그린다() {
        // ⚠️ 이게 이 엔드포인트의 핵심 계약이다. 라이브 보드를 `user_ratings`(창 없는 누적)로 따로
        // 매기면 참가 축(시즌 창)과 어긋나 "1등으로 보였는데 보상은 3등"이 된다 — 실측에서 3패한
        // 유저가 1위로 뜬 적이 있다(독립검증 MAJ-1). 그래서 보드는 정의상 "지금 마감하면 나올 표"다.
        String me = setupUserWithDeck("rk_me");
        String meId = userIdOf("rk_me");
        setupOpponentWithDeck("rk_low");
        String lowId = userIdOf("rk_low");

        raid(meId, lowId, "RK_A1", "WIN");   // 나 +10 / 상대 −10
        raid(meId, lowId, "RK_A2", "WIN");   // 나 +10(+연승 보너스) / 상대 −10

        // ⚠️ **지난 시즌 잔재를 심는다** — 이게 이 계약의 변이체 킬 장치다. 이게 없으면
        // user_ratings(누적)와 시즌 창 합이 우연히 같아서, 보드를 누적으로 되돌리는 변이체가
        // 그대로 살아남는다(계약이 검사하는 척만 한다).
        int seasonSum = seasonService.seasonRatingOf(meId, seasonService.current().startedAt(),
                seasonService.current().endsAt());
        jdbcClient.sql("""
                        INSERT INTO rating_ledger(user_id, delta, reason, ref_id, created_at)
                        VALUES (?, 500, 'away_attack', 'OLD_SEASON', '2020-01-01T00:00:00Z')
                        """)
                .param(meId).update();
        jdbcClient.sql("UPDATE user_ratings SET rating = rating + 500 WHERE user_id = ?")
                .param(meId).update();

        ResponseEntity<Map> res = authGet("/api/away/rankings?limit=50", me, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody().get("seasonNo")).isEqualTo(seasonService.current().seasonNo());

        List<Map<String, Object>> entries = (List<Map<String, Object>>) res.getBody().get("entries");
        assertThat(entries).hasSizeGreaterThanOrEqualTo(2);
        assertThat(entries.get(0).get("userId")).isEqualTo(meId);
        assertThat(entries.get(0).get("rank")).isEqualTo(1);
        assertThat(entries.get(0).get("isMe")).isEqualTo(true);
        assertThat(entries.get(0).get("streak")).isEqualTo(2);
        // 이 시즌 창 안의 변동만 센다 — 창 밖 500 이 섞이면 마감 표와 어긋난다.
        assertThat(entries.get(0).get("rating")).isEqualTo(seasonSum);
        assertThat((Integer) entries.get(0).get("rating")).isLessThan(seasonSum + 500);
        assertThat(entries).last().satisfies(e -> assertThat(e.get("userId")).isEqualTo(lowId));

        Map<String, Object> mine = (Map<String, Object>) res.getBody().get("me");
        assertThat(mine.get("rank")).isEqualTo(1);
        assertThat(mine.get("total")).isEqualTo(entries.size());

        // 같은 창으로 물었을 때 마감 스냅샷이 만들 순서와 **같아야** 한다.
        AwaySeasonService.Season season = seasonService.current();
        List<AwaySeasonService.SeasonStanding> closing =
                seasonService.standings(season.startedAt(), season.endsAt());
        assertThat(closing.stream().map(AwaySeasonService.SeasonStanding::userId).toList())
                .startsWith(meId);
        assertThat(closing.get(0).rating()).isEqualTo((Integer) entries.get(0).get("rating"));

        Map<String, Object> mineAgain = (Map<String, Object>) res.getBody().get("me");
        assertThat(mineAgain.get("rating")).isEqualTo(seasonSum);
    }

    @SuppressWarnings("unchecked")
    @Test
    void 원정을_안_한_유저는_에러가_아니라_순위_없음이다() {
        // ⚠️ 404 를 내면 신규 유저가 원정 탭을 여는 순간 에러 토스트를 본다(#296 과 같은 규율).
        // "자격이 없는 것"과 "유저가 없는 것"은 다르다.
        String rookie = setupUserWithDeck("rk_rookie");

        ResponseEntity<Map> res = authGet("/api/away/rankings", rookie, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> mine = (Map<String, Object>) res.getBody().get("me");
        assertThat(mine).isNotNull();
        assertThat(mine.get("rank")).isNull();      // 0위로 채우지 않는다
        assertThat(mine.get("isMe")).isEqualTo(true);
    }

    // ── GET /api/league/rankings ───────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void 리그_랭킹은_디비전_우선_승점_순이다() {
        // hero Q2 확정. 승점은 computeStandings 가 SoT — 보드가 자기 집계를 가지면 순위표와
        // 랭킹보드가 서로 다른 승점을 말한다.
        String top = setupUserWithDeck("lr_top");
        String bottom = setupUserWithDeck("lr_bottom");
        startLeague(top);
        startLeague(bottom);
        // 같은 디비전에서 승점만 가른다.
        awardPoints("lr_top", 3);      // 3승
        awardPoints("lr_bottom", 1);   // 1승

        ResponseEntity<Map> res = authGet("/api/league/rankings?scope=global&limit=50", top, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> entries = (List<Map<String, Object>>) res.getBody().get("entries");
        assertThat(entries).extracting(e -> e.get("userId"))
                .containsSubsequence(userIdOf("lr_top"), userIdOf("lr_bottom"));
        Map<String, Object> first = entries.get(0);
        assertThat(first.get("rank")).isEqualTo(1);
        assertThat(first.get("points")).isEqualTo(9);
        assertThat(first.get("played")).isEqualTo(3);
        // 디비전 이름은 **서버가 준다**(클라가 level→이름을 복제하면 표가 바뀔 때 어긋난다).
        assertThat(first.get("division")).isNotNull();
        assertThat(first.get("divisionName")).isNotNull();

        Map<String, Object> mine = (Map<String, Object>) res.getBody().get("me");
        assertThat(mine.get("rank")).isEqualTo(1);
        assertThat(mine.get("isMe")).isEqualTo(true);
    }

    @SuppressWarnings("unchecked")
    @Test
    void 한_판도_안_치른_유저는_목록에_없지만_내_자리는_받는다() {
        String idle = setupUserWithDeck("lr_idle");
        startLeague(idle);

        ResponseEntity<Map> res = authGet("/api/league/rankings", idle, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> entries = (List<Map<String, Object>>) res.getBody().get("entries");
        assertThat(entries).noneSatisfy(e ->
                assertThat(e.get("userId")).isEqualTo(userIdOf("lr_idle")));
        Map<String, Object> mine = (Map<String, Object>) res.getBody().get("me");
        assertThat(mine.get("rank")).isNull();
        assertThat(mine.get("division")).isNotNull();   // 리그를 시작했으니 디비전은 있다
    }


    /**
     * ⚠️ <b>디비전이 승점을 이긴다</b>(hero Q2 확정) — 정렬의 1차 키.
     *
     * <p>독립검증 MAJ-4: 원래 이 계약의 픽스처는 두 유저가 <b>같은 디비전</b>이라 1차 키가 한 번도
     * 관측되지 않았다 — 디비전 비교를 상수 0 으로 바꾸는 변이체가 <b>전 스위트를 통과</b>했다.
     * hero 가 확정한 헤드라인 규칙에 회귀 감시가 0 이었다는 뜻이다. 그래서 <b>승점이 반대로 가는</b>
     * 표본을 쓴다: 상위 디비전이 승점은 더 낮은데도 위에 선다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void 디비전이_승점보다_먼저다() {
        String d1 = setupUserWithDeck("lr_d1");
        String d9 = setupUserWithDeck("lr_d9");
        setDivision("lr_d1", 1);
        setDivision("lr_d9", 9);
        startLeague(d1);
        startLeague(d9);
        awardPoints("lr_d1", 1);   // 3점 — **더 적다**
        awardPoints("lr_d9", 3);   // 9점

        List<Map<String, Object>> entries = entriesOf(d1, "?scope=global&limit=50");
        assertThat(entries).extracting(e -> e.get("userId"))
                .containsSubsequence(userIdOf("lr_d1"), userIdOf("lr_d9"));
        Map<String, Object> first = entries.get(0);
        assertThat(first.get("division")).isEqualTo(1);
        assertThat(first.get("points")).isEqualTo(3);   // 승점은 아래 사람이 더 높다
    }

    /** {@code scope=division} 은 <b>내 디비전만</b> 세고 1위부터 다시 매긴다. */
    @SuppressWarnings("unchecked")
    @Test
    void scope_division_은_내_디비전만_센다() {
        String mine = setupUserWithDeck("lr_sc_mine");
        String other = setupUserWithDeck("lr_sc_other");
        setDivision("lr_sc_mine", 4);
        setDivision("lr_sc_other", 7);
        startLeague(mine);
        startLeague(other);
        awardPoints("lr_sc_mine", 1);
        awardPoints("lr_sc_other", 3);

        List<Map<String, Object>> entries = entriesOf(mine, "?scope=division&limit=50");
        assertThat(entries).extracting(e -> e.get("division")).containsOnly(4);
        assertThat(entries).noneSatisfy(e ->
                assertThat(e.get("userId")).isEqualTo(userIdOf("lr_sc_other")));
        assertThat(entries.get(0).get("rank")).isEqualTo(1);   // 디비전 안에서 1위부터
    }

    /**
     * ⚠️ {@code me.total} 은 <b>순위에 오른 전체 인원</b>이지 이번 페이지 크기가 아니다
     * (독립검증 MIN-3: `rows.size()` → `entries.size()` 변이체가 살아 있었다 — 픽스처가
     * limit 보다 많은 인원을 만든 적이 없어서다). 화면이 "N위 / M명"으로 쓰므로 여기가 틀리면
     * 순위가 항상 "1위 / 1명"처럼 보인다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void 내_순위의_전체_인원은_페이지_크기가_아니다() {
        String a = setupUserWithDeck("lr_tot_a");
        String b = setupUserWithDeck("lr_tot_b");
        String c = setupUserWithDeck("lr_tot_c");
        startLeague(a);
        startLeague(b);
        startLeague(c);
        awardPoints("lr_tot_a", 3);
        awardPoints("lr_tot_b", 2);
        awardPoints("lr_tot_c", 1);

        Map<String, Object> body = authGet("/api/league/rankings?limit=1", a, Map.class).getBody();
        List<Map<String, Object>> entries = (List<Map<String, Object>>) body.get("entries");
        assertThat(entries).hasSize(1);                       // 페이지는 1건
        Map<String, Object> mine = (Map<String, Object>) body.get("me");
        assertThat((Integer) mine.get("total")).isGreaterThanOrEqualTo(3);   // 인원은 그보다 많다
    }

    /**
     * 시즌을 다 치르면 {@code currentRound} 가 <b>총 라운드에 머문다</b>(독립검증 MIN-2 — 이 폴백
     * 분기에 계약이 없어 0 으로 바꾸는 변이체가 살아 있었다). 0 이면 화면이 "0 / 18 라운드"로
     * 되돌아가 다 끝난 시즌을 시작 전처럼 그린다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void 시즌을_다_치르면_현재_라운드는_총_라운드에_머문다() {
        String token = setupUserWithDeck("lr_done");
        startLeague(token);
        jdbcClient.sql("""
                        UPDATE league_fixtures SET state = 'PLAYED', score_home = 1, score_away = 0
                         WHERE season_id = (SELECT id FROM league_seasons WHERE user_id = ?
                                            ORDER BY season_no DESC LIMIT 1)
                        """)
                .param(userIdOf("lr_done"))
                .update();

        Map<String, Object> season = (Map<String, Object>)
                authGet("/api/league", token, Map.class).getBody().get("season");
        assertThat(season.get("currentRound")).isEqualTo(season.get("totalRounds"));
        assertThat((Integer) season.get("currentRound")).isGreaterThan(0);
    }

    /**
     * ⚠️ <b>남의 데이터 사고가 전원의 랭킹보드를 죽이지 않는다</b>(독립검증 MAJ-2).
     *
     * <p>{@code GET /api/league} 는 자기 시즌만 파싱해 블라스트 반경이 1명이었는데, 이 보드는
     * 전 유저를 순회하므로 <b>남의</b> {@code teams_json} 이 깨져 있으면 <b>내</b> 요청이 500 이 됐다
     * (실측). 그 사람만 표에서 빠지는 것이 옳다 — 보이지 않는 게 아무것도 안 보이는 것보다 낫다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void 남의_시즌_데이터가_깨져도_내_랭킹보드는_뜬다() {
        String healthy = setupUserWithDeck("lr_ok");
        String broken = setupUserWithDeck("lr_broken");
        startLeague(healthy);
        startLeague(broken);
        awardPoints("lr_ok", 2);
        awardPoints("lr_broken", 1);

        jdbcClient.sql("UPDATE league_seasons SET teams_json = '{{{ not json' WHERE user_id = ?")
                .param(userIdOf("lr_broken"))
                .update();

        ResponseEntity<Map> res = authGet("/api/league/rankings", healthy, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> entries = (List<Map<String, Object>>) res.getBody().get("entries");
        assertThat(entries).anySatisfy(e ->
                assertThat(e.get("userId")).isEqualTo(userIdOf("lr_ok")));
        assertThat(entries).noneSatisfy(e ->
                assertThat(e.get("userId")).isEqualTo(userIdOf("lr_broken")));
    }


    /**
     * ⚠️ {@code scope=division} 의 필터는 <b>목록 행과 같은 축</b>에서 온다(독립검증 MIN-4).
     *
     * <p>행은 그 시즌에 <b>박제된</b> {@code league_seasons.division} 인데 필터만
     * {@code users.division}(현재값)으로 물으면, <b>승급 직후</b> 내 행이 내 디비전 보드에서 사라진다
     * (실제로는 승점이 있는데 {@code rank=null · 0점}). 승급/강등은 시즌 <b>사이</b>에 일어나므로
     * 두 값이 갈라지는 구간이 정상적으로 존재한다 — 그래서 표본도 그 구간을 만든다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void 승급_직후에도_내_행이_내_디비전_보드에_남는다() {
        String token = setupUserWithDeck("lr_promo");
        setDivision("lr_promo", 6);
        startLeague(token);                 // 시즌에 division=6 이 박제된다
        awardPoints("lr_promo", 2);
        setDivision("lr_promo", 5);         // 시즌 종료 후 승급 — users.division 만 앞서 나간다

        List<Map<String, Object>> entries = entriesOf(token, "?scope=division&limit=50");
        assertThat(entries).anySatisfy(e -> {
            assertThat(e.get("userId")).isEqualTo(userIdOf("lr_promo"));
            assertThat(e.get("division")).isEqualTo(6);   // 시즌 박제값
            assertThat(e.get("points")).isEqualTo(6);
        });
        Map<String, Object> mine = (Map<String, Object>)
                authGet("/api/league/rankings?scope=division", token, Map.class).getBody().get("me");
        assertThat(mine.get("rank")).isNotNull();
        assertThat(mine.get("points")).isEqualTo(6);
    }

    /**
     * ⚠️ <b>내 시즌이 깨진 것은 조용히 넘기지 않는다</b>(독립검증 2R MINOR-3). 남의 사고는 skip 하되
     * (MAJ-2) 내 것까지 삼키면 200 인데 {@code me = {rank:null, points:0}} 이 되어 — 실제로는 승점이
     * 있는데 — 화면이 서버와 <b>반대 사실</b>을 말한다(#262 BL-1 이 금지한 형태).
     */
    @Test
    void 내_시즌_데이터가_깨지면_조용히_0점이_되지_않는다() {
        String token = setupUserWithDeck("lr_selfbroken");
        startLeague(token);
        awardPoints("lr_selfbroken", 2);
        jdbcClient.sql("UPDATE league_seasons SET teams_json = '{{{ not json' WHERE user_id = ?")
                .param(userIdOf("lr_selfbroken")).update();

        ResponseEntity<Map> res = authGet("/api/league/rankings", token, Map.class);
        assertThat(res.getStatusCode()).isNotEqualTo(HttpStatus.OK);
    }

    // ── GET /api/league (라운드 진행) ──────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void 시즌은_현재_라운드와_총_라운드를_발행한다() {
        // ⚠️ totalRounds 를 상수 18 로 두면 디비전·시즌 구성이 바뀌는 순간 화면이 서버와 다른 말을
        // 한다. 픽스처의 실제 최대 라운드를 싣는다 — 그래서 단언도 상수가 아니라 픽스처에서 센다.
        String token = setupUserWithDeck("lr_round");
        startLeague(token);

        ResponseEntity<Map> res = authGet("/api/league", token, Map.class);
        Map<String, Object> season = (Map<String, Object>) res.getBody().get("season");
        List<Map<String, Object>> fixtures = (List<Map<String, Object>>) season.get("fixtures");
        int maxRound = fixtures.stream().mapToInt(f -> (Integer) f.get("round")).max().orElse(0);

        assertThat(season.get("totalRounds")).isEqualTo(maxRound);
        // 아직 한 판도 안 했으면 지금 서 있는 라운드는 1이다(0 이 아니다 — "N / M 라운드" 표기).
        assertThat(season.get("currentRound")).isEqualTo(1);

        // 라운드 1을 치르면 2로 넘어간다.
        playUserFixture(token, 1);
        Map<String, Object> after = (Map<String, Object>) authGet("/api/league", token, Map.class)
                .getBody().get("season");
        assertThat(after.get("currentRound")).isEqualTo(2);
        assertThat(after.get("totalRounds")).isEqualTo(maxRound);
    }

    // ── GET /api/me/record ─────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void 전적은_모드별로_갈리고_합이_통산과_같다() {
        String token = setupUserWithDeck("rec_me");
        String userId = userIdOf("rec_me");

        seedFinished(userId, "practice", "WIN", "2026-07-01T00:00:00Z");
        seedFinished(userId, "practice", "LOSS", "2026-07-02T00:00:00Z");
        seedFinished(userId, "league", "WIN", "2026-07-03T00:00:00Z");
        seedFinished(userId, "league", "DRAW", "2026-07-04T00:00:00Z");
        seedFinished(userId, "away", "WIN", "2026-07-05T00:00:00Z");

        ResponseEntity<Map> res = authGet("/api/me/record", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);

        Map<String, Object> overall = (Map<String, Object>) res.getBody().get("overall");
        assertThat(overall.get("played")).isEqualTo(5);
        assertThat(overall.get("wins")).isEqualTo(3);
        assertThat(overall.get("draws")).isEqualTo(1);
        assertThat(overall.get("losses")).isEqualTo(1);
        // ⚠️ 승률은 **서버가 계산해서 준다**(클라 복제 금지). 규칙 = wins/played(무승부는 승이 아니다).
        assertThat((Double) overall.get("winRate")).isEqualTo(3.0 / 5.0);

        Map<String, Map<String, Object>> byMode =
                (Map<String, Map<String, Object>>) res.getBody().get("byMode");
        assertThat(byMode.get("practice").get("played")).isEqualTo(2);
        assertThat(byMode.get("league").get("played")).isEqualTo(2);
        assertThat(byMode.get("away").get("played")).isEqualTo(1);
        // 통산 = Σ 모드. 어긋나면 같은 화면이 두 말을 한다.
        int sum = byMode.values().stream().mapToInt(m -> (Integer) m.get("played")).sum();
        assertThat(sum).isEqualTo((Integer) overall.get("played"));

        // 최근 폼은 **최신이 앞**(설계 §5).
        List<String> form = (List<String>) res.getBody().get("recentForm");
        assertThat(form).containsExactly("WIN", "DRAW", "WIN", "LOSS", "WIN");

        Map<String, Object> streak = (Map<String, Object>) res.getBody().get("streak");
        assertThat(streak.get("current")).isEqualTo(1);   // 마지막 판이 승
        assertThat(streak.get("best")).isEqualTo(1);      // 연속 2승이 없었다
        assertThat(streak.get("awayBest")).isNotNull();
    }

    @SuppressWarnings("unchecked")
    @Test
    void 피침공은_내가_친_원정_전적에_섞이지_않는다() {
        // ⚠️ 섞으면 overall ≠ Σ byMode 가 되어 화면이 두 말을 한다. 방어 전적의 주인은
        // /api/me/away-reports.summary 다 — 한 사실의 주인은 하나다.
        String me = setupUserWithDeck("rec_def");
        String meId = userIdOf("rec_def");
        setupOpponentWithDeck("rec_atk");
        String attackerId = userIdOf("rec_atk");

        raid(attackerId, meId, "REC_D1", "WIN");   // 내가 방어에 실패했다(내 matches 엔 없다)

        Map<String, Object> body = authGet("/api/me/record", me, Map.class).getBody();
        Map<String, Object> overall = (Map<String, Object>) body.get("overall");
        assertThat(overall.get("played")).isEqualTo(0);
        Map<String, Map<String, Object>> byMode =
                (Map<String, Map<String, Object>>) body.get("byMode");
        assertThat(byMode.get("away").get("played")).isEqualTo(0);
    }

    // ── 헬퍼 ───────────────────────────────────────────────────────────────

    private void raid(String attackerId, String defenderId, String matchId, String attackerResult) {
        String now = java.time.Instant.now().toString();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                                      user_deck_json, mode, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', 'test', '{}', 'away', ?)
                        """)
                .params(matchId, attackerId, "2026-05-01T00:00:00Z").update();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO away_challenges(match_id, defender_id, ghost_bot_id, created_at)
                        VALUES (?, ?, 'BOT_BAL', ?)
                        """)
                .params(matchId, defenderId, now).update();
        if ("WIN".equals(attackerResult)) {
            awayService.settle(matchId, attackerId, "WIN", 2, 0);
        } else {
            awayService.settle(matchId, attackerId, "LOSS", 0, 2);
        }
    }

    private void seedFinished(String userId, String mode, String result, String createdAt) {
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, result, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', 'test', '{}', ?, ?, ?)
                        """)
                .params(online.hmb.common.Ulid.next(), userId, mode, result, createdAt).update();
    }

    private void setDivision(String nickname, int division) {
        jdbcClient.sql("UPDATE users SET division = ? WHERE id = ?")
                .params(division, userIdOf(nickname)).update();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> entriesOf(String token, String query) {
        ResponseEntity<Map> res = authGet("/api/league/rankings" + query, token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) res.getBody().get("entries");
    }

    @SuppressWarnings("unchecked")
    private void startLeague(String token) {
        ResponseEntity<Map> res = authPost("/api/league/start", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /** 유저 픽스처 n건을 승리로 마감시킨다(승점 3n·경기 n) — 시뮬 없이 순위표 입력만 만든다. */
    private void awardPoints(String nickname, int wins) {
        String seasonId = jdbcClient.sql(
                        "SELECT id FROM league_seasons WHERE user_id = ? ORDER BY season_no DESC LIMIT 1")
                .param(userIdOf(nickname)).query(String.class).single();
        List<Map<String, Object>> fixtures = jdbcClient.sql("""
                        SELECT id, home_team FROM league_fixtures
                         WHERE season_id = ? AND is_user = 1 AND state = 'SCHEDULED'
                         ORDER BY round LIMIT ?
                        """)
                .params(seasonId, wins)
                .query((rs, n) -> Map.<String, Object>of("id", rs.getString("id"),
                        "home", rs.getString("home_team")))
                .list();
        for (Map<String, Object> f : fixtures) {
            boolean userHome = "USER".equals(f.get("home"));
            jdbcClient.sql("""
                            UPDATE league_fixtures SET state = 'PLAYED', score_home = ?, score_away = ?
                             WHERE id = ?
                            """)
                    .params(userHome ? 2 : 0, userHome ? 0 : 2, f.get("id"))
                    .update();
        }
    }

    /** 라운드 r 의 유저 픽스처를 마감 상태로 만든다(currentRound 이동 관측용). */
    private void playUserFixture(String token, int round) {
        jdbcClient.sql("""
                        UPDATE league_fixtures SET state = 'PLAYED', score_home = 1, score_away = 0
                         WHERE is_user = 1 AND round = ?
                           AND season_id = (SELECT id FROM league_seasons WHERE user_id = ?
                                            ORDER BY season_no DESC LIMIT 1)
                        """)
                .params(round, userIdOf("lr_round"))
                .update();
    }
}
