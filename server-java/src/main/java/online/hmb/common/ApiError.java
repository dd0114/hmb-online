package online.hmb.common;

import java.util.Map;

/**
 * 전 엔드포인트 공통 에러 응답 바디. (LLD §3)
 * {"code":"DECK_INVALID","message":"선발이 11명이 아닙니다","detail":{...}}
 */
public record ApiError(String code, String message, Map<String, Object> detail) {
    public ApiError(String code, String message) {
        this(code, message, null);
    }
}
