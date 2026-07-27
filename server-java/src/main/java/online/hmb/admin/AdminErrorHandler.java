package online.hmb.admin;

import online.hmb.common.ApiError;
import online.hmb.common.ApiException;
import online.hmb.common.SqliteErrors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * admin 컨트롤러 <b>전용</b> 예외 변환({@code assignableTypes} 로 범위를 못박는다).
 *
 * <p><b>왜 전역 핸들러를 고치지 않았나</b>: {@code GlobalExceptionHandler.handleUnexpected} 는
 * {@code ex.getMessage()} 를 그대로 응답에 싣는다. DB 예외가 거기 닿으면 <b>INSERT 문 전문과 인덱스
 * 구성이 응답 바디로 새어 나간다</b>(검증자 실측). 그걸 전역에서 고치면 모든 도메인의 500 응답 본문이
 * 한꺼번에 바뀌므로, 이번 웨이브 스코프를 넘는 회귀 위험이 있다. 그래서 <b>admin 경로만</b> 먼저 닫는다.
 * 다른 도메인의 동작은 한 바이트도 바뀌지 않는다(이 advice 는 admin 컨트롤러에만 붙는다).
 *
 * <p><b>상태코드 정책</b>: 선재 이슈(SQLITE_BUSY→500, NoResourceFoundException→500)의 <b>상태코드는
 * 바꾸지 않는다</b>(PRD-v4 §H 오픈 체크리스트로 별도 처리). 여기서는 <b>노출만</b> 막는다 —
 * 즉 500 은 500 그대로 두되 본문에서 내부 SQL·스키마를 지운다. 예외는 UNIQUE 위반 하나로,
 * 그건 "중복 요청"이라는 명확한 클라이언트 의미가 있어 409 로 올린다.
 *
 * <p>진단 정보를 잃지 않기 위해 원본 예외는 <b>서버 로그</b>에 남긴다(응답에는 안 나간다).
 */
@RestControllerAdvice(assignableTypes = {AdminController.class, AdminCatalogController.class})
@Order(Ordered.HIGHEST_PRECEDENCE)
public class AdminErrorHandler {

    private static final Logger log = LoggerFactory.getLogger(AdminErrorHandler.class);

    /** 도메인이 의도적으로 던진 예외는 그대로 통과 — 메시지가 사람 대상으로 작성된 것들이다. */
    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiError> handleApiException(ApiException ex) {
        return ResponseEntity.status(ex.getStatus()).body(ex.toApiError());
    }

    /**
     * DB 예외 — 응답에 <b>드라이버 메시지를 절대 싣지 않는다</b>(SQL 문·테이블명·인덱스 구성 유출 차단).
     */
    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<ApiError> handleDataAccess(DataAccessException ex) {
        log.warn("admin API DB error (응답에는 상세를 싣지 않는다)", ex);

        if (SqliteErrors.isUniqueViolation(ex)) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(new ApiError("CONFLICT",
                            "이미 처리된 요청입니다(중복 멱등키). 다른 Idempotency-Key 로 다시 시도하세요"));
        }
        if (SqliteErrors.isCheckViolation(ex)) {
            return ResponseEntity.badRequest()
                    .body(new ApiError("INSUFFICIENT_POINTS",
                            "잔액이 부족합니다(차감 후 잔액이 음수가 될 수 없습니다)"));
        }
        // 선재 이슈(SQLITE_BUSY 등)의 상태코드는 유지 — 본문만 소독한다.
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ApiError("INTERNAL_ERROR", "일시적인 오류로 요청을 처리하지 못했습니다"));
    }

    /**
     * <b>요청 본문 파싱 실패(minor-C)</b> — malformed/누락 JSON 바디.
     *
     * <p>왜 필요한가: 이 예외가 {@code AdminController} 진입 전에 던져지면 전역
     * {@code GlobalExceptionHandler.handleUnexpected} 가 {@code ex.getMessage()} 를 그대로 실어
     * <b>Jackson 파서 내부</b>(예 {@code enable JsonReadFeature.ALLOW_LEADING_PLUS_SIGN_FOR_NUMBERS},
     * {@code Unexpected character}, 파서 위치)를 admin 응답으로 흘린다(검증자 실측). 여기서 <b>깨끗한
     * 400</b> 으로 변환하고 원본은 <b>서버 로그에만</b> 남긴다 — 응답에는 일반 메시지만 나간다.
     * 상태코드는 프레임워크 기본과 일치하는 400(파싱 실패는 클라이언트 잘못) — openapi 의 기존 400 응답 규약.
     */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> handleUnreadableBody(HttpMessageNotReadableException ex) {
        log.warn("admin API 요청 본문 파싱 실패 (응답에는 상세를 싣지 않는다)", ex);
        return ResponseEntity.badRequest()
                .body(new ApiError("VALIDATION_ERROR", "요청 본문을 해석할 수 없습니다"));
    }

    /**
     * <b>쿼리/경로 파라미터 타입 불일치(minor-C 인접)</b> — 예 {@code ?limit=abc}({@code Integer} 로 변환 실패).
     *
     * <p>미변환 시 전역 핸들러가 {@code "Failed to convert value of type 'java.lang.String' to required type
     * 'java.lang.Integer'; For input string: \"abc\""} 를 그대로 노출한다(검증자 실측 — JDK 타입명·입력값 유출).
     * admin 파라미터 중 타입 변환이 걸리는 건 {@code /users} 의 {@code limit}/{@code offset}(Integer) 뿐이고
     * 경로변수는 전부 {@code String} 이라 이 예외가 안 난다. 여기서도 <b>깨끗한 400</b> 으로 막는다.
     */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ApiError> handleTypeMismatch(MethodArgumentTypeMismatchException ex) {
        log.warn("admin API 파라미터 타입 불일치 (응답에는 상세를 싣지 않는다)", ex);
        return ResponseEntity.badRequest()
                .body(new ApiError("VALIDATION_ERROR", "요청 파라미터가 올바르지 않습니다"));
    }

    // 의도적 제외(과잉 방지):
    //  · MissingServletRequestParameterException — admin 파라미터는 전부 required=false 라 발생 불가(죽은 핸들러).
    //  · HttpMessageNotWritableException — 잘 정의된 DTO/record 직렬화라 정상 운영에서 발생 불가.
    //    (클라이언트가 유발할 수 없는 서버측 버그 경로 — admin 노출 벡터가 아니다.)
}
