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
