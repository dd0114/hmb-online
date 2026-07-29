package online.hmb.chars;

import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 아트 번들 <b>공개 읽기</b> (#309 W2) — 지금 활성인 리비전이 무엇이고, 그 안의 파일이 무엇인가.
 *
 * <p>운영(업로드·활성화)은 {@code AdminCharBundleService} 다. 공지 이미지와 같은 이유로 갈라 둔다:
 * {@code AdminRouteGuard} 가 admin 빈에 의존하는 핸들러를 게이트 밖에서 <b>부팅 실패</b>로 막으므로,
 * 공개 서빙 컨트롤러는 admin 쪽을 참조할 수 없다.
 */
@Service
public class CharBundleService {

    private final JdbcClient jdbcClient;
    private final CharBundleStorage storage;

    public CharBundleService(JdbcClient jdbcClient, CharBundleStorage storage) {
        this.jdbcClient = jdbcClient;
        this.storage = storage;
    }

    /** 활성 리비전 id. 없으면 비어 있다 → web 이 <b>구운 폴백</b>을 쓴다(= 아트 배포 이전 상태). */
    public Optional<String> activeRevisionId() {
        return jdbcClient.sql("SELECT id FROM char_bundles WHERE active = 1 LIMIT 1")
                .query(String.class)
                .optional();
    }

    /**
     * web 이 부팅 시 읽는 신호. <b>없으면 404</b> 이고, 그게 폴백 트리거다.
     *
     * <p>왜 {@code 200 {}} 이 아니라 404 인가: web 이 "유효한 응답일 때만 서버 base 를 쓴다"를
     * 지켜야 하는데, 성공 껍데기를 주면 목·프록시·구 서버가 준 빈 객체와 구분이 안 된다.
     * 없다는 사실은 없다고 말하는 편이 소비 측 판정을 단순하게 만든다.
     */
    public Optional<BundleIndex> index() {
        return jdbcClient.sql("""
                        SELECT id, file_count, byte_size, created_at
                        FROM char_bundles WHERE active = 1 LIMIT 1
                        """)
                .query((rs, rowNum) -> new BundleIndex(
                        rs.getString("id"),
                        rs.getInt("file_count"),
                        rs.getLong("byte_size"),
                        rs.getString("created_at"),
                        CharBundleStorage.REQUIRED_ENTRIES))
                .optional()
                // ⚠️ **DB 만 믿지 않는다**(독립검증 MAJOR-2). 볼륨을 잃고 DB 만 복원하면 행은
                //    "REV2 서빙 중"이라 말하는데 파일이 없다. 그 상태에서 200 을 주면 web 이
                //    서버 base 를 채택하고 매니페스트 4종이 전부 404 가 되어 **구운 폴백으로
                //    돌아갈 경로가 사라진다** — 화면이 통째로 이니셜이 된다(실측).
                //    여기서 파일을 확인하면 "번들 없음"이 되어 web 이 정상적으로 폴백한다.
                .filter(idx -> storage.read(idx.revision(), CharBundleStorage.REQUIRED_ENTRIES.get(0)) != null);
    }

    /** 활성 리비전에서 파일 하나. 활성 번들이 없거나 파일이 없으면 {@code null}(→ 404). */
    public CharBundleStorage.Served read(String relPath) {
        return activeRevisionId().map(id -> storage.read(id, relPath)).orElse(null);
    }

    /**
     * @param requiredEntries web 이 반드시 찾을 수 있어야 하는 파일 목록. 응답에 실어서
     *                        소비 측이 "이 번들이 내가 아는 모양인가"를 값으로 확인할 수 있게 한다.
     */
    public record BundleIndex(String revision, int fileCount, long byteSize, String createdAt,
                              java.util.List<String> requiredEntries) {
    }
}
