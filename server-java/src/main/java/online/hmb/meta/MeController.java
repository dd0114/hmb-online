package online.hmb.meta;

import java.util.List;
import java.util.Map;
import online.hmb.admin.AdminAccess;
import online.hmb.common.ApiException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/me — user + wallet.points + records{wins,draws,losses}(matches 파생, LLD §4).
 * P3 §C additive: user.isAdmin — web 이 /admin 라우트를 **표시**할지 정하는 힌트다.
 * 권한 판정이 아니다(실제 접근 차단은 서버의 AdminInterceptor 가 한다) — 이 값을 클라이언트가
 * 조작해도 admin API 는 열리지 않는다.
 * V2.2 재화 이원화 additive: wallet.gems — 기존 wallet.points 는 불변.
 * GET /api/me/matches — 전적 리스트(최근 20).
 * 전적은 별도 테이블 없이 matches에서 COUNT by result로 파생(ERD 설계 노트).
 */
@RestController
public class MeController {

    private final JdbcClient jdbcClient;
    private final WalletService walletService;
    private final AdminAccess adminAccess;
    private final OnboardingService onboardingService;
    private final online.hmb.away.RatingService ratingService;
    private final online.hmb.league.LeagueService leagueService;
    private final online.hmb.mail.MailService mailService;
    private final MeRecordService meRecordService;

    public MeController(JdbcClient jdbcClient, WalletService walletService, AdminAccess adminAccess,
                        OnboardingService onboardingService,
                        online.hmb.away.RatingService ratingService,
                        online.hmb.league.LeagueService leagueService,
                        online.hmb.mail.MailService mailService,
                        MeRecordService meRecordService) {
        this.meRecordService = meRecordService;
        this.jdbcClient = jdbcClient;
        this.walletService = walletService;
        this.adminAccess = adminAccess;
        this.onboardingService = onboardingService;
        this.ratingService = ratingService;
        this.leagueService = leagueService;
        this.mailService = mailService;
    }

    @GetMapping("/api/me")
    public MeResponse me(@RequestAttribute("userId") String userId) {
        String nickname = jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(userId)
                .query(String.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("유저를 찾을 수 없습니다"));

        long points = walletService.points(userId);
        long gems = walletService.gems(userId);

        Map<String, Long> byResult = new java.util.HashMap<>();
        jdbcClient.sql("""
                        SELECT result, COUNT(*) AS cnt FROM matches
                        WHERE user_id = ? AND result IS NOT NULL
                        GROUP BY result
                        """)
                .param(userId)
                .query((rs, rowNum) -> Map.entry(rs.getString("result"), rs.getLong("cnt")))
                .list()
                .forEach(e -> byResult.put(e.getKey(), e.getValue()));

        return new MeResponse(
                new UserRef(userId, nickname, adminAccess.isAdmin(userId),
                        onboardingService.tutorialDone(userId)),
                new WalletInfo(points, gems),
                new Records(
                        byResult.getOrDefault("WIN", 0L),
                        byResult.getOrDefault("DRAW", 0L),
                        byResult.getOrDefault("LOSS", 0L)),
                ratingService.rating(userId),
                leagueService.currentDivision(userId)
                        .map(d -> new LeagueInfo(d.level(), d.name()))
                        .orElse(null),
                MailInfo.of(mailService.summary(userId)));
    }

    /**
     * 모드별 전적 + 최근 폼(#286 W4 · #319). 집계·승률은 <b>서버가 계산해서 준다</b> —
     * 클라가 다시 나누면 무승부 취급 같은 규칙이 두 곳에 생기고 조용히 어긋난다(#262 규율).
     */
    @GetMapping("/api/me/record")
    public MeRecordService.MyRecord record(@RequestAttribute("userId") String userId) {
        return meRecordService.recordOf(userId);
    }

