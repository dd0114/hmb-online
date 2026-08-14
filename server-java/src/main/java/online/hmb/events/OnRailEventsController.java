package online.hmb.events;

import java.util.LinkedHashMap;
import java.util.Map;
import online.hmb.common.ApiException;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * <b>온레일 튜토리얼 관측 입구</b> (#504 D2) — 클라이언트가 사실을 보고하는 <b>유일한</b> 엔드포인트.
 *
 * <h2>왜 이것이 필요했나</h2>
 * 온레일(#493)은 브라우저 안에서만 도는 안내 계층이라 진행 상태가 {@code localStorage
 * hmb.onrail.<userId>} 하나뿐이고, 서버에 남는 흔적은 S2 를 마친 뒤의 {@code matches.is_tutorial}
 * 뿐이었다. 그래서 오픈베타 실유저 2명이 온레일을 한 명도 밟지 않은 것을 확인하고도
 * <b>"제안을 못 받았다"와 "제안을 받고 거절했다"를 DB 로 가를 수 없었다</b> — 세 가설의 서버
 * 흔적이 완전히 같았다(#504 조사). 관측이 없으면 D1(동선)을 고쳐도 <b>고쳐졌는지 셀 수 없다</b>.
 *
 * <h2>신뢰 경계 — 이 값들은 지표지 근거가 아니다</h2>
 * 클라가 보내는 값이므로 <b>집계로만</b> 쓴다. 보상·권한·게이트의 근거로 쓰지 마라 —
 * #493 W9 가 {@code tutorial_complete}(클라 신고)를 완주 보상 판정에서 걷어내고 서버 사실
 * ({@code matches.is_tutorial = 1} 이 FINISHED)로 옮긴 것이 바로 그 교훈이다.
 * 위조 표면은 {@link BusinessEvent#CLIENT_REPORTABLE} 화이트리스트로 좁힌다 — 열어 두면 클라가
 * {@code match_finish} 같은 <b>서버 사실</b>을 위조해 퍼널을 오염시킬 수 있다.
 *
 * <h2>훅이 컨트롤러인 것은 관례가 아니라 규칙이다</h2>
 * 이 리포엔 {@code @Transactional} 이 없고 트랜잭션은 {@code TxRunner} 로 명시적이다. 그 람다
 * <b>안</b>에서 이벤트 INSERT 가 실패하면 예외를 삼켜도 바깥 트랜잭션이 같이 롤백된다 = 계측이
 * 게임을 깨뜨린다(#492). 여기는 애초에 열리는 트랜잭션이 없어 그 위험이 <b>구조적으로</b> 0 이다.
 * 계약 = {@code BusinessEventHookPlacementTest.EXPECTED_HOOKS}(이 파일이 그 표에 등록돼 있다).
 *
 * <h2>중복 억제</h2>
 * 한 번뿐인 사건 5종({@link BusinessEvent#CLIENT_ONCE_PER_USER})은 {@code recordOnce} 로 유저당
 * 1행이다 — 새로고침·재진입이 스트림을 도배하지 않게(#496 관용구). {@code onrail_step} 만
 * 반복이 의미를 가지므로 그냥 append 하고, 스텝별 1회로 좁히는 것은 <b>클라</b>가 한다
 * (진행 상태와 같은 저장소에 살아야 새로고침을 넘긴다).
 */
@RestController
public class OnRailEventsController {

    /**
     * {@code stepId} 상한. 클라가 보내는 문자열이라 <b>길이를 서버가 자른다</b> — 스텝 목록의
     * 권위는 web(`onrail-script.ts`)이므로 값 자체를 화이트리스트로 잡지 않는다(잡으면 스텝을
     * 하나 추가할 때마다 서버 배포가 필요해져서 계측이 늘지 않는다 — {@code business_events} 에
     * CHECK 를 걸지 않은 것과 같은 판단, V42).
     */
    static final int MAX_STEP_ID = 64;

    private final BusinessEventRecorder events;

    public OnRailEventsController(BusinessEventRecorder events) {
        this.events = events;
    }

    /**
     * {@code POST /api/me/onrail-events}.
     *
     * <p>응답은 <b>언제나 200</b>이다(요청이 모양을 갖춘 한). {@code recorded} 는 "이번 호출이
     * 새 행을 남겼나"가 <b>아니라</b> "받아서 기록기에 넘겼나"다 — 기록기는 예외를 전부 삼키고
     * 중복도 조용히 흡수하므로, 클라가 그 결과로 분기할 것이 없다. 분기할 것이 없어야 계측
     * 실패가 동선을 바꾸지 않는다.
     */
    @PostMapping("/api/me/onrail-events")
    public Response report(@RequestAttribute("userId") String userId,
                           @RequestBody(required = false) Request body) {
        String event = body == null ? null : trimOrNull(body.event());
        if (event == null || !BusinessEvent.CLIENT_REPORTABLE.contains(event)) {
            // 미지 이벤트는 400 이다 — 조용히 삼키면 오타 하나가 "그 유저는 그 단계를 안 밟았다"는
            // 거짓말로 굳는다(조회 필터가 미지 event 를 400 으로 거절하는 것과 같은 이유, #492).
            // ⚠️ 받은 문자열을 되비추지 않는다(#335 규율 — 요청 반사는 그 자체로 표면이다).
            throw ApiException.validation("알 수 없는 온레일 이벤트입니다.");
        }

        String stepId = clamp(trimOrNull(body.stepId()));
        String path = clamp(trimOrNull(body.path()));
        Map<String, Object> props = new LinkedHashMap<>();
        if (stepId != null) {
            props.put("stepId", stepId);
        }
        if (path != null) {
            props.put("path", path);
        }

        if (BusinessEvent.CLIENT_ONCE_PER_USER.contains(event)) {
            events.recordOnce(event, userId, () -> props);
        } else {
            events.record(event, userId, () -> props);
        }
        return new Response(true);
    }

    private static String trimOrNull(String raw) {
        if (raw == null) {
            return null;
        }
        String t = raw.trim();
        return t.isEmpty() ? null : t;
    }

    private static String clamp(String raw) {
        if (raw == null) {
            return null;
        }
        return raw.length() <= MAX_STEP_ID ? raw : raw.substring(0, MAX_STEP_ID);
    }

    /** {@code stepId} 는 {@code onrail_step} 에만, {@code path} 는 {@code onrail_offer_missed} 에만 실린다. */
    public record Request(String event, String stepId, String path) {
    }

    public record Response(boolean recorded) {
    }
}
