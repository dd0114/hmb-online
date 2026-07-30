package online.hmb.common;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/** ApiException -> ApiError JSON 변환 (LLD §3 에러 규약). */
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiError> handleApiException(ApiException ex) {
        return ResponseEntity.status(ex.getStatus()).body(ex.toApiError());
    }

    /**
     * <b>없는 경로는 404 다</b>(#335). 매핑되지 않은 요청은 Spring 이 정적 리소스 조회로 흘리고,
     * 거기서 난 {@link NoResourceFoundException} 이 아래 포괄 핸들러에 걸려 <b>500</b> 이 됐다 —
     * 오탈자 URL 하나가 "서버가 아프다"로 보고됐다는 뜻이다(실측:
     * {@code GET /api/mails/{id}} → {@code 500 "No static resource api/mails/01KY…"}).
     *
     * <p>왜 중요한가: 이 서버는 <b>"없는 것"과 "못 보는 것"을 구분 불가능하게</b> 만드는 데 공을
     * 들여 왔다(예약 공지 404 #297 · 남의 우편 404 #323). 그런데 정작 <b>오타는 500</b> 이라 다르게
     * 보였다 — 클라는 재시도·알림을 걸고, 운영 대시보드의 5xx 카운트에는 잡음이 섞인다.
     *
     * <p>⚠️ <b>예외 메시지를 그대로 흘리지 않는다.</b> {@code "No static resource api/…"} 는 내부 구현
     * (정적 리소스 폴백)을 노출하고 요청 경로를 되비춘다. 도메인 404 와 <b>같은 코드·같은 톤</b>으로
     * 답한다. 정적 리소스 디렉토리 자체가 없는 앱이라(리소스는 전부 컨트롤러가 디스크에서 서빙한다)
     * 이 매핑이 삼킬 정상 경로도 없다.
     */
    @ExceptionHandler({NoResourceFoundException.class, NoHandlerFoundException.class})
    public ResponseEntity<ApiError> handleNoRoute(Exception ex) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ApiError("NOT_FOUND", "요청한 경로를 찾을 수 없습니다"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleUnexpected(Exception ex) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ApiError("INTERNAL_ERROR", ex.getMessage()));
    }
}
