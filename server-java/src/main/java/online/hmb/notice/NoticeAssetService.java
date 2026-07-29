package online.hmb.notice;

import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 공지 이미지 <b>공개 읽기</b> (#309 W1). 운영(업로드·노출 토글)은 {@code AdminNoticeAssetService} 다.
 *
 * <p><b>왜 읽기와 쓰기를 갈라 두나</b>: {@code AdminRouteGuard} 가 "admin 전용 빈에 의존하는
 * 핸들러는 {@code /api/admin/} 밖에 있을 수 없다"를 <b>부팅에서</b> 강제한다. 공개 서빙 컨트롤러가
 * admin 서비스를 한 번이라도 참조하면 서버가 뜨지 않는다. {@code NoticeController}(공개) 와
 * {@code AdminNoticeService}(운영) 가 이미 같은 구조다 — 새로 만든 규칙이 아니라 따르는 규칙이다.
 */
@Service
public class NoticeAssetService {

    /**
     * 서빙 id 형태 검사. 저장 파일명이 {@code {ULID}.{ext}} 라 경로 탈출은 이미 구조적으로
     * 불가능하지만(사용자 입력이 경로에 도달하지 않는다), <b>파일시스템에 닿기 전에</b> 한 번 더
     * 자른다. 두 층 중 하나가 나중에 리팩터링으로 사라져도 다른 층이 남는다.
     */
    private static final Pattern ID = Pattern.compile("^[0-9A-Za-z]{1,40}$");

    private final JdbcClient jdbcClient;
    private final NoticeAssetStorage storage;

    public NoticeAssetService(JdbcClient jdbcClient, NoticeAssetStorage storage) {
        this.jdbcClient = jdbcClient;
        this.storage = storage;
    }

    /** 서빙 1건. 없거나 <b>노출 OFF</b> 면 {@code null}(→ 404). */
    public Served find(String id) {
        if (id == null || !ID.matcher(id).matches()) {
            return null;
        }
        // active=0 이면 없는 것처럼 다룬다 — 끄는 것이 곧 내리는 것이다(hero 확정: 삭제 없음).
        // 다시 켜면 같은 바이트가 그대로 돌아온다.
        var row = jdbcClient.sql("""
                        SELECT stored_name, content_type
                        FROM notice_assets
                        WHERE id = ? AND active = 1
                        """)
                .params(id)
                .query((rs, rowNum) -> new String[] {rs.getString("stored_name"), rs.getString("content_type")})
                .optional();
        if (row.isEmpty()) {
            return null;
        }
        byte[] bytes = storage.read(row.get()[0]);
        // DB 행은 있는데 파일이 없는 경우(볼륨 유실 등)도 404 다 — 500 을 내면 공지 하나가
        // 관측 가능한 장애처럼 보이지만, 유저에게 필요한 결론은 "그 그림은 없다"뿐이다.
        return bytes == null ? null : new Served(bytes, row.get()[1]);
    }

    public record Served(byte[] bytes, String contentType) {
    }
}
