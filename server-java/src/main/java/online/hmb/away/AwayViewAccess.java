package online.hmb.away;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * "이 유저가 이 매치를 <b>볼</b> 수 있는가" 한 조각(#245 hero Q5 — 피원정 당한 쪽도 경기를 본다).
 *
 * <p>왜 {@link AwayService} 가 아니라 따로 있나: 소유권 판정은 {@code MatchService} 가 하는데,
 * AwayService 는 매치 생성을 위해 MatchService 를 쓴다 — 같은 클래스에 두면 순환 의존이 된다.
 * 이 조각은 JdbcClient 만 안다.
 *
 * <p><b>권한의 근거는 리포트 행이다.</b> 리포트는 <b>터미널 상태</b>에서만 생기므로(FINISHED 정산
 * 또는 D1 몰수의 ABANDONED) 수비자가 열 수 있는 것은 <b>끝난 경기뿐</b>이다 — 진행 중인 남의 매치는
 * 어느 시점에도 열리지 않는다.
 *
 * <p>⚠️ 이 근거는 원래 "FINISHED 정산에서만"이었고 D1(몰수)이 그걸 깨뜨렸다(독립검증 2R blocker).
 * 안전성 논증을 좁은 사실에 매달면 상태를 하나 늘릴 때 조용히 거짓이 된다 — <b>"터미널이다"</b>로 잡아라. 그리고 이 판정은
 * <b>읽기 경로에만</b> 붙인다(킥오프·포기·프롬프트 등 쓰기는 계속 소유자 전용).
 */
@Component
public class AwayViewAccess {

    private final JdbcClient jdbcClient;

    public AwayViewAccess(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public boolean canWatch(String userId, String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE match_id = ? AND defender_id = ?")
                .params(matchId, userId)
                .query(Long.class)
                .single() > 0;
    }
}
