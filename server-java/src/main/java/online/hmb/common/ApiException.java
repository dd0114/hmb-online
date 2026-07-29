package online.hmb.common;

import java.util.Map;
import org.springframework.http.HttpStatus;

/**
 * 도메인 검증 실패를 ApiError JSON 규약으로 매핑하기 위한 unchecked 예외.
 * code 값은 openapi.yaml components.schemas.ErrorCode 열거값과 일치해야 한다.
 */
public class ApiException extends RuntimeException {
    private final HttpStatus status;
    private final String code;
    private final Map<String, Object> detail;

    public ApiException(HttpStatus status, String code, String message) {
        this(status, code, message, null);
    }

    public ApiException(HttpStatus status, String code, String message, Map<String, Object> detail) {
        super(message);
        this.status = status;
        this.code = code;
        this.detail = detail;
    }

    public static ApiException unauthorized(String message) {
        return new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", message);
    }

    public static ApiException validation(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message);
    }

    public static ApiException notFound(String message) {
        return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
    }

    /**
     * 410 — <b>있었지만 지금은 끝난</b> 리소스. 404 와 나누는 이유는 클라가 안내 문구를 고를 수 있게
     * 하기 위해서다(#297: 만료·중지 공지 = "기간이 지난 공지입니다" + 로비 복귀).
     *
     * <p>⚠️ 존재를 숨겨야 하는 것에는 쓰지 마라 — 410 은 "그 id 는 실재한다"를 흘린다.
     * 그래서 아직 공개 전인 예약 공지는 410 이 아니라 {@link #notFound} 다.
     */
    public static ApiException gone(String message) {
        return new ApiException(HttpStatus.GONE, "GONE", message);
    }

    public HttpStatus getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }

    public Map<String, Object> getDetail() {
        return detail;
    }

    public ApiError toApiError() {
        return new ApiError(code, getMessage(), detail);
    }
}
