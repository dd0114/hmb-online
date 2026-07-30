package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

/**
 * 유닛 아트 핫로드 (#309 W2). 설계 = {@code docs/plan-v5/ops-content.md} §7.
 *
 * <p><b>무엇을 지키나</b>: 유닛 <b>등록</b>은 이미 무배포였다(#207 파트 A). 남은 배포 의존은
 * <b>아트</b>였다 — 아틀라스 PNG · 매니페스트 3종 · player-chars 매핑이 전부 웹 빌드에 구워져
 * 있어서, 새 유닛에 그림을 붙이려면 웹을 다시 배포해야 했다.
 *
 * <p>여기서 단언하는 것은 "업로드가 201 을 준다"가 아니라 <b>올린 트리가 그대로 서빙되고,
 * 켜고 끄는 것이 되돌릴 수 있으며, 위험한 zip 이 실제로 막힌다</b>이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@org.junit.jupiter.api.TestMethodOrder(org.junit.jupiter.api.MethodOrderer.MethodName.class)
class CharBundleApiTest extends ApiTestBase {

    private static final String ADMIN_NICK = "charsadmin";
    private static final String ADMIN_PW = "chars-admin-pw-1234";

    /** 해제 상한을 작게 잡아 **경계가 실제로 도는지** 본다(GB 짜리 zip 을 만들지 않는다). */
    private static final int MAX_TOTAL = 64 * 1024;

    private static Path bundleDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) throws Exception {
        TestDbSupport.registerTempDb(registry);
        bundleDir = Files.createTempDirectory("hmb-char-bundles");
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
        registry.add("hmb.chars.bundle.dir", () -> bundleDir.toString());
        registry.add("hmb.chars.bundle.max-total-bytes", () -> MAX_TOTAL);
    }

    @Resource
    private JdbcClient jdbcClient;

    @BeforeEach
    void reset() {
        jdbcClient.sql("DELETE FROM char_bundles").update();
        jdbcClient.sql("DELETE FROM admin_ops_audit").update();
    }

    // ── 본 경로 ────────────────────────────────────────────────────────────

    /**
     * 올린 번들을 켜면 그 트리가 <b>공개 경로에서 그대로</b> 나온다. 이게 "웹 재배포 없이 아트
     * 교체"의 전부다.
     */
    @Test
    void anUploadedBundleServesItsFilesOnceActivated() {
        String admin = adminToken();

        Map<String, Object> uploaded = upload(admin, validBundle("hero-rev-9"), "9차 입고");
        String revision = (String) uploaded.get("id");
        assertThat(uploaded.get("active")).as("업로드는 활성화가 아니다 — 켜는 건 별도 동작").isEqualTo(false);
        // 아직 안 켰으니 서빙도 없다.
        assertThat(rest.getForEntity(baseUrl("/api/chars/index"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        activate(admin, revision);

        ResponseEntity<String> index = rest.getForEntity(baseUrl("/api/chars/index"), String.class);
        assertThat(index.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(index.getBody()).contains(revision).contains("units/manifest.json");

        ResponseEntity<String> manifest =
                rest.getForEntity(baseUrl("/api/chars/units/manifest.json"), String.class);
        assertThat(manifest.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(manifest.getBody()).as("올린 내용 그대로").contains("hero-rev-9");
        assertThat(manifest.getHeaders().getContentType().toString()).startsWith("application/json");

        ResponseEntity<byte[]> png = rest.getForEntity(baseUrl("/api/chars/units/avatars-64.png"), byte[].class);
        assertThat(png.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(png.getHeaders().getContentType()).isEqualTo(MediaType.IMAGE_PNG);
        assertThat(png.getHeaders().getFirst("X-Content-Type-Options")).isEqualTo("nosniff");
    }

    /**
     * <b>아트는 공개다</b> — 토큰 없이 읽힌다. 로그인 화면·가입 연출에서도 카드가 그려지므로,
     * 여기에 401 을 두면 그 화면들이 통째로 이니셜 폴백이 된다.
     */
    @Test
    void artIsReachableWithoutAuth() {
        String admin = adminToken();
        activate(admin, (String) upload(admin, validBundle("s1"), null).get("id"));

        assertThat(rest.getForEntity(baseUrl("/api/chars/index"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(rest.getForEntity(baseUrl("/api/chars/manifest.json"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    /**
     * <b>롤백이 기능이다</b>: 리비전을 갈아 끼우고, 전부 끄면 구운 폴백으로 돌아간다.
     * 끄기가 곧 "이 기능이 없던 상태"라 되돌릴 것이 항상 있다.
     */
    @Test
    void activationSwitchesRevisionsAndCanBeTurnedOffEntirely() {
        String admin = adminToken();
        String r1 = (String) upload(admin, validBundle("first"), null).get("id");
        String r2 = (String) upload(admin, validBundle("second"), null).get("id");

        activate(admin, r1);
        assertThat(body("/api/chars/units/manifest.json")).contains("first");

        activate(admin, r2);
        assertThat(body("/api/chars/units/manifest.json")).as("리비전 교체").contains("second");
        assertThat(activeCount()).as("활성은 언제나 최대 하나").isEqualTo(1);

        activate(admin, null); // 전부 끄기 = 구운 폴백으로 롤백
        assertThat(rest.getForEntity(baseUrl("/api/chars/index"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(activeCount()).isZero();

        // 되돌릴 수 있다 — 파일은 그대로 있다.
        activate(admin, r1);
        assertThat(body("/api/chars/units/manifest.json")).contains("first");
    }

    // ── 막아야 하는 것 ──────────────────────────────────────────────────────

    /**
     * <b>zip-slip</b> — {@code ../../} 엔트리가 보관소 밖에 파일을 쓰는 고전 취약점.
     * 거부되고, 부수효과가 0이어야 한다.
     */
    @Test
    void zipSlipEntriesAreRejected() throws Exception {
        String admin = adminToken();
        // ⚠️ 탈출 대상은 **보관소 밖**이라 시스템 temp 를 가리킨다 = 실행 간 공유되는 자리다.
        //    앞선 실행(특히 방어를 지워 보는 변이체 실험)이 남긴 파일을 이번 실패로 오인하지
        //    않도록 **먼저 지우고 시작**한다. 실제로 그렇게 오인한 적이 있다.
        Path escapeTarget = bundleDir.getParent().resolve("escaped.json");
        Files.deleteIfExists(escapeTarget);

        Map<String, byte[]> evil = new LinkedHashMap<>(validEntries("x"));
        evil.put("../../escaped.json", "{}".getBytes(StandardCharsets.UTF_8));

        ResponseEntity<Map> res = uploadRaw(admin, zip(evil), null);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(bundleCount()).isZero();
        assertThat(Files.exists(escapeTarget)).as("보관소 밖에 파일이 생기지 않았다").isFalse();
    }

    /** <b>zip bomb</b> — 해제 후 크기가 상한을 넘으면 거부(압축 크기로 재면 못 막는다). */
    @Test
    void oversizeAfterExtractionIsRejected() {
        String admin = adminToken();
        Map<String, byte[]> big = new LinkedHashMap<>(validEntries("x"));
        byte[] blob = new byte[MAX_TOTAL + 1024];
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
        System.arraycopy(png, 0, blob, 0, png.length);
        big.put("units/huge.png", blob); // 0 으로 가득 차 압축은 잘 되지만 풀면 크다

        ResponseEntity<Map> res = uploadRaw(admin, zip(big), null);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(bundleCount()).isZero();
    }

    /**
     * <b>확장자를 믿지 않는다</b> — `.png` 로 이름만 바꾼 HTML 이 우리 도메인에서 서빙되면
     * 그 자체가 XSS 표면이다. 매직바이트로 자른다.
     */
    @Test
    void nonImageDisguisedAsPngIsRejected() {
        String admin = adminToken();
        Map<String, byte[]> evil = new LinkedHashMap<>(validEntries("x"));
        evil.put("units/evil.png", "<html><script>alert(1)</script></html>".getBytes(StandardCharsets.UTF_8));

        ResponseEntity<Map> res = uploadRaw(admin, zip(evil), null);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(bundleCount()).isZero();
    }

    /** 화이트리스트 밖 확장자(html·svg·js)는 zip 안에 있어도 거부. */
    @Test
    void disallowedExtensionsAreRejected() {
        String admin = adminToken();
        Map<String, byte[]> evil = new LinkedHashMap<>(validEntries("x"));
        evil.put("units/x.svg", "<svg/>".getBytes(StandardCharsets.UTF_8));

        assertThat(uploadRaw(admin, zip(evil), null).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(bundleCount()).isZero();
    }

    /**
     * <b>반쯤 올린 것을 활성화하지 않는다</b> — web 이 읽는 매니페스트 4종이 다 있어야 번들이다.
     * 하나만 빠져도 그 축이 조용히 사라져 "일부만 옛 그림"이 된다.
     */
    @Test
    void aBundleMissingARequiredManifestIsRejected() {
        String admin = adminToken();
        Map<String, byte[]> partial = new LinkedHashMap<>(validEntries("x"));
        partial.remove("player-chars.json");

        ResponseEntity<Map> res = uploadRaw(admin, zip(partial), null);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(String.valueOf(res.getBody())).contains("player-chars.json");
        assertThat(bundleCount()).isZero();
    }

    /** 매니페스트가 JSON 으로 안 읽히면 거부 — 켜고 나서 부분 폴백이 되는 것보다 낫다. */
    @Test
    void aBundleWithBrokenManifestJsonIsRejected() throws Exception {
        String admin = adminToken();
        Map<String, byte[]> broken = new LinkedHashMap<>(validEntries("x"));
        broken.put("units/manifest.json", "{not json".getBytes(StandardCharsets.UTF_8));

        assertThat(uploadRaw(admin, zip(broken), null).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(bundleCount()).isZero();
    }

    /**
     * <b>거절된 번들은 디스크에도 아무것도 남기지 않는다</b> — 독립검증 BLOCKER-1.
     *
     * <p>이 계약이 없을 때 실제로 어땠나: 매니페스트 파싱이 <b>쓰기 뒤에</b> 있어서 JSON 이 깨진
     * 번들이 "다 쓴 뒤 400" 이 됐고 <b>최대 64MB 짜리 고아 디렉토리</b>가 볼륨에 남았다. 회수
     * 동사가 없는 보관소라 영구 누수이고, 하필 <b>zip 을 몇 번 고쳐 올리는 것이 이 기능의 정상
     * 사용 패턴</b>이다. 기존 테스트들은 DB 행만 셌기 때문에 전부 green 이었다.
     *
     * <p>그래서 거절 <b>전 종류</b>를 한 테스트에서 태우고 <b>디렉토리 수</b>로 단언한다 —
     * 새 거절 사유가 생길 때 여기 한 줄만 추가하면 같은 보증을 받는다.
     */
    @Test
    void everyRejectionLeavesNothingOnDisk() throws Exception {
        String admin = adminToken();
        long before = revisionDirCount();

        Map<String, byte[]> brokenJson = new LinkedHashMap<>(validEntries("x"));
        brokenJson.put("units/manifest.json", "{not json".getBytes(StandardCharsets.UTF_8));
        Map<String, byte[]> missing = new LinkedHashMap<>(validEntries("x"));
        missing.remove("player-chars.json");
        Map<String, byte[]> slip = new LinkedHashMap<>(validEntries("x"));
        slip.put("../../escaped2.json", "{}".getBytes(StandardCharsets.UTF_8));
        Map<String, byte[]> badExt = new LinkedHashMap<>(validEntries("x"));
        badExt.put("units/x.svg", "<svg/>".getBytes(StandardCharsets.UTF_8));
        Map<String, byte[]> fakePng = new LinkedHashMap<>(validEntries("x"));
        fakePng.put("units/evil.png", "<html>".getBytes(StandardCharsets.UTF_8));

        for (Map<String, byte[]> bad : List.of(brokenJson, missing, slip, badExt, fakePng)) {
            assertThat(uploadRaw(admin, zip(bad), null).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        }
        // zip 이 아예 아닌 바이트도 같은 보증을 받는다.
        ResponseEntity<Map> notZip =
                uploadRaw(admin, "not a zip at all".getBytes(StandardCharsets.UTF_8), null);
        assertThat(notZip.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        // ⚠️ **문구까지 본다**(재검증 MIN-B). ZipInputStream 은 쓰레기 바이트에 조용히 엔트리 0 으로
        //    끝나므로, 가드가 사라지면 "매니페스트가 없습니다"로 답한다 — 그러면 운영자가 zip
        //    내용을 뒤지러 간다. 실제 문제는 파일 형식이다. 상태코드만 보면 이 회귀를 못 잡는다.
        assertThat(String.valueOf(notZip.getBody().get("message")))
                .as("무엇이 잘못됐는지 정확히 말한다")
                .contains("zip");

        assertThat(bundleCount()).isZero();
        assertThat(revisionDirCount()).as("거절 6종 전부 — 볼륨에 고아 디렉토리 0").isEqualTo(before);
    }

    /**
     * <b>DB 가 실패하면 방금 쓴 트리도 되돌린다</b> — 독립검증 MAJOR-4.
     * (W1 공지 이미지에서 같은 지적을 받고 고쳤는데, 아트 번들엔 그 계약이 복사되지 않았다.)
     */
    @Test
    void aFailedDbWriteRollsBackTheWrittenTree() throws Exception {
        String admin = adminToken();
        long before = revisionDirCount();
        jdbcClient.sql("""
                CREATE TRIGGER zz_fail_bundle_insert BEFORE INSERT ON char_bundles
                BEGIN SELECT RAISE(ABORT, 'injected failure'); END
                """).update();
        try {
            assertThat(uploadRaw(admin, validBundle("x"), null).getStatusCode().is2xxSuccessful())
                    .as("DB 가 실패했으니 성공일 수 없다").isFalse();

            assertThat(bundleCount()).isZero();
            assertThat(revisionDirCount()).as("쓴 트리가 볼륨에 남지 않는다").isEqualTo(before);
        } finally {
            jdbcClient.sql("DROP TRIGGER zz_fail_bundle_insert").update();
        }
    }

    /**
     * <b>사유 없는 운영 변경은 없다</b> — 독립검증 MAJOR-3. openapi 가 `required` 로 선언하고
     * 형제 서비스(공지)가 강제하는 규칙인데, 아트 번들엔 계약이 없어 되돌려도 아무도 몰랐다.
     */
    @Test
    @SuppressWarnings("rawtypes")
    void aReasonIsRequiredForBundleOps() {
        String admin = adminToken();

        assertThat(uploadRaw(admin, validBundle("x"), null, null).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(uploadRaw(admin, validBundle("x"), null, "  ").getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(bundleCount()).isZero();

        String revision = (String) upload(admin, validBundle("x"), null).get("id");
        ResponseEntity<Map> noReason = authPost("/api/admin/chars/bundles/active", admin,
                java.util.Collections.singletonMap("revisionId", revision), Map.class);
        assertThat(noReason.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(activeCount()).as("거절은 부수효과 0").isZero();
    }

    /**
     * 삭제 엔드포인트는 <b>서버에도</b> 없다(D9·A4 와 같은 철학). web 버튼 부재만으로는
     * API 를 직접 부르는 경로가 열려 있는지 알 수 없다 — 독립검증 MIN-5.
     */
    @Test
    @SuppressWarnings("rawtypes")
    void thereIsNoBundleDeleteEndpoint() {
        String admin = adminToken();
        String revision = (String) upload(admin, validBundle("keep"), null).get("id");
        activate(admin, revision);

        ResponseEntity<Map> res = authDelete("/api/admin/chars/bundles/" + revision, admin, Map.class);

        assertThat(res.getStatusCode().is2xxSuccessful()).as("삭제가 성공해서는 안 된다").isFalse();
        assertThat(bundleCount()).isEqualTo(1);
        assertThat(body("/api/chars/units/manifest.json")).contains("keep");
    }

    /**
     * <b>DB 행은 있는데 파일이 없으면 "번들 없음"으로 답한다</b> — 독립검증 MAJOR-2.
     *
     * <p>볼륨을 잃고 DB 만 복원하면 정확히 이 상태가 된다(플레이북이 자산 백업을 권하는 바로 그
     * 상황). 여기서 200 을 주면 web 이 서버 base 를 채택하고 매니페스트가 전부 404 가 되어
     * <b>구운 폴백으로 돌아갈 경로가 사라진다</b> — 화면이 통째로 이니셜이 된다.
     */
    @Test
    void anActiveRevisionWithNoFilesIsReportedAsNoBundle() throws Exception {
        String admin = adminToken();
        String revision = (String) upload(admin, validBundle("gone"), null).get("id");
        activate(admin, revision);
        assertThat(rest.getForEntity(baseUrl("/api/chars/index"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // 볼륨 유실 재현 — DB 행은 그대로 두고 파일만 지운다.
        deleteRecursively(bundleDir.resolve(revision));

        assertThat(rest.getForEntity(baseUrl("/api/chars/index"), String.class).getStatusCode())
                .as("파일이 없으면 활성 번들이 아니다 → web 이 구운 폴백으로 간다")
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * <b>부분 유실도 "번들 없음"이다</b> — 재검증 MIN-A.
     *
     * <p>전멸만 막으면 절반이다: {@code manifest.json} 만 남은 상태에서 200 을 주면 web 은
     * 플레이스홀더 축이 살아 있어 <b>"빈 번들"로 보지 않고 폴백하지 않는다</b> → 캐릭터·유닛·
     * 매핑 축이 죽은 채로 굴러간다(얼굴 없는 화면인데 아무도 버그로 신고하지 않는다).
     */
    @Test
    void anActiveRevisionMissingSomeManifestsIsAlsoReportedAsNoBundle() throws Exception {
        String admin = adminToken();
        String revision = (String) upload(admin, validBundle("partial"), null).get("id");
        activate(admin, revision);

        // 플레이스홀더 매니페스트만 남기고 나머지 3종을 지운다.
        Files.deleteIfExists(bundleDir.resolve(revision).resolve("units/manifest.json"));
        Files.deleteIfExists(bundleDir.resolve(revision).resolve("characters/manifest.json"));
        Files.deleteIfExists(bundleDir.resolve(revision).resolve("player-chars.json"));

        assertThat(rest.getForEntity(baseUrl("/api/chars/index"), String.class).getStatusCode())
                .as("4종 중 하나라도 없으면 활성 번들이 아니다")
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /** 서빙 경로 조작은 "없다"로 답한다(무엇을 막았는지 알려주지 않는다). */
    @Test
    void servingRejectsPathTraversal() {
        String admin = adminToken();
        activate(admin, (String) upload(admin, validBundle("s"), null).get("id"));

        for (String bad : new String[] {"../../../etc/passwd", "units/../../escape.json"}) {
            assertThat(rest.getForEntity(baseUrl("/api/chars/" + bad), String.class)
                    .getStatusCode().is2xxSuccessful())
                    .as("경로 조작: " + bad)
                    .isFalse();
        }
    }

    /** 업로드·활성화는 admin 게이트 뒤 — 일반 유저는 403 이고 부수효과가 0이다. */
    @Test
    void bundleOpsAreBehindTheAdminGate() {
        String user = login("chars_plain");

        assertThat(uploadRaw(user, validBundle("x"), null).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authPost("/api/admin/chars/bundles/active", user,
                Map.of("revisionId", "whatever", "reason", "r"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authGet("/api/admin/chars/bundles", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(bundleCount()).isZero();
    }

    /** 없는 리비전을 켜려 하면 404 이고, 지금 활성인 것이 바뀌지 않는다. */
    @Test
    void activatingAnUnknownRevisionDoesNotDisturbTheCurrentOne() {
        String admin = adminToken();
        String r1 = (String) upload(admin, validBundle("keep"), null).get("id");
        activate(admin, r1);

        ResponseEntity<Map> res = authPost("/api/admin/chars/bundles/active", admin,
                Map.of("revisionId", "NOSUCH", "reason", "오타"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(body("/api/chars/units/manifest.json")).as("살아 있던 리비전 유지").contains("keep");
    }

    /** 업로드·활성화는 원장에 남는다(성공·실패 모두). */
    @Test
    void bundleOpsAreRecordedInTheAuditLog() {
        String admin = adminToken();
        String r = (String) upload(admin, validBundle("x"), null).get("id");
        activate(admin, r);
        uploadRaw(admin, zip(Map.of("manifest.json", "{}".getBytes(StandardCharsets.UTF_8))), null); // 실패

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> history =
                authGet("/api/admin/chars/bundles/history", admin, List.class).getBody();

        assertThat(history).extracting(e -> (String) e.get("action"))
                .contains("chars_bundle_upload", "chars_bundle_activate");
        assertThat(history).extracting(e -> (String) e.get("result")).contains("ok", "error");
    }

    /** zip 툴이 루트 폴더를 한 겹 씌워도 받아 준다(운영자가 "필수 파일 없음"을 보지 않게). */
    @Test
    void aBundleWrappedInASingleRootFolderIsAccepted() {
        String admin = adminToken();
        Map<String, byte[]> wrapped = new LinkedHashMap<>();
        validEntries("wrapped").forEach((k, v) -> wrapped.put("chars/" + k, v));

        String revision = (String) upload(admin, zip(wrapped), null).get("id");
        activate(admin, revision);

        assertThat(body("/api/chars/units/manifest.json")).contains("wrapped");
    }

    // ── 헬퍼 ───────────────────────────────────────────────────────────────

    private String body(String path) {
        ResponseEntity<String> res = rest.getForEntity(baseUrl(path), String.class);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** 보관소의 리비전 디렉토리 수 — "디스크에 남았나"를 DB 가 아니라 디스크로 묻는다. */
    private long revisionDirCount() throws Exception {
        if (!Files.exists(bundleDir)) {
            return 0;
        }
        try (var entries = Files.list(bundleDir)) {
            return entries.filter(Files::isDirectory).count();
        }
    }

    private static void deleteRecursively(Path dir) throws Exception {
        if (!Files.exists(dir)) {
            return;
        }
        try (var walk = Files.walk(dir)) {
            for (Path p : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        }
    }

    private int bundleCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM char_bundles").query(Integer.class).single();
    }

    private int activeCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM char_bundles WHERE active = 1")
                .query(Integer.class).single();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> upload(String token, byte[] zipBytes, String note) {
        ResponseEntity<Map> res = uploadRaw(token, zipBytes, note);
        assertThat(res.getStatusCode()).as("업로드 실패: " + res.getBody()).isEqualTo(HttpStatus.CREATED);
        return res.getBody();
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> uploadRaw(String token, byte[] zipBytes, String note) {
        return uploadRaw(token, zipBytes, note, "test");
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> uploadRaw(String token, byte[] zipBytes, String note, String reason) {
        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        HttpHeaders partHeaders = new HttpHeaders();
        partHeaders.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        partHeaders.setContentDispositionFormData("file", "chars.zip");
        form.add("file", new HttpEntity<>(new ByteArrayResource(zipBytes), partHeaders));

        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + token);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        String url = "/api/admin/chars/bundles"
                + (reason == null ? "" : "?reason=" + java.net.URLEncoder.encode(reason, StandardCharsets.UTF_8))
                + (note == null ? "" : (reason == null ? "?" : "&") + "note="
                        + java.net.URLEncoder.encode(note, StandardCharsets.UTF_8));
        return rest.exchange(baseUrl(url), HttpMethod.POST, new HttpEntity<>(form, headers), Map.class);
    }

    @SuppressWarnings("rawtypes")
    private void activate(String token, String revisionId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("revisionId", revisionId);
        body.put("reason", revisionId == null ? "롤백" : "적용");
        ResponseEntity<Map> res =
                authPost("/api/admin/chars/bundles/active", token, body, Map.class);
        assertThat(res.getStatusCode()).as("활성화 실패: " + res.getBody()).isEqualTo(HttpStatus.OK);
    }

    /** 실물 트리와 같은 모양의 최소 번들 — 매니페스트 4종 + PNG 하나. */
    private static Map<String, byte[]> validEntries(String marker) {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("manifest.json",
                ("{\"version\":1,\"playerCount\":172,\"source\":\"" + marker + "\"}").getBytes(StandardCharsets.UTF_8));
        entries.put("characters/manifest.json",
                ("{\"version\":1,\"count\":14,\"source\":\"" + marker + "\"}").getBytes(StandardCharsets.UTF_8));
        entries.put("units/manifest.json",
                ("{\"version\":1,\"count\":9,\"source\":\"" + marker + "\"}").getBytes(StandardCharsets.UTF_8));
        entries.put("player-chars.json",
                ("{\"version\":\"" + marker + "\",\"playerCount\":172,\"players\":{}}").getBytes(StandardCharsets.UTF_8));
        entries.put("units/avatars-64.png", pngBytes());
        return entries;
    }

    private static byte[] validBundle(String marker) {
        return zip(validEntries(marker));
    }

    private static byte[] zip(Map<String, byte[]> entries) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(out)) {
            for (Map.Entry<String, byte[]> e : entries.entrySet()) {
                zos.putNextEntry(new ZipEntry(e.getKey()));
                zos.write(e.getValue());
                zos.closeEntry();
            }
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
        return out.toByteArray();
    }

    private static byte[] pngBytes() {
        byte[] out = new byte[64];
        byte[] sig = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
        System.arraycopy(sig, 0, out, 0, sig.length);
        return out;
    }

    @SuppressWarnings("rawtypes")
    private String adminToken() {
        ResponseEntity<Map> res = rest.postForEntity(baseUrl("/api/auth/login"),
                Map.of("nickname", ADMIN_NICK, "provider", "local", "password", ADMIN_PW), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("token");
    }
}
