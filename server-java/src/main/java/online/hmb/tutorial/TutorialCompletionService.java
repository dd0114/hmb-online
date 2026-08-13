package online.hmb.tutorial;

import online.hmb.match.MatchService;
import online.hmb.rewards.UxActionRewardService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * #493 W9 — 튜토리얼 <b>완료 판정의 권위</b>. 완주 보상(TUTORIAL_DONE)이 발화하는 유일한 자리다.
 *
 * <p><b>고친 결함</b>: 보상이 {@code POST /api/me/tutorial-complete} 라는 <b>클라 신고</b> 시점에
 * 발화했다. 그 엔드포인트는 완료 모달을 스킵해도, 클라가 임의로 불러도 200 이므로 "튜토리얼을
 * 끝냈다"는 사실을 <b>클라가 선언하고 서버가 그대로 믿는</b> 구조였다 — 즉 GEM 300 을 아무 때나
 * 청구할 수 있었다.
 *
 * <p><b>고친 방식</b>: 지급의 근거를 <b>서버가 이미 아는 사실</b>로 옮긴다 —
 * {@code matches.is_tutorial = 1} 인 매치가 {@code FINISHED} 다. 그 상태는 서버가 정산 CAS 로 직접
 * 쓰는 값이라 클라가 만들 수 없고, 파밍 차단(V44 {@code TUTORIAL_ALREADY_PLAYED})이 이미 같은 사실을
 * 판정 축으로 쓰고 있다 — 그래서 이 클래스가 <b>그 질의의 단일 출처</b>가 된다(둘이 갈라지면 "409 는
 * 이미 했다는데 보상은 안 나온다"가 된다).
 *
 * <p>발화 지점이 둘인 이유:
 * <ul>
 *   <li>{@code MatchOrchestrator.finishMatch} — 서버가 그 사실을 <b>만드는 순간</b>. 클라 호출이
 *       한 번도 없어도(모달 스킵·앱 종료) 지급된다.</li>
 *   <li>{@code OnboardingService.complete} — <b>기존 클라 경로(호환)</b>. 호출은 계속 받되
 *       같은 판정을 통과해야만 지급한다. 자산 없이 구운 매치를 못 쓰는 배포(아래)와 구버전 클라를
 *       위한 자리다.</li>
 * </ul>
 * 두 경로 모두 {@link UxActionRewardService#grantOnce} 를 지나므로 <b>멱등 축은 그대로</b>
 * {@code uq_user_mails_user_campaign} 하나다(새 표를 만들지 않는다 — V33 머리말).
 *
 * <p>⚠️ <b>{@code users.tutorial_done} 은 판정 근거가 아니다.</b> 그 컬럼은 완료 API 가 무조건 1 로
 * 쓰는 값이라(플래그는 게이트가 아니라는 {@code OnboardingService} 머리말) 근거로 쓰면 결함이 이름만
 * 바뀐 채 그대로 남는다.
 *
 * <p>⚠️ <b>자산이 없는 배포의 폴백</b>: {@code TUTORIAL_UNAVAILABLE} 이면 web 은 일반 연습경기로
 * 폴백하므로({@code apps/web/src/onrail/onrail-api.ts}) 그 배포에서는 {@code is_tutorial} 매치가
 * <b>영원히 생기지 않는다</b>. 판정을 좁게만 두면 완주 보상이 조용히 사라진다("지급 누락"이 아니라
 * "그 배포에서는 도달 불가"). 그래서 자산이 없을 때만 <b>끝난 매치가 하나라도 있다</b>로 물러선다 —
 * 이것도 여전히 서버 사실이고(경기를 실제로 끝까지 치렀다), 화면만 스킵한 유저에게는 열리지 않는다.
 *
 * <p><b>호출 규약</b>: 자체 tx 를 열지 않는다 — 두 호출자 모두 자기 tx 안에서 부른다
 * ({@link UxActionRewardService} 와 같은 규약).
 */
@Service
public class TutorialCompletionService {

    private static final Logger log = LoggerFactory.getLogger(TutorialCompletionService.class);

    private final JdbcClient jdbcClient;
    private final UxActionRewardService uxActionRewardService;
    private final TutorialMatchAsset asset;

    public TutorialCompletionService(JdbcClient jdbcClient,
                                     UxActionRewardService uxActionRewardService,
                                     TutorialMatchAsset asset) {
        this.jdbcClient = jdbcClient;
        this.uxActionRewardService = uxActionRewardService;
        this.asset = asset;
    }

    /**
     * 끝낸 튜토리얼 매치 수. 파밍 차단(409 {@code TUTORIAL_ALREADY_PLAYED})과 완주 보상이
     * <b>같은 질의</b>를 보게 하려고 여기 둔다. {@code ABANDONED}·{@code FAILED} 는 사고 회수
     * 경로라 세지 않는다(V44 머리말).
     */
    public int finishedTutorialMatches(String userId) {
        Integer n = jdbcClient.sql(
                        "SELECT COUNT(*) FROM matches WHERE user_id = ? AND is_tutorial = 1 AND state = ?")
                .params(userId, MatchService.S_FINISHED)
                .query(Integer.class)
                .single();
        return n == null ? 0 : n;
    }

    /** 서버가 아는 "튜토리얼을 끝냈다". 클라의 신고는 여기에 들어오지 않는다. */
    public boolean completed(String userId) {
        if (finishedTutorialMatches(userId) > 0) {
            return true;
        }
        // 구운 자산이 없는 배포에서만 물러선다(머리말) — 있으면 이 완화가 켜지지 않는다.
        return !asset.available() && finishedMatches(userId) > 0;
    }

    /**
     * 완료가 <b>서버 사실로</b> 확인되면 완주 보상 1통. 호출자 tx 안에서 부를 것.
     *
     * @return 이번 호출이 실제로 우편을 만들었는가(멱등이라 false 가 정상 경로다)
     */
    public boolean grantIfCompleted(String userId) {
        if (!completed(userId)) {
            log.debug("tutorial reward skipped — no server-side completion for user {}", userId);
            return false;
        }
        return uxActionRewardService.grantOnce(userId, UxActionRewardService.UxAction.TUTORIAL_DONE);
    }

    private int finishedMatches(String userId) {
        Integer n = jdbcClient.sql("SELECT COUNT(*) FROM matches WHERE user_id = ? AND state = ?")
                .params(userId, MatchService.S_FINISHED)
                .query(Integer.class)
                .single();
        return n == null ? 0 : n;
    }
}
