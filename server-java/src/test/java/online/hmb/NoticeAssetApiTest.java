package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
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
 * 공지 이미지 업로드·서빙 (#309 W1). 설계·결정표 = {@code docs/plan-v5/ops-content.md}.
 *
 * <p><b>이 웨이브가 푸는 문제</b>: 공지에 그림 한 장을 넣으려면 {@code apps/web/public/notice/} 에
 * 파일을 커밋하고 <b>웹을 다시 배포</b>해야 했다. 이제 운영자가 admin 에서 올리면 서버 볼륨에
 * 저장되고 공개 경로로 서빙된다.
 *
 * <p><b>여기서 단언하는 것은 "200 을 받았다"가 아니다</b> — 올린 <b>그 바이트가 그대로 공개
 * 경로에서 나오는가</b>, 그리고 <b>올릴 수 없는 것이 실제로 막히는가</b>다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@org.junit.jupiter.api.TestMethodOrder(org.junit.jupiter.api.MethodOrderer.MethodName.class)
class NoticeAssetApiTest extends ApiTestBase {

    private static final String ADMIN_NICK = "assetadmin";
    private static final String ADMIN_PW = "asset-admin-pw-1234";

    /** 업로드 상한을 작게 잡아 **경계가 실제로 도는지** 본다(2MB 파일을 만들지 않는다). */
    private static final int MAX_BYTES = 4096;

    private static Path assetDir;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) throws Exception {
        TestDbSupport.registerTempDb(registry);
        assetDir = Files.createTempDirectory("hmb-notice-assets");
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
        registry.add("hmb.notice.asset.dir", () -> assetDir.toString());
        registry.add("hmb.notice.asset.max-bytes", () -> MAX_BYTES);
    }

    @Resource
    private JdbcClient jdbcClient;

    @BeforeEach
    void reset() {
        jdbcClient.sql("DELETE FROM notice_assets").update();
        jdbcClient.sql("DELETE FROM notices").update();
        jdbcClient.sql("DELETE FROM admin_ops_audit").update();
    }

    // ── 본 경로 ────────────────────────────────────────────────────────────

    /**
     * 올린 바이트가 <b>그대로</b> 공개 경로에서 나온다. 응답의 {@code url} 은 <b>상대경로</b>여야
     * 한다 — 절대 URL 을 돌려주면 운영자가 그걸 본문에 붙여넣고, 터널 주소가 바뀌는 순간
     * 과거 공지 이미지가 전부 깨진다(설계 D4).
     */
    @Test
    void uploadedBytesComeBackVerbatimFromThePublicPath() {
        String admin = adminToken();
        byte[] png = pngBytes(64);

        Map<String, Object> asset = upload(admin, png, "hero.png", MediaType.IMAGE_PNG);
        String id = (String) asset.get("id");
        assertThat(id).isNotBlank();
        assertThat((String) asset.get("url"))
                .as("본문에 붙일 값은 상대경로다(절대 URL 이면 터널 주소 변경에 과거 공지가 깨진다)")
                .isEqualTo("/api/notices/assets/" + id);
        assertThat(asset.get("contentType")).isEqualTo("image/png");
        assertThat(asset.get("originalName")).isEqualTo("hero.png");
        assertThat(((Number) asset.get("byteSize")).intValue()).isEqualTo(png.length);

        ResponseEntity<byte[]> served = rest.getForEntity(baseUrl("/api/notices/assets/" + id), byte[].class);
        assertThat(served.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(served.getBody()).as("올린 바이트 그대로").isEqualTo(png);
        assertThat(served.getHeaders().getContentType()).isEqualTo(MediaType.IMAGE_PNG);
        assertThat(served.getHeaders().getFirst("X-Content-Type-Options"))
                .as("브라우저가 바이트를 다른 타입으로 스니핑하지 못하게")
                .isEqualTo("nosniff");
    }

    /**
     * <b>공개다</b> — 토큰 없이 읽힌다. 공지 본문 자체가 공개이고(점검 공지는 로그인이 안 될 때
     * 가장 필요하다) 그 본문의 이미지에 401 을 두면 정확히 그 순간에 깨진다.
     * 되돌리면(= AuthInterceptor 제외를 빼면) 이 테스트가 먼저 깨진다.
     */
    @Test
    void assetsAreReachableWithoutAuth() {
        String id = (String) upload(adminToken(), pngBytes(32), "a.png", MediaType.IMAGE_PNG).get("id");

        ResponseEntity<byte[]> anonymous =
                rest.getForEntity(baseUrl("/api/notices/assets/" + id), byte[].class);

        assertThat(anonymous.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /** 저장 파일명은 <b>업로드 이름과 무관</b>하다(D7) — 사용자 입력이 경로에 도달하지 않는다. */
    @Test
    void storedFileNameIsDerivedFromTheIdNotTheUploadedName() throws Exception {
        String admin = adminToken();

        Map<String, Object> asset = upload(admin, pngBytes(16), "../../evil name.png", MediaType.IMAGE_PNG);

        String id = (String) asset.get("id");
        assertThat(Files.exists(assetDir.resolve(id + ".png"))).isTrue();
        // 보관소는 클래스 전체가 공유하므로 "이 파일만 있다"가 아니라 **업로드 이름이 어디에도
        // 나타나지 않는다**를 본다 — 그게 실제로 막으려는 것이다(경로 탈출·이름 유출).
        try (var entries = Files.list(assetDir)) {
            assertThat(entries.map(p -> p.getFileName().toString()))
                    .as("업로드 이름의 어떤 조각도 파일시스템에 나타나지 않는다")
                    .allSatisfy(name -> assertThat(name).matches("[0-9A-Z]+\\.(png|jpg|webp|gif)"));
        }
        // 상위 디렉토리로 새어 나간 것도 없다(`../../evil name.png` 가 그대로 해석됐다면 여기 생긴다).
        assertThat(Files.exists(assetDir.getParent().resolve("evil name.png"))).isFalse();
        assertThat(asset.get("originalName"))
                .as("원본 이름은 표시용으로 남는다(경로에 쓰지 않을 뿐)")
                .isEqualTo("../../evil name.png");
    }

    // ── 막아야 하는 것 ──────────────────────────────────────────────────────

    /**
     * <b>SVG 는 거부한다.</b> SVG 는 스크립트를 담을 수 있어 {@code <img>} 로도 XSS 표면이 된다 —
     * admin 계정 하나가 뚫렸을 때 전 유저 브라우저에 스크립트가 배포되는 경로다
     * (#248 본문 파서를 화이트리스트 AST 로 만든 것과 같은 축).
     */
    @Test
    void svgIsRejected() {
        String admin = adminToken();
        byte[] svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);

        ResponseEntity<Map> res = uploadRaw(admin, svg, "x.svg", MediaType.valueOf("image/svg+xml"));

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(uploadedCount()).as("거부는 부수효과가 0이어야 한다").isZero();
    }

    /**
     * <b>타입 판정은 매직바이트다</b> — 파일명 확장자도, 클라가 신고한 Content-Type 도
     * 공격자가 정하는 값이다. 스크립트를 {@code .png} 로 이름만 바꿔 올려도 막혀야 한다.
     *
     * <p>이 테스트가 없으면 "확장자만 보는" 구현이 통과한다(변이체 킬).
     */
    @Test
    void aScriptRenamedToPngIsRejectedBecauseTypeIsDecidedByMagicBytes() {
        String admin = adminToken();
        byte[] notAnImage = "<html><script>alert(1)</script></html>"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);

        ResponseEntity<Map> res = uploadRaw(admin, notAnImage, "innocent.png", MediaType.IMAGE_PNG);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(uploadedCount()).isZero();
    }

    /** 상한 초과는 거부된다(볼륨 보호). */
    @Test
    void oversizeUploadIsRejected() {
        String admin = adminToken();

        ResponseEntity<Map> res =
                uploadRaw(admin, pngBytes(MAX_BYTES + 1), "big.png", MediaType.IMAGE_PNG);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(uploadedCount()).isZero();
    }

    /**
     * 서빙 id 는 FS 에 닿기 <b>전에</b> 걸러진다 — 경로 탈출 시도가 파일시스템 접근으로
     * 번역되지 않는다(심층방어: D7 이 이미 막지만 두 층 다 둔다).
     */
    @Test
    void servingRejectsIdsThatAreNotPlainIdentifiers() {
        for (String bad : new String[] {"..", "a/b", "a.png", "%2e%2e"}) {
            ResponseEntity<byte[]> res =
                    rest.getForEntity(baseUrl("/api/notices/assets/" + bad), byte[].class);
            assertThat(res.getStatusCode().is2xxSuccessful())
                    .as("경로 조작 id: " + bad)
                    .isFalse();
        }
    }

    /** 업로드는 admin 게이트 뒤다 — 일반 유저는 403 이고 부수효과가 0이다. */
    @Test
    void uploadIsBehindTheAdminGate() {
        String user = login("asset_plain");

        ResponseEntity<Map> res = uploadRaw(user, pngBytes(16), "a.png", MediaType.IMAGE_PNG);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(uploadedCount()).isZero();
    }

    // ── 노출 스위치 (hero 확정: 삭제가 아니라 비활성화) ────────────────────

    /**
     * <b>삭제가 아니라 노출 스위치다</b>(hero 확정 2026-07-30). 자산을 내리는 행위는 되돌릴 수
     * 있어야 한다 — 삭제는 오조작이 곧 영구 소실이고 참조하던 공지의 그림을 되살릴 방법이 없다.
     * 끄면 404, 켜면 <b>같은 바이트가 그대로</b> 돌아온다.
     */
    @Test
    void switchingAssetOffHidesItAndSwitchingItBackOnRestoresTheSameBytes() {
        String admin = adminToken();
        byte[] png = pngBytes(48);
        String id = (String) upload(admin, png, "a.png", MediaType.IMAGE_PNG).get("id");

        authPost("/api/admin/notices/assets/" + id + "/active", admin,
                Map.of("active", false, "reason", "잘못 올림"), Map.class);
        assertThat(rest.getForEntity(baseUrl("/api/notices/assets/" + id), byte[].class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        authPost("/api/admin/notices/assets/" + id + "/active", admin,
                Map.of("active", true, "reason", "복구"), Map.class);
        ResponseEntity<byte[]> back = rest.getForEntity(baseUrl("/api/notices/assets/" + id), byte[].class);
        assertThat(back.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(back.getBody()).as("되돌릴 수 있다 = 바이트가 그대로 있다").isEqualTo(png);
    }

    /**
     * 삭제 엔드포인트는 <b>존재하지 않는다</b>(D9). 생기면 되돌릴 수 없는 문이 다시 열린다.
     *
     * <p>상태코드를 고정하지 않는 이유: 미매핑 admin 경로는 이 서버에서 <b>선재적으로 500</b> 이다
     * ({@code AdminErrorHandler} 주석 — {@code NoResourceFoundException→500}, PRD-v4 §H 오픈
     * 체크리스트 소관). 그 값을 여기 박으면 그 선재 이슈를 고치는 날 <b>무관한 테스트가 깨진다</b>.
     * 이 계약이 지키려는 것은 <b>"삭제되지 않는다"</b> 뿐이다.
     */
    @Test
    void thereIsNoDeleteEndpoint() {
        String admin = adminToken();
        String id = (String) upload(admin, pngBytes(16), "a.png", MediaType.IMAGE_PNG).get("id");

        ResponseEntity<Map> res = authDelete("/api/admin/notices/assets/" + id, admin, Map.class);

        assertThat(res.getStatusCode().is2xxSuccessful()).as("삭제가 성공해서는 안 된다").isFalse();
        assertThat(rest.getForEntity(baseUrl("/api/notices/assets/" + id), byte[].class).getStatusCode())
                .as("자산은 그대로 살아 있다")
                .isEqualTo(HttpStatus.OK);
        assertThat(uploadedCount()).isEqualTo(1);
    }

    // ── 목록·원장 ──────────────────────────────────────────────────────────

    /**
     * 목록은 <b>이 이미지를 쓰는 공지 수</b>를 함께 준다 — 운영자가 끄기 전에 무슨 일이
     * 벌어지는지 알아야 한다. 세는 대상은 <b>삭제되지 않은 공지</b>다.
     */
    @Test
    void listReportsHowManyLiveNoticesUseEachAsset() {
        String admin = adminToken();
        String id = (String) upload(admin, pngBytes(16), "a.png", MediaType.IMAGE_PNG).get("id");
        String other = (String) upload(admin, pngBytes(24), "b.png", MediaType.IMAGE_PNG).get("id");

        authPost("/api/admin/notices", admin, Map.of(
                "title", "쓰는 공지", "body", "![](/api/notices/assets/" + id + ")", "reason", "t"), Map.class);
        ResponseEntity<Map> doomed = authPost("/api/admin/notices", admin, Map.of(
                "title", "지울 공지", "body", "![](/api/notices/assets/" + id + ")", "reason", "t"), Map.class);
        authDelete("/api/admin/notices/" + doomed.getBody().get("id") + "?reason=t", admin, Map.class);

        @SuppressWarnings("unchecked")
        var assets = (java.util.List<Map<String, Object>>)
                authGet("/api/admin/notices/assets", admin, Map.class).getBody().get("assets");

        assertThat(usedBy(assets, id)).as("삭제된 공지는 세지 않는다").isEqualTo(1);
        assertThat(usedBy(assets, other)).isZero();
    }

    /** 업로드·노출변경은 원장에 남는다 — 공지 이력 조회에 그대로 섞여 나온다(운영자에겐 한 흐름). */
    @Test
    void uploadAndSwitchAreRecordedInTheNoticeAuditLog() {
        String admin = adminToken();
        String id = (String) upload(admin, pngBytes(16), "a.png", MediaType.IMAGE_PNG).get("id");
        authPost("/api/admin/notices/assets/" + id + "/active", admin,
                Map.of("active", false, "reason", "내림"), Map.class);

        @SuppressWarnings("unchecked")
        java.util.List<Map<String, Object>> history =
                authGet("/api/admin/notices/history", admin, java.util.List.class).getBody();

        assertThat(history).extracting(e -> (String) e.get("action"))
                .contains("notice_asset_upload", "notice_asset_active");
    }

    // ── 헬퍼 ───────────────────────────────────────────────────────────────

    private static int usedBy(java.util.List<Map<String, Object>> assets, String id) {
        return assets.stream()
                .filter(a -> id.equals(a.get("id")))
                .map(a -> ((Number) a.get("usedBy")).intValue())
                .findFirst()
                .orElseThrow(() -> new AssertionError("목록에 없다: " + id));
    }

    private int uploadedCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM notice_assets").query(Integer.class).single();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> upload(String token, byte[] bytes, String name, MediaType type) {
        ResponseEntity<Map> res = uploadRaw(token, bytes, name, type);
        assertThat(res.getStatusCode()).as("업로드 실패: " + res.getBody()).isEqualTo(HttpStatus.CREATED);
        return res.getBody();
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> uploadRaw(String token, byte[] bytes, String name, MediaType type) {
        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        HttpHeaders partHeaders = new HttpHeaders();
        partHeaders.setContentType(type);
        partHeaders.setContentDispositionFormData("file", name);
        form.add("file", new HttpEntity<>(new ByteArrayResource(bytes), partHeaders));

        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + token);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        return rest.exchange(baseUrl("/api/admin/notices/assets"), HttpMethod.POST,
                new HttpEntity<>(form, headers), Map.class);
    }

    /** 진짜 PNG 시그니처 + 패딩. 매직바이트 판정을 통과하는 최소 바이트열. */
    private static byte[] pngBytes(int total) {
        byte[] out = new byte[Math.max(total, 8)];
        byte[] sig = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
        System.arraycopy(sig, 0, out, 0, sig.length);
        for (int i = sig.length; i < out.length; i++) {
            out[i] = (byte) (i % 251);
        }
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
