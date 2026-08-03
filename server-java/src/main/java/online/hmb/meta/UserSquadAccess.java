package online.hmb.meta;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * "이 유저가 저 유저의 <b>선수단</b>을 볼 수 있는가" 한 조각(#432).
 *
 * <p><b>자격은 DB 행이다</b> — {@link online.hmb.away.AwayViewAccess} 가 관전 권한을
 * {@code away_reports} 행으로 표현하는 그 방식이다. 임의 {@code userId} 조회는 열지 않는다:
 * {@code AwayService.offerCandidates}/{@code consumeOffer} 가 "상대 지목"을 명시적으로 닫아 둔
 * 설계라(부계정 반복 지목 = 레이팅 무한 생성), 그 문을 선수단 조회로 우회해 열면 안 된다.
 *
 * <p>세 절 전부 <b>클라가 이미 서버에서 그 userId 를 받은</b> 대상이다:
 * <ol>
 *   <li><b>현재 유효한 원정 후보 제시</b>({@code away_offers}) — TTL 은 제시와 같은 값을 본다.
 *       만료된 제시로 나중에 골라 담지 못하는 것과 같은 이유로, 만료되면 볼 수도 없다.</li>
 *   <li><b>나를 친 원정 기록</b>({@code away_reports}, 내가 수비자) — 복수 큐에 뜨는 그 사람.</li>
 *   <li><b>랭킹보드 등재</b> — <b>보드가 실제로 내주는 목록에 있는가</b>. 원정
 *       ({@code AwayService.rankings}) 또는 리그({@code LeagueService.rankings}) 를 <b>그대로 부른다</b>.</li>
 * </ol>
 *
 * <p>⚠️ <b>보드 등재를 재발명하지 않는다</b>(독립검증 major-1). 초판은 "완료 경기 임계"
 * ({@link online.hmb.eligibility.EligibilityService}) 하나만 복제했는데, 실제 원정 보드는 <b>시즌 창</b>(그 주에 실제로
 * 원정을 치렀나)과 <b>상위 N</b>까지 지난다. 그래서 과거 연습 1판만 있는 제3자가 아무 관계 없는
 * 유저에게 열렸다 — 요청서가 자격의 근거로 든 문장은 <i>"전부 클라가 이미 서버에서 그 userId 를
 * 받은 대상"</i> 인데, 시즌 밖·순위 밖 유저의 id 는 클라에 준 적이 없다.
 *
 * <p><b>왜 limit 에 {@code Integer.MAX_VALUE} 를 넘기나</b>: 두 보드 모두 {@code Math.min(limit, 100)}
 * 으로 자른다 = <b>이 보드가 어떤 요청에도 내줄 수 있는 최대 범위</b>가 100 이다. 여기에 숫자를 적으면
 * (예: 기본값 20) 보드를 {@code ?limit=50} 으로 받은 클라가 21~50위 행을 눌렀을 때 404 가 난다
 * (web 은 실제로 50 을 쓴다). 상한을 <b>보드가 스스로 정하게</b> 두면 그 값이 바뀌어도 따라간다.
 *
 * <p>절 순서도 계약이다: <b>싼 것부터</b>(제시 → 리포트 → 보드). 보드 조회는 시즌 표를 물어
 * 순위표를 통째로 집계하는 무거운 경로라, 게임 안에서 흔한 두 경로(방금 제시받은 상대·나를 친
 * 상대)는 거기까지 가지 않는다.
 */
@Component
public class UserSquadAccess {

    private static final Logger log = LoggerFactory.getLogger(UserSquadAccess.class);

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;
    private final online.hmb.away.AwayService awayService;
    private final online.hmb.league.LeagueService leagueService;
    private final long offerTtlSec;

    public UserSquadAccess(JdbcClient jdbcClient,
                           ObjectMapper objectMapper,
                           online.hmb.away.AwayService awayService,
                           online.hmb.league.LeagueService leagueService,
                           @Value("${hmb.away.match.offer-ttl-sec}") long offerTtlSec) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.awayService = awayService;
        this.leagueService = leagueService;
        this.offerTtlSec = offerTtlSec;
    }

    public boolean canView(String viewerId, String targetUserId) {
        return isOfferedTo(viewerId, targetUserId)
                || raidedMe(viewerId, targetUserId)
                || isOnABoard(viewerId, targetUserId);
    }

    /** ①서버가 지금 이 뷰어에게 제시해 둔 원정 후보인가(만료 제외). */
    private boolean isOfferedTo(String viewerId, String targetUserId) {
        record Offer(String candidates, String createdAt) {
        }
        Offer offer = jdbcClient.sql("SELECT candidates, created_at FROM away_offers WHERE user_id = ?")
                .param(viewerId)
                .query((rs, n) -> new Offer(rs.getString("candidates"), rs.getString("created_at")))
                .optional()
                .orElse(null);
        if (offer == null) {
            return false;
        }
        try {
            if (Instant.parse(offer.createdAt()).plusSeconds(offerTtlSec).isBefore(Instant.now())) {
                return false;
            }
            JsonNode arr = objectMapper.readTree(offer.candidates());
            for (JsonNode id : arr) {
                if (targetUserId.equals(id.asText())) {
                    return true;
                }
            }
        } catch (Exception e) {
            // 깨진 제시는 "자격 없음"이다 — 읽을 수 없는 근거로 문을 열지 않는다.
            log.warn("away_offers unreadable for viewer={}: {}", viewerId, e.toString());
        }
        return false;
    }

    /** ②나를 친 기록이 있는 상대인가(내가 수비자). */
    private boolean raidedMe(String viewerId, String targetUserId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE defender_id = ? AND attacker_id = ?")
                .params(viewerId, targetUserId)
                .query(Long.class)
                .single() > 0;
    }

    /**
     * ③랭킹보드(원정·리그)가 <b>실제로 내주는 목록</b>에 있는 유저인가.
     *
     * <p>보드와 <b>같은 함수</b>를 부른다 — 등재 규칙(시즌 창·상위 N·정렬)을 여기서 다시 쓰면
     * "보드엔 있는데 눌러도 안 열린다"(또는 그 반대)가 되고, 규칙이 하나 바뀔 때마다 두 곳이
     * 갈라진다. 보드가 죽어도 조회는 "자격 없음"으로 답한다(500 로 번지지 않게).
     */
    private boolean isOnABoard(String viewerId, String targetUserId) {
        return onAwayBoard(viewerId, targetUserId) || onLeagueBoard(viewerId, targetUserId);
    }

    private boolean onAwayBoard(String viewerId, String targetUserId) {
        try {
            return awayService.rankings(viewerId, Integer.MAX_VALUE).entries().stream()
                    .anyMatch(e -> targetUserId.equals(e.userId()));
        } catch (RuntimeException e) {
            log.warn("away board unavailable for squad access: {}", e.toString());
            return false;
        }
    }

    private boolean onLeagueBoard(String viewerId, String targetUserId) {
        try {
            return leagueService.rankings(viewerId, "global", Integer.MAX_VALUE).entries().stream()
                    .anyMatch(e -> targetUserId.equals(e.userId()));
        } catch (RuntimeException e) {
            log.warn("league board unavailable for squad access: {}", e.toString());
            return false;
        }
    }
}
