package online.hmb.meta;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import online.hmb.eligibility.EligibilityService;
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
 *   <li><b>랭킹보드 등재</b> — 원정 랭킹 자격({@link EligibilityService} 완료 경기 임계) 또는
 *       리그 시즌 참가. 보드에 이름이 실려 있는 사람이다.</li>
 * </ol>
 *
 * <p>왜 {@code AwayService}·{@code LeagueService} 를 주입하지 않고 직접 조회하나: 이 판정은 세
 * 도메인에 걸쳐 있어서, 서비스를 물면 meta → away → meta 의 빈 순환을 만든다({@code AwayService} 가
 * {@link DeckService} 를 쓴다). {@code MatchService} 가 {@code league_fixtures} 를 직접 읽는 것과
 * 같은 이유·같은 관례다. <b>SoT 는 표</b>이지 서비스가 아니다.
 */
@Component
public class UserSquadAccess {

    private static final Logger log = LoggerFactory.getLogger(UserSquadAccess.class);

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;
    private final EligibilityService eligibility;
    private final long offerTtlSec;

    public UserSquadAccess(JdbcClient jdbcClient,
                           ObjectMapper objectMapper,
                           EligibilityService eligibility,
                           @Value("${hmb.away.match.offer-ttl-sec}") long offerTtlSec) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.eligibility = eligibility;
        this.offerTtlSec = offerTtlSec;
    }

    public boolean canView(String viewerId, String targetUserId) {
        return isOnABoard(targetUserId)
                || isOfferedTo(viewerId, targetUserId)
                || raidedMe(viewerId, targetUserId);
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
     * ③랭킹보드(원정·리그)에 실리는 유저인가.
     *
     * <p>원정 보드의 등재 조건은 <b>완료 경기 임계</b>({@code EligibilityService}) 하나다 —
     * {@code RankingService} 가 그 값으로 자격을 판정하고 자격자만 순위에 올린다. 임계를 여기서
     * 다시 정의하지 않는 이유가 그것이다(꺼지면 임계 0 = 보드가 전원을 싣고, 여기도 같이 열린다).
     */
    private boolean isOnABoard(String targetUserId) {
        long finished = jdbcClient
                .sql("SELECT COUNT(*) FROM matches WHERE user_id = ? AND result IS NOT NULL")
                .param(targetUserId)
                .query(Long.class)
                .single();
        if (eligibility.isEligible((int) Math.min(finished, Integer.MAX_VALUE))) {
            return true;
        }
        return jdbcClient.sql("SELECT COUNT(*) FROM league_seasons WHERE user_id = ?")
                .param(targetUserId)
                .query(Long.class)
                .single() > 0;
    }
}
