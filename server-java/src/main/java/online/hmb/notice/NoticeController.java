package online.hmb.notice;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import online.hmb.common.ApiException;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * 공지 <b>공개</b> 엔드포인트 2개 — 로비 팝업 피드(#248)와 공유 딥링크 단건(#297, 에픽 #293).
 *
 * <p><b>둘 다 인증이 필요 없다</b>({@code WebMvcConfig.excludePathPatterns}). 근거는
 * {@code /api/config} 와 같다 — 유저별 데이터가 0인 전체 브로드캐스트이고, 무엇보다
 * <b>점검 공지는 로그인이 안 될 때 가장 필요하다</b>. 단건은 여기에 더해 <b>공유 링크는 정의상
 * 미로그인 상태에서 열린다</b> — 401 을 두면 카톡으로 받은 링크가 로그인 벽부터 보여 준다.
 * 계약 = {@code NoticeActiveApiTest.activeNoticesAreReachableWithoutAuth} ·
 * {@code NoticeByIdApiTest.reachableWithoutAuth}.
 *
 * <p>피드 응답은 항상 {@code {"notices":[…]}} 객체이고(배열 통짜가 아니다), 단건은 공지 객체
 * <b>그 자체</b>다 — 클라가 한 건을 그대로 팝업 카드에 넘길 수 있게.
 */
@RestController
public class NoticeController {

    /**
     * 공지 상태 → HTTP 코드 (hero 확정, #293/#297).
     *
     * <pre>
     *   LIVE                        → 200 + 본문
     *   EXPIRED · OFF               → 410  "기간이 지난 공지입니다" 안내 후 로비 복귀
     *   SCHEDULED · DELETED · 없는id → 404  존재 자체를 숨긴다
     * </pre>
     *
     * <p><b>예약(SCHEDULED)이 410 이 아니라 404 인 이유</b>: 410 은 "그 id 는 실재한다"를 흘린다.
     * 아직 공개하지 않은 공지가 링크 한 줄로 존재를 들키면 운영이 준비 중인 내용(점검 일정·이벤트)이
     * 먼저 퍼진다. 그래서 예약 공지는 <b>없는 id 와 응답이 같아야</b> 한다.
     *
     * <p>표로 둔 이유: 분기문으로 흩어 놓으면 새 상태가 생겼을 때 {@code default} 로 조용히
     * 흘러 200 이 샌다. {@code EnumMap} + 조회 실패 시 명시적 실패로, <b>결정하지 않은 상태</b>가
     * 공개 응답이 되는 길을 막는다(계약 = {@code NoticeByIdStatusTest.everyStatusHasADecision}).
     */
    private static final Map<Notices.Status, java.util.function.Function<String, ApiException>> BLOCKED =
            new EnumMap<>(Map.of(
                    Notices.Status.EXPIRED, id -> ApiException.gone("기간이 지난 공지입니다: " + id),
                    Notices.Status.OFF, id -> ApiException.gone("기간이 지난 공지입니다: " + id),
                    // ⚠️ 메시지가 '없는 id' 와 같아야 한다 — 문구로 존재가 새면 코드만 404 인 것은 소용없다.
                    Notices.Status.SCHEDULED, NoticeController::absent,
                    Notices.Status.DELETED, NoticeController::absent));

    private final NoticeService notices;
    private final NoticeAssetService assets;

    public NoticeController(NoticeService notices, NoticeAssetService assets) {
        this.notices = notices;
        this.assets = assets;
    }

    @GetMapping("/api/notices/active")
    public ActiveNoticesResponse active() {
        return new ActiveNoticesResponse(notices.active());
    }

    /**
     * 공유 딥링크가 읽는 단건. 상태 판정은 <b>{@link Notices#status}</b> 에서 파생된다 —
     * 여기서 기간·스위치를 다시 계산하면 규칙이 피드·admin 과 갈라진다.
     */
    @GetMapping("/api/notices/{id}")
    public NoticeService.PublicNotice byId(@PathVariable String id) {
        NoticeService.NoticeDetail found = notices.byId(id).orElseThrow(() -> absent(id));
        if (found.status() == Notices.Status.LIVE) {
            return found.notice();
        }
        // 결정표에 없는 상태 = 아직 아무도 판단하지 않은 상태다. 200 으로 흘리지 않고 숨긴다.
        throw BLOCKED.getOrDefault(found.status(), NoticeController::absent).apply(id);
    }

    /**
     * {@code GET /api/notices/assets/{id}} — 공지 본문이 참조하는 <b>이미지</b> (#309 W1).
     *
     * <p><b>같은 이유로 공개다</b>: 이 바이트는 위 두 엔드포인트가 돌려주는 본문이 가리키는 그림이다.
     * 여기에만 401 을 두면 점검 공지가 글은 뜨고 그림만 깨진 상태로 보이고, 공유 링크는 더 나쁘다
     * (미로그인 상태에서 열리므로 그림이 항상 비어 보인다).
     *
     * <p>⚠️ <b>{@code byId} 와 경로가 겹치지 않는다</b>: 저건 3세그먼트({@code /api/notices/{id}}),
     * 이건 4세그먼트다. 다만 {@code /api/notices/assets}(id 없이)는 {@code byId} 에 id="assets" 로
     * 걸려 <b>없는 공지와 같은 404</b> 를 돌려준다 — 존재를 흘리지 않으므로 그대로 둔다.
     *
     * <p><b>헤더 셋이 계약이다</b>:
     * <ul>
     *   <li>{@code Content-Type} = 업로드 때 <b>매직바이트로 확정한</b> 값(클라 신고값이 아니다).</li>
     *   <li>{@code nosniff} = 브라우저가 그 바이트를 다른 타입으로 해석하지 못하게. 화이트리스트
     *       (SVG 제외)와 <b>짝으로만</b> 방어가 성립한다.</li>
     *   <li>{@code immutable} 장기 캐시 = id 당 내용이 불변이다(재업로드는 새 id).
     *       ⚠️ 대가: 노출을 꺼도 이미 캐시된 브라우저에는 한동안 남는다 — <b>급히 내려야 하는
     *       그림이면 자산이 아니라 공지를 내려라</b>(그건 즉시 반영된다).</li>
     * </ul>
     */
    @GetMapping("/api/notices/assets/{id}")
    public ResponseEntity<byte[]> asset(@PathVariable("id") String id) {
        NoticeAssetService.Served served = assets.find(id);
        if (served == null) {
            throw ApiException.notFound("이미지를 찾을 수 없습니다: " + id);
        }
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(served.contentType()))
                .header("X-Content-Type-Options", "nosniff")
                .cacheControl(CacheControl.maxAge(java.time.Duration.ofDays(365)).cachePublic().immutable())
                .body(served.bytes());
    }

    /**
     * 없는 공지 — 예약·삭제도 이것과 <b>구분 불가능</b>해야 한다.
     *
     * <p>메시지에 id 를 넣지 않는다(410 과 달리): 요청한 id 를 되돌려 주는 것 자체는 정보가 아니지만,
     * 응답 <b>전체가 바이트 단위로 같아야</b> "이 id 는 실재하나"를 어떤 방법으로도 물을 수 없다.
     * 계약 = {@code NoticeByIdStatusTest.scheduledIsIndistinguishableFromAbsent}(본문까지 동등 단언).
     */
    private static ApiException absent(String requestedIdDeliberatelyUnused) {
        return ApiException.notFound("공지를 찾을 수 없습니다.");
    }

    public record ActiveNoticesResponse(List<NoticeService.PublicNotice> notices) {
    }
}
