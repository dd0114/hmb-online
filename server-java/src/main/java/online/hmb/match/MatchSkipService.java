package online.hmb.match;

import java.util.Map;
import java.util.Set;
import online.hmb.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * 경기 스킵 (#421 W1) — {@code POST /api/matches/{id}/skip}.
 *
 * <p><b>설계 한 줄</b>: 재생 창({@code phase_ends_at})을 지금으로 <b>당기기만</b> 하고, 그 뒤는
 * <b>기존 만료 전이</b>({@link MatchClockService#advanceDue})가 그대로 밟는다. 새 상태 전이 엣지가
 * 0개여야 한다 — #249 오토가 감독시간 길이를 0으로 만들어 같은 방식으로 끝냈다. 새 엣지를 파면
 * 전이표·CAS·정산 멱등을 전부 다시 증명해야 하고, 그게 이 도메인에서 가장 비싼 실수다.
 *
 * <p><b>왜 바디 {@code phase} 가 필수인가</b>(이 클래스의 존재 이유의 절반). 전반 막바지 스킵과
 * 스위퍼의 감독시간 개시는 1초 안에 겹칠 수 있다. phase 없는 스킵이 그 창에서 재전송되면 <b>다음
 * 단계를 통째로 날린다</b>(감독시간을 건너뛰거나, 후반 재생을 시작하자마자 끝낸다). 그래서 phase 를
 * CAS {@code WHERE state=?} 에 넣어 <b>구조적으로</b> 막는다 — 같은 함정을 #249 는
 * {@code MatchService.setAutoCas} 의 {@code auto &&} 한 토큰으로 막았다.
 *
 * <p><b>heavy 경로를 요청 안에서 돈다</b>: {@code advanceDue}(스위퍼용, GEN2 시뮬 ≈0.3s 포함). 조회
 * 경로가 쓰는 {@code advanceDueForRead} 로는 후반 시작이 스위퍼 주기(1s)로 밀려 "닫으면 바로 후반"이
 * 성립하지 않는다(유저에게 GEN2 스피너가 스쳐간다). 스킵은 유저가 명시적으로 기다리기로 한 요청이라
 * 그 비용을 요청 스레드에서 치르는 게 맞다.
 */
@Service
public class MatchSkipService {

    private static final Logger log = LoggerFactory.getLogger(MatchSkipService.class);

    /**
     * 스킵할 수 있는 단계 = <b>유저가 장면을 보고 있는 재생 창</b> 둘. 생성(GEN*)·감독시간은 스킵
     * 대상이 아니다 — 감독시간을 끝내는 문은 이미 있다({@code POST /resume} · 오토 #249).
     */
    static final Set<String> SKIPPABLE_PHASES =
            Set.of(MatchService.S_FIRST_HALF, MatchService.S_SECOND_HALF);

    private final MatchService matchService;
    private final MatchClockService clockService;
    private final MatchSkipProperties props;

    public MatchSkipService(MatchService matchService, MatchClockService clockService,
                            MatchSkipProperties props) {
        this.matchService = matchService;
        this.clockService = clockService;
        this.props = props;
    }

    /**
     * 스킵 — 검증 → 창 당김(CAS) → 만료 전이 → (실패 시) 창 복구.
     *
     * @param phase 유저가 지금 보고 있다고 주장하는 단계(필수). 현재 상태와 다르면 409.
     * @return 전이 후 매치 행
     */
    public MatchService.MatchRow skip(String userId, String matchId, String phase) {
        MatchService.MatchRow row = matchService.getOwned(userId, matchId); // 남의 매치는 404
        if (phase == null || !SKIPPABLE_PHASES.contains(phase)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR",
                    "phase 는 FIRST_HALF 또는 SECOND_HALF 여야 합니다",
                    Map.of("field", "phase"));
        }
        if (!props.isEnabled()) {
            // 롤백 스위치 — 조용한 성공(200 no-op)이면 클라가 "다음 단계가 열렸다"고 믿는다.
            throw invalidState(row.state());
        }
        if (!phase.equals(row.state())) {
            // 이미 전이됐거나(재전송) 다른 단계를 지목했다. 여기서 200 을 주면 "무엇이 스킵됐는가"가
            // 모호해지고, 재전송이 다음 단계를 삼킬 문을 스스로 여는 셈이 된다.
            throw invalidState(row.state());
        }

        MatchClockService.PulledWindow pulled = clockService.pullWindowToNow(matchId, phase);
        try {
            // 만료 전이는 기존 경로가 소유한다(FIRST_HALF→HALFTIME[→GEN2→SECOND_HALF, 오토면],
            // SECOND_HALF→FINISHED+정산). 보상 1회 보장은 정산 경계 CAS 가 이미 갖고 있다.
            clockService.advanceDue(matchId);
        } catch (RuntimeException e) {
            // D8: 당김만 남고 전이가 죽으면 abandonable(= phase_ends_at + stuck-grace)이 앞당겨져
            // 정상 재생 중인 경기에 포기(리롤) 버튼이 열린다. 되돌리고 실패를 그대로 보고한다.
            boolean restored = clockService.restoreWindow(matchId, phase, pulled);
            log.error("skip 전이 실패 — match {} phase {} (창 복구 {}): {}",
                    matchId, phase, restored ? "성공" : "불필요/경합", e.toString());
            throw e;
        }
        return matchService.getOwned(userId, matchId);
    }

    private ApiException invalidState(String state) {
        return new ApiException(HttpStatus.CONFLICT, "INVALID_STATE",
                "현재 상태(" + state + ")에서 허용되지 않는 액션입니다: skip",
                Map.of("state", state, "action", "skip"));
    }
}
