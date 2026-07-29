package online.hmb.chars;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import online.hmb.common.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 유닛 아트 번들의 <b>바이트 보관소 + zip 해제 검증</b> (#309 W2).
 *
 * <p>공지 이미지({@code NoticeAssetStorage})와 같은 볼륨에 산다 — 백업 대상을 하나로 유지한다.
 * 다른 점은 <b>다루는 것이 파일 하나가 아니라 트리 하나</b>라는 것이고, 그래서 위험도 다르다:
 * zip 해제는 <b>엔트리 이름이 곧 파일시스템 경로</b>가 되는 지점이라 검증을 통과한 이름만 쓴다.
 *
 * <p><b>막는 것 셋</b>:
 * <ul>
 *   <li><b>zip-slip</b> — {@code ../../etc/x} 같은 엔트리가 보관소 밖에 파일을 쓴다. 이름 검사
 *       <b>그리고</b> 해제 경로가 리비전 디렉토리 안인지 재확인(둘 다 둔다 — 이름 검사만으로는
 *       심볼릭 링크·인코딩 트릭에 자신할 수 없다).</li>
 *   <li><b>zip bomb</b> — 몇 KB 가 수 GB 로 풀린다. <b>해제 후</b> 누적 바이트와 엔트리 수를 세며
 *       상한을 넘으면 즉시 중단한다(압축 파일 크기만 재면 못 막는다).</li>
 *   <li><b>실행 가능한/해석되는 파일</b> — 확장자 화이트리스트(png·webp·json) + 이미지 매직바이트.
 *       HTML·SVG·스크립트가 우리 도메인에서 서빙되면 그 자체가 XSS 표면이다.</li>
 * </ul>
 *
 * <p>이 클래스에 admin 타입 참조가 없는 것도 설계다({@code NoticeAssetStorage} 와 같은 이유) —
 * 공개 서빙 컨트롤러가 이걸 쓰므로, admin 쪽을 참조하면 {@code AdminRouteGuard} 가 부팅을 막는다.
 */
@Component
public class CharBundleStorage {

    /** 서빙·해제를 허용하는 확장자와 그 content-type. 이 표 밖은 zip 에 들어 있어도 거부한다. */
    private static final Map<String, String> ALLOWED = Map.of(
            "png", "image/png",
            "webp", "image/webp",
            "json", "application/json");

    /** web 이 실제로 읽는 매니페스트 4종. 하나라도 없으면 번들이 아니다(반쯤 올린 것을 활성화하지 않는다). */
    public static final List<String> REQUIRED_ENTRIES = List.of(
            "manifest.json",
            "characters/manifest.json",
            "units/manifest.json",
            "player-chars.json");

    private final Path root;
    private final long maxTotalBytes;
    private final int maxEntries;

    public CharBundleStorage(@Value("${hmb.chars.bundle.dir:}") String dir,
                             @Value("${hmb.db.path:./.data/hmb.db}") String dbPath,
                             @Value("${hmb.chars.bundle.max-total-bytes:67108864}") long maxTotalBytes,
                             @Value("${hmb.chars.bundle.max-entries:2000}") int maxEntries) {
        this.root = dir == null || dir.isBlank() ? defaultDir(dbPath) : Path.of(dir);
        this.maxTotalBytes = maxTotalBytes;
        this.maxEntries = maxEntries;
    }

    private static Path defaultDir(String dbPath) {
        Path db = Path.of(dbPath).toAbsolutePath();
        Path parent = db.getParent();
        return (parent == null ? Path.of(".") : parent).resolve("char-bundles");
    }

    public Path root() {
        return root;
    }

    public long maxTotalBytes() {
        return maxTotalBytes;
    }

    /** 리비전 디렉토리. 이름이 ULID 라 사용자 입력이 경로에 도달하지 않는다. */
    public Path revisionDir(String revisionId) {
        Path dir = root.resolve(revisionId).normalize();
        if (!dir.startsWith(root.normalize())) {
            throw new IllegalArgumentException("리비전 경로가 보관소 밖을 가리킨다: " + revisionId);
        }
        return dir;
    }

    /**
     * <b>1단계 — 읽고 검증만 한다(디스크에 손대지 않는다).</b>
     *
     * <p>왜 읽기와 쓰기를 이렇게까지 갈라 두나(독립검증 BLOCKER-1): 예전엔 이 메서드가 검증과
     * 쓰기를 <b>둘 다</b> 했고, 호출부가 그 <b>뒤에</b> 매니페스트를 파싱했다. 그래서 JSON 이 깨진
     * 번들은 "디스크에 다 쓴 뒤 거절"돼 <b>고아 리비전 디렉토리가 남았다</b>(실측: 400 을 받았는데
     * 최대 64MB 짜리 트리가 볼륨에 그대로). 회수 동사가 없는 보관소라 그건 영구 누수이고, 하필
     * <b>zip 을 몇 번 고쳐 올리는 것이 이 기능의 정상 사용 패턴</b>이다.
     *
     * <p>이제 <b>파싱을 포함한 모든 검증이 여기서 끝난다</b> — 호출부는 통과한 결과를 받아
     * {@link #write} 로 넘길 뿐이다. "통과 후에만 쓴다"가 문서의 주장이 아니라 코드의 구조다.
     */
    public Bundle read(byte[] zipBytes) {
        List<String> names = new ArrayList<>();
        List<byte[]> contents = new ArrayList<>();
        long total = 0;
        try (ZipInputStream zip = new ZipInputStream(new java.io.ByteArrayInputStream(zipBytes))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) {
                    continue;
                }
                String name = normalizeEntryName(entry.getName());
                if (name == null) {
                    continue; // 맥 zip 의 __MACOSX/·.DS_Store 등 잡음은 조용히 건너뛴다
                }
                if (names.size() >= maxEntries) {
                    throw ApiException.validation("번들 파일 수가 너무 많습니다(상한 " + maxEntries + "개)");
                }
                byte[] content = readEntry(zip, total);
                total += content.length;
                if (total > maxTotalBytes) {
                    throw ApiException.validation(
                            "번들 해제 크기가 너무 큽니다(상한 " + maxTotalBytes + " 바이트)");
                }
                validateContent(name, content);
                names.add(name);
                contents.add(content);
            }
        } catch (ApiException e) {
            throw e;
        } catch (IOException | RuntimeException e) {
            throw ApiException.validation("번들을 해제하지 못했습니다: " + e.getMessage());
        }

        // ⚠️ 엔트리가 하나도 없으면 **zip 이 아니다**(ZipInputStream 은 쓰레기 바이트에 조용히
        //    엔트리 0 으로 끝난다). 아래 "매니페스트가 없습니다"로 답하면 운영자가 zip 내용을
        //    뒤지러 간다 — 실제 문제는 파일 형식이다(독립검증 MIN-1).
        if (names.isEmpty()) {
            throw ApiException.validation("zip 파일이 아니거나 비어 있습니다 — "
                    + "로컬 아트 파이프라인의 /chars 트리를 통째로 압축해 올리세요");
        }

        List<String> stripped = stripCommonRoot(names);
        Map<String, byte[]> files = new LinkedHashMap<>();
        for (int i = 0; i < stripped.size(); i++) {
            files.put(stripped.get(i), contents.get(i));
        }
        for (String required : REQUIRED_ENTRIES) {
            if (!files.containsKey(required)) {
                throw ApiException.validation("번들에 " + required + " 가 없습니다 — "
                        + "web 이 읽는 매니페스트 4종이 모두 있어야 합니다: " + REQUIRED_ENTRIES);
            }
        }
        return new Bundle(files, total);
    }

    /**
     * <b>2단계 — 검증을 통과한 것만 쓴다.</b> 쓰는 도중 실패하면 부분 트리를 지운다.
     */
    public void write(String revisionId, Bundle bundle) {
        Path dir = revisionDir(revisionId);
        try {
            Files.createDirectories(dir);
            for (Map.Entry<String, byte[]> e : bundle.files().entrySet()) {
                writeEntry(dir, e.getKey(), e.getValue());
            }
        } catch (IOException | RuntimeException e) {
            removeQuietly(revisionId);
            throw e instanceof ApiException api ? api
                    : ApiException.validation("번들을 저장하지 못했습니다: " + e.getMessage());
        }
    }

    /**
     * 엔트리 이름 정규화. 허용하지 않는 것은 <b>예외</b>, 무시해도 되는 잡음은 {@code null}.
     *
     * <p>zip 툴마다 루트 폴더를 한 겹 씌우기도 하고 안 씌우기도 한다({@code chars/manifest.json}
     * vs {@code manifest.json}). 그 차이로 운영자가 "필수 파일이 없습니다"를 보는 건 함정이라,
     * <b>단일 루트 폴더는 벗겨 준다</b>.
     */
    static String normalizeEntryName(String raw) {
        String name = raw.replace('\\', '/').trim();
        if (name.startsWith("__MACOSX/") || name.endsWith("/.DS_Store") || name.equals(".DS_Store")) {
            return null;
        }
        if (name.isEmpty() || name.startsWith("/")) {
            throw ApiException.validation("번들 엔트리 경로가 올바르지 않습니다: " + raw);
        }
        // ⚠️ 여기가 zip-slip 을 막는 지점이다. `..` 세그먼트는 어디에 있든 거부한다.
        for (String seg : name.split("/")) {
            if (seg.equals("..") || seg.equals(".") || seg.isEmpty()) {
                throw ApiException.validation("번들 엔트리 경로가 올바르지 않습니다: " + raw);
            }
        }
        return name;
    }

    /** 루트 폴더 한 겹을 벗긴다(모든 엔트리가 같은 접두사를 공유할 때만). */
    public static List<String> stripCommonRoot(List<String> names) {
        if (names.isEmpty()) {
            return names;
        }
        String first = names.get(0);
        int slash = first.indexOf('/');
        if (slash <= 0) {
            return names;
        }
        String prefix = first.substring(0, slash + 1);
        for (String n : names) {
            if (!n.startsWith(prefix)) {
                return names;
            }
        }
        List<String> out = new ArrayList<>(names.size());
        for (String n : names) {
            out.add(n.substring(prefix.length()));
        }
        return out;
    }

    private byte[] readEntry(ZipInputStream zip, long alreadyRead) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        long budget = maxTotalBytes - alreadyRead;
        int n;
        while ((n = zip.read(buf)) > 0) {
            out.write(buf, 0, n);
            // 엔트리 하나가 상한을 통째로 먹는 경우(= zip bomb)를 **읽는 도중에** 끊는다.
            if (out.size() > budget) {
                throw ApiException.validation("번들 해제 크기가 너무 큽니다(상한 " + maxTotalBytes + " 바이트)");
            }
        }
        return out.toByteArray();
    }

    private static void validateContent(String name, byte[] content) {
        String ext = extensionOf(name);
        if (!ALLOWED.containsKey(ext)) {
            throw ApiException.validation("번들에 허용되지 않는 파일이 있습니다: " + name
                    + " (허용 확장자: " + ALLOWED.keySet().stream().sorted().toList() + ")");
        }
        if (ext.equals("json")) {
            return; // 매니페스트 파싱은 상위(서비스)가 한다 — 여기선 형식만 본다
        }
        // ⚠️ 확장자를 믿지 않는다 — `.png` 로 이름만 바꾼 HTML 이 우리 도메인에서 서빙되면 XSS 다.
        if (online.hmb.notice.NoticeAssetTypes.detect(content) == null) {
            throw ApiException.validation("이미지가 아닙니다(매직바이트 불일치): " + name);
        }
    }

    private void writeEntry(Path dir, String name, byte[] content) throws IOException {
        Path target = dir.resolve(name).normalize();
        // 이름 검사를 통과했어도 **해제 경로가 리비전 안인지** 한 번 더 본다(심층방어).
        if (!target.startsWith(dir.normalize())) {
            throw ApiException.validation("번들 엔트리가 보관소 밖을 가리킵니다: " + name);
        }
        Path parent = target.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Files.write(target, content);
    }

    /** 서빙 1건. 없으면 {@code null}(→ 404). 상대경로는 엔트리 이름과 같은 규칙으로 검증한다. */
    public Served read(String revisionId, String relPath) {
        String name;
        try {
            name = normalizeEntryName(relPath);
        } catch (ApiException e) {
            return null; // 조작된 경로는 "없다"로 답한다(무엇을 막았는지 알려 주지 않는다)
        }
        if (name == null) {
            return null;
        }
        String ext = extensionOf(name);
        String contentType = ALLOWED.get(ext);
        if (contentType == null) {
            return null;
        }
        Path target = revisionDir(revisionId).resolve(name).normalize();
        if (!target.startsWith(revisionDir(revisionId).normalize()) || !Files.exists(target)) {
            return null;
        }
        try {
            return new Served(Files.readAllBytes(target), contentType);
        } catch (IOException e) {
            return null;
        }
    }

    /** 활성화되지 못한 리비전 정리. 활성 리비전에는 절대 쓰지 않는다(호출부 책임). */
    public void removeQuietly(String revisionId) {
        try {
            Path dir = revisionDir(revisionId);
            if (!Files.exists(dir)) {
                return;
            }
            try (var walk = Files.walk(dir)) {
                walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                    try {
                        Files.deleteIfExists(p);
                    } catch (IOException ignored) {
                        // 남아도 서빙되지 않는다(DB 행이 없다)
                    }
                });
            }
        } catch (IOException | RuntimeException ignored) {
            // 정리 실패가 원래의 실패를 덮으면 안 된다
        }
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /** 검증을 통과한 번들(메모리) — 이름→바이트. 이 값이 있으면 쓸 수 있다는 뜻이다. */
    public record Bundle(Map<String, byte[]> files, long totalBytes) {
        public int fileCount() {
            return files.size();
        }
    }

    public record Served(byte[] bytes, String contentType) {
    }

    /** 매니페스트 요약(운영 화면 표시용). 파싱 실패는 상위에서 400 으로 옮긴다. */
    public static Map<String, Object> summarize(Map<String, Object> baseManifest,
                                                Map<String, Object> unitsManifest,
                                                Map<String, Object> mapping) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("placeholderCount", baseManifest == null ? null : baseManifest.get("playerCount"));
        out.put("unitsSource", unitsManifest == null ? null : unitsManifest.get("source"));
        out.put("unitsCount", unitsManifest == null ? null : unitsManifest.get("count"));
        out.put("mappingVersion", mapping == null ? null : mapping.get("version"));
        out.put("mappedPlayers", mapping == null ? null : mapping.get("playerCount"));
        return out;
    }
}
