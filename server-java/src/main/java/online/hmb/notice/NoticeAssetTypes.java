package online.hmb.notice;

import java.util.List;

/**
 * 공지 이미지의 <b>타입 판정</b> (#309 W1).
 *
 * <p><b>파일명 확장자도, 클라가 신고한 {@code Content-Type} 도 보지 않는다</b> — 둘 다 업로드하는
 * 쪽이 정하는 값이라 "스크립트를 {@code .png} 로 이름만 바꾼 파일"을 통과시킨다. 판정은 오직
 * <b>바이트 앞머리(매직바이트)</b>로 한다. 그래서 저장되는 {@code content_type} 은 서버가 확정한
 * 값이고, 서빙도 그 값으로만 나간다.
 *
 * <p><b>SVG 는 화이트리스트에 없다.</b> SVG 는 스크립트를 담을 수 있어 {@code <img>} 로도 XSS
 * 표면이 된다 — admin 계정 하나가 뚫렸을 때 전 유저 브라우저에 스크립트가 배포되는 경로다
 * ({@code notice-markup.ts} 가 본문을 화이트리스트 AST 로만 그리는 것과 같은 축).
 *
 * <p><b>정직한 한계</b>: 매직바이트는 "진짜 이미지인가"의 완전한 증명이 아니다(polyglot 파일은
 * 두 포맷의 시그니처를 동시에 만족시킬 수 있다). 방어가 성립하는 것은 <b>조합</b> 때문이다 —
 * 서빙이 여기서 확정한 고정 {@code Content-Type} + {@code nosniff} 로만 나가고 HTML/SVG 를
 * 절대 내보내지 않으므로, 그 바이트가 브라우저에서 스크립트로 해석될 경로가 없다.
 */
public final class NoticeAssetTypes {

    /** 허용 포맷 1종 = (확정 content-type, 저장 확장자, 시그니처). */
    public record ImageType(String contentType, String extension) {
    }

    private record Signature(ImageType type, int[] prefix, int[] tailOffsetsAscii, String tailAscii) {
    }

    private static final List<Signature> SIGNATURES = List.of(
            // PNG: 89 50 4E 47 0D 0A 1A 0A
            new Signature(new ImageType("image/png", "png"),
                    new int[] {0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}, null, null),
            // JPEG: FF D8 FF
            new Signature(new ImageType("image/jpeg", "jpg"),
                    new int[] {0xFF, 0xD8, 0xFF}, null, null),
            // GIF: "GIF8" (87a/89a 둘 다 이 앞머리를 공유한다)
            new Signature(new ImageType("image/gif", "gif"),
                    new int[] {'G', 'I', 'F', '8'}, null, null),
            // WebP: "RIFF" + 4바이트 길이 + "WEBP" — 앞머리만으로는 부족하다(RIFF 는 wav/avi 도 쓴다).
            new Signature(new ImageType("image/webp", "webp"),
                    new int[] {'R', 'I', 'F', 'F'}, new int[] {8, 9, 10, 11}, "WEBP"));

    /** 화이트리스트를 운영자에게 보여줄 때 쓰는 표기(에러 문구·admin UI accept). */
    public static final String ALLOWED_LABEL = "PNG · JPEG · WebP · GIF";

    private NoticeAssetTypes() {
    }

    /**
     * 바이트에서 타입을 확정한다. 화이트리스트에 없으면 {@code null} —
     * 호출부가 400 으로 거절한다(부수효과 0).
     */
    public static ImageType detect(byte[] bytes) {
        if (bytes == null) {
            return null;
        }
        for (Signature sig : SIGNATURES) {
            if (matches(bytes, sig)) {
                return sig.type();
            }
        }
        return null;
    }

    private static boolean matches(byte[] bytes, Signature sig) {
        if (bytes.length < sig.prefix().length) {
            return false;
        }
        for (int i = 0; i < sig.prefix().length; i++) {
            if ((bytes[i] & 0xFF) != sig.prefix()[i]) {
                return false;
            }
        }
        if (sig.tailAscii() == null) {
            return true;
        }
        int[] offsets = sig.tailOffsetsAscii();
        if (bytes.length <= offsets[offsets.length - 1]) {
            return false;
        }
        for (int i = 0; i < offsets.length; i++) {
            if ((bytes[offsets[i]] & 0xFF) != sig.tailAscii().charAt(i)) {
                return false;
            }
        }
        return true;
    }
}
