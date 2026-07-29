package online.hmb.notice;

import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import online.hmb.common.ApiException;

/**
 * 공지의 <b>시각 표기와 상태 판정</b> — 유저 피드({@link NoticeService})와 admin 운영
 * ({@code AdminNoticeService})이 <b>같은 규칙</b>을 쓰게 만드는 한 곳.
 *
 * <p>빈이 아니라 정적 유틸인 이유: 이 규칙은 admin 데이터가 아니라 <b>공용 시간 규칙</b>이다.
 * 스프링 빈으로 만들어 admin 서비스가 주입하면 {@code AdminRouteGuard} 의 오염 전파에 얽혀
 * 공개 컨트롤러가 게이트 밖 위반으로 잡힌다(그리고 상태가 없어 빈일 이유도 없다).
 *
 * <p><b>왜 정규화가 필요한가(조용한 버그의 자리)</b>: SQLite 에는 시각 타입이 없어 창(window)
 * 비교가 <b>문자열 사전순</b>이다. 소수초가 섞이면 {@code "…:00.123Z" < "…:00Z"} 가 되어 같은 초
 * 안에서 순서가 뒤집힌다({@code '.'}=0x2E &lt; {@code 'Z'}=0x5A). 그래서 저장·비교에 쓰는 모든
 * 시각을 <b>초 단위 절삭 ISO-8601 UTC</b>(고정 20자)로 통일한다.
 */
public final class Notices {

    /** 서버가 판정하는 공지 생애 상태 — 화면이 다시 계산하지 않게 그대로 내려준다. */
    public enum Status {
        /** 지금 유저에게 보이는 상태(= {@code GET /api/notices/active} 에 실린다). */
        LIVE,
        /** 노출 ON 이지만 시작 전. */
        SCHEDULED,
        /** 운영 스위치가 내려간 상태(기간과 무관). */
        OFF,
        /** 종료 시각이 지난 상태. */
        EXPIRED,
        /** soft delete(행은 남아 있고 원장이 참조한다). */
        DELETED
    }

    private Notices() {
    }

    /** 비교·저장에 쓰는 '지금'. 초 단위로 절삭해 저장 표기와 자릿수를 맞춘다. */
    public static String now(Clock clock) {
        return Instant.now(clock).truncatedTo(ChronoUnit.SECONDS).toString();
    }

    /**
     * 운영자가 넣은 시각 문자열을 저장 표기로 정규화한다. {@code null}/공백은 "제한 없음"이다.
     *
     * <p>오프셋 표기({@code 2026-07-30T09:00+09:00})도 받는다 — 운영 화면이 로컬 시각을 보내는 것이
     * 자연스럽고, 거절하면 운영자가 손으로 UTC 를 계산하다 하루를 틀린다.
     */
    public static String normalizeInstant(String raw, String field) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String trimmed = raw.trim();
        Instant instant;
        try {
            instant = Instant.parse(trimmed);
        } catch (DateTimeParseException e) {
            try {
                instant = OffsetDateTime.parse(trimmed).toInstant();
            } catch (DateTimeParseException e2) {
                throw ApiException.validation(
                        field + " 는 ISO-8601 시각이어야 합니다(예: 2026-07-30T00:00:00Z): " + raw);
            }
        }
        return instant.truncatedTo(ChronoUnit.SECONDS).toString();
    }

    /**
     * 상태 판정. 우선순위는 <b>DELETED → OFF → EXPIRED → SCHEDULED → LIVE</b> 다.
     *
     * <p>삭제·중지가 기간보다 앞서는 이유: 운영자가 "왜 안 보이나"를 물을 때 알아야 하는 것은
     * <b>가장 강한 차단 사유</b>다. 중지된 공지에 "EXPIRED" 를 보여 주면 기간을 늘리는 잘못된
     * 조치를 하게 된다.
     */
    public static Status status(boolean active, String deletedAt, String startsAt, String endsAt, String now) {
        if (deletedAt != null) {
            return Status.DELETED;
        }
        if (!active) {
            return Status.OFF;
        }
        if (endsAt != null && endsAt.compareTo(now) < 0) {
            return Status.EXPIRED;
        }
        if (startsAt != null && startsAt.compareTo(now) > 0) {
            return Status.SCHEDULED;
        }
        return Status.LIVE;
    }
}
