package online.hmb.notice;

import java.time.Clock;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 유저 피드 — "<b>지금</b> 보여야 하는 공지"를 서버가 정해서 내려준다 (#248 §2.1).
 *
 * <p><b>클라가 재계산하지 않는다</b>는 게 이 서비스의 계약이다. 클라가
 * {@code startsAt <= now <= endsAt} 를 계산하면 <b>기기 시계·타임존이 진실</b>이 되고(폰 시계가
 * 하루 빠른 유저에게 점검 공지가 안 뜬다), 나중에 규칙이 바뀌면 두 곳이 조용히 어긋난다.
 * {@code locked}/{@code abandonable} 을 서버가 판정하는 것과 같은 원칙(#217).
 */
@Service
public class NoticeService {

    private final JdbcClient jdbcClient;
    private final Clock clock;

    public NoticeService(JdbcClient jdbcClient, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.clock = clock;
    }

    /**
     * 지금 활성인 공지 — 다섯 조건의 연립(스위치 ON · 미삭제 · 시작함 · 안 끝남)을 <b>SQL 이</b> 건다.
     *
     * <p>정렬 = {@code priority DESC, starts_at DESC, id DESC}. 클라는 받은 순서 그대로 카드를
     * 쌓는다(중첩 스택 팝업, hero 컨펌 Q1) — 즉 "무엇이 맨 위인가"는 서버가 정하는 값이다.
     * {@code starts_at} 이 NULL(=상시)인 공지는 SQLite 의 DESC 정렬에서 <b>맨 뒤</b>로 간다:
     * 시작 시각이 없다 = 가장 오래된 공지 취급이라 의미와 일치한다.
     *
     * <p>경계는 <b>양끝 포함</b>이다 — 시작 정각에 뜨고 종료 정각까지 보인다. 운영자가 "13:00 까지"라고
     * 적었을 때 12:59:59 에 사라지면 설명하기 어렵다.
     */
    public List<ActiveNotice> active() {
        String now = Notices.now(clock);
        return jdbcClient.sql("""
                        SELECT id, revision, title, body, starts_at, ends_at, priority
                        FROM notices
                        WHERE active = 1
                          AND deleted_at IS NULL
                          AND (starts_at IS NULL OR starts_at <= ?)
                          AND (ends_at   IS NULL OR ends_at   >= ?)
                        ORDER BY priority DESC, starts_at DESC, id DESC
                        """)
                .params(now, now)
                .query((rs, rowNum) -> new ActiveNotice(
                        rs.getString("id"),
                        rs.getInt("revision"),
                        rs.getString("title"),
                        rs.getString("body"),
                        rs.getString("starts_at"),
                        rs.getString("ends_at"),
                        rs.getInt("priority")))
                .list();
    }

    /**
     * 팝업이 그리는 데 필요한 것만. {@code revision} 이 반드시 실린다 — 클라의 24시간 억제 키가
     * {@code id@revision} 이라, 이게 없으면 <b>오탈자를 고친 공지가 억제된 유저에게 영원히 안 보인다</b>.
     */
    public record ActiveNotice(String id, int revision, String title, String body,
                               String startsAt, String endsAt, int priority) {
    }
}