    @GetMapping("/api/me/matches")
    public List<MatchListItem> myMatches(@RequestAttribute("userId") String userId,
                                          @RequestParam(name = "limit", defaultValue = "20") int limit) {
        int effectiveLimit = Math.max(1, Math.min(limit, 100));
        // W4 orient(additive): score_home/away 는 픽스처(=엔진) 관점 저장이라, 어웨이 유저 리그경기는
        // 유저 득점=away 슬롯. userWasHome 플래그를 additive 로 실어 소비자가 오리엔트하게 한다(breaking 아님).
        return jdbcClient.sql("""
                        SELECT m.id, b.name AS opponent_name, m.score_home, m.score_away, m.result,
                               m.league_fixture_id AS lfid, lf.home_team AS fixture_home, m.created_at
                        FROM matches m JOIN bots b ON b.id = m.bot_id
                        LEFT JOIN league_fixtures lf ON lf.id = m.league_fixture_id
                        WHERE m.user_id = ?
                        ORDER BY m.created_at DESC
                        LIMIT ?
                        """)
                .params(userId, effectiveLimit)
                .query((rs, rowNum) -> new MatchListItem(
                        rs.getString("id"),
                        rs.getString("opponent_name"),
                        (Integer) rs.getObject("score_home"),
                        (Integer) rs.getObject("score_away"),
                        rs.getString("result"),
                        rs.getString("lfid") == null || "USER".equals(rs.getString("fixture_home")),
                        rs.getString("created_at")))
                .list();
    }

    /**
     * isAdmin 은 P3 §C additive — 기존 필드(id, nickname)는 불변.
     * tutorialDone 은 #209 additive — web 이 그동안 옵셔널로 읽기만 하던 필드를 실제로 발행한다
     * (SoT 가 클라 localStorage 에서 서버로 올라왔다. 덱 지급이 이 값에 매달리기 때문).
     */
    public record UserRef(String id, String nickname, boolean isAdmin, boolean tutorialDone) {
    }

    /** gems 는 V2.2 재화 이원화 additive — 기존 points 는 불변(웹 무회귀). */
    public record WalletInfo(long points, long gems) {
    }

    public record Records(long wins, long draws, long losses) {
    }

    /**
     * rating(#245 additive) = 원정 레이팅. <b>wallet.points 와 다른 축</b>이다 — 포인트는 뽑기·강화로
     * 소비되는 재화라 실력을 말하지 못한다. 초기 0, 하한 없음(hero 확정).
     */
    /**
     * 리그 디비전(#268 additive). <b>시즌과 무관</b>하게 현재 값이다 — 승급/강등은 시즌 사이에
     * 일어나므로 시즌이 없는 구간(첫 진입·시즌 종료 후 새 시즌 전)에도 "내가 몇 부인지"가 필요하다.
     * 사다리 표가 없으면(구 발행물 롤백) <b>league 자체가 null</b> — 디비전 개념이 꺼진 상태다.
     */
    public record LeagueInfo(int division, String divisionName) {
    }

    /**
     * 우편함 요약(#323 additive) — {@code unread} 는 뱃지 숫자, {@code total} 은 <b>진입점을 그릴지</b>.
     *
     * <p><b>전용 엔드포인트를 만들지 않은 이유</b>: 홈은 이미 이 호출을 하고 있어서 필드 하나면
     * 왕복이 늘지 않는다. 값의 정의(= "아직 내가 할 일")는 서버가 정한다 — 클라가 목록을 받아 세면
     * 목록 상한(50건) 밖의 우편물이 조용히 빠진다. 계산은 인덱스 COUNT 2회다.
     *
     * <p>⚠️ {@code total} 이 있어야 홈이 <b>목록을 안 받고도</b> 진입점 유무를 정한다. 없던 동안
     * web 은 홈 진입마다 본문까지 실린 목록을 받았고, 그러면 이 필드는 아무도 안 쓰는 죽은 값이었다
     * (독립검증 MINOR-1).
     */
    public record MailInfo(int unread, int total) {
        static MailInfo of(online.hmb.mail.MailService.Summary s) {
            return new MailInfo(s.unread(), s.total());
        }
    }

    /**
     * league 는 #268 additive · mail 은 #323 additive — 기존 필드 불변(web 무회귀).
     * league 가 null 이면 화면에서 사라진다.
     */
    public record MeResponse(UserRef user, WalletInfo wallet, Records records, int rating,
                             LeagueInfo league, MailInfo mail) {
    }

    public record MatchListItem(String id, String opponentName, Integer scoreHome, Integer scoreAway,
                                 String result, boolean userWasHome, String createdAt) {
    }
}
