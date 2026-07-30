package online.hmb.notice;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 공지 이미지 <b>바이트의 보관소</b> (#309 W1). 읽기(공개 서빙)와 쓰기(admin 업로드)가 같이 쓴다.
 *
 * <p><b>어디에 두나</b>: 기본값이 SQLite 파일의 <b>같은 디렉토리</b>(도커에서는 영속 볼륨
 * {@code /var/lib/hmb})다. 볼륨을 하나로 유지하면 <b>백업 대상이 하나</b>다 — 별도 볼륨을 만들면
 * DB 는 복구됐는데 이미지만 사라진 상태가 생기고, 그때 공지 본문은 멀쩡히 남아 깨진 그림을
 * 가리킨다. economy override 파일이 이미 같은 규칙을 쓴다(선례).
 *
 * <p><b>이 클래스에 admin 타입 참조가 없다는 것이 설계다</b>: {@code AdminRouteGuard} 는 admin
 * 전용 빈에 (전이적으로) 의존하는 핸들러가 게이트 밖에 매핑되면 <b>부팅을 막는다</b>. 공개
 * 서빙 컨트롤러가 이 보관소를 쓰므로, 여기가 admin 쪽을 참조하는 순간 서버가 뜨지 않는다.
 * 방향은 항상 <b>admin → 이 클래스</b> 한 방향이다.
 */
@Component
public class NoticeAssetStorage {

    private final Path root;

    /**
     * @param dir       {@code hmb.notice.asset.dir} — 비우면 DB 파일 옆 {@code notice-assets/}
     * @param dbPath    {@code hmb.db.path} — 기본 위치를 유도하는 기준
     * @param maxBytes  업로드 상한. 볼륨 보호이지 기능 제약이 아니다(env 로 무배포 조정).
     */
    public NoticeAssetStorage(@Value("${hmb.notice.asset.dir:}") String dir,
                              @Value("${hmb.db.path:./.data/hmb.db}") String dbPath,
                              @Value("${hmb.notice.asset.max-bytes:2097152}") long maxBytes) {
        this.root = dir == null || dir.isBlank() ? defaultDir(dbPath) : Path.of(dir);
        this.maxBytes = maxBytes;
    }

    private final long maxBytes;

    private static Path defaultDir(String dbPath) {
        Path db = Path.of(dbPath).toAbsolutePath();
        Path parent = db.getParent();
        return (parent == null ? Path.of(".") : parent).resolve("notice-assets");
    }

    public long maxBytes() {
        return maxBytes;
    }

    public Path root() {
        return root;
    }

    /**
     * 저장 파일명 → 실제 경로. <b>파일명은 언제나 {@code {ULID}.{ext}}</b> 이므로 사용자 입력이
     * 경로에 도달하지 않는다(그게 경로 탈출을 규칙이 아니라 구조로 막는 방식이다).
     * 그래도 한 겹 더 확인한다 — 결과가 root 밖이면 거절(심층방어).
     */
    public Path resolve(String storedName) {
        Path path = root.resolve(storedName).normalize();
        if (!path.startsWith(root.normalize())) {
            throw new IllegalArgumentException("자산 경로가 보관소 밖을 가리킨다: " + storedName);
        }
        return path;
    }

    /**
     * 임시파일 → ATOMIC_MOVE. <b>반쯤 쓰인 파일이 서빙되는 창</b>을 없앤다
     * ({@code AdminEconomyService.writeAtomically} 와 같은 패턴 — 파일시스템이 원자적 이동을
     * 지원하지 않으면 일반 move 로 폴백).
     */
    public void write(String storedName, byte[] bytes) {
        Path target = resolve(storedName);
        try {
            Files.createDirectories(root);
            Path tmp = Files.createTempFile(root, "upload", ".tmp");
            try {
                Files.write(tmp, bytes);
                try {
                    Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                    Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(tmp);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("자산을 저장하지 못했습니다: " + storedName, e);
        }
    }

    /** DB 기록이 실패했을 때 방금 쓴 파일을 되돌린다(고아 파일 방지). */
    public void removeQuietly(String storedName) {
        try {
            Files.deleteIfExists(resolve(storedName));
        } catch (IOException | RuntimeException ignored) {
            // 되돌리기 실패가 원래의 실패를 덮으면 안 된다 — 고아 파일은 서빙되지 않는다(DB 행이 없다).
        }
    }

    /** 없으면 {@code null} — 호출부가 404 로 옮긴다(파일과 DB 가 어긋나도 500 이 되지 않게). */
    public byte[] read(String storedName) {
        Path path = resolve(storedName);
        try {
            return Files.exists(path) ? Files.readAllBytes(path) : null;
        } catch (IOException e) {
            return null;
        }
    }
}
