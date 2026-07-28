package online.hmb.common;

/**
 * 한국어 조사 선택 (#232) — 재화 이름이 <b>데이터가 되면서</b> 필요해졌다.
 *
 * <p>전에는 문구가 통째로 상수였다("젬이 부족합니다"). 이제 이름이 config 에서 오므로
 * ("다이아", "골드", 나중에 뭐가 될지 모름) 조사를 이름에 맞춰 골라야 한다 — 안 그러면
 * "다이아이 부족합니다" 가 나간다. 규칙은 받침 유무 하나뿐이라 로직도 하나뿐이다.
 *
 * <p>한글이 아닌 이름(코드 폴백 "GEM" 등)은 <b>받침 있음</b>으로 본다 — "GEM이 부족합니다" 는
 * 어색해도 읽히지만 "GEM가" 는 틀린 말이다.
 */
public final class Josa {

    private Josa() {
    }

    /** 이/가 — {@code 이가("골드")} → {@code "골드가"}, {@code 이가("젬")} → {@code "젬이"}. */
    public static String iga(String word) {
        return word + (hasFinalConsonant(word) ? "이" : "가");
    }

    /** 을/를 — {@code eulreul("골드")} → {@code "골드를"}. */
    public static String eulreul(String word) {
        return word + (hasFinalConsonant(word) ? "을" : "를");
    }

    /** 은/는 — {@code eunneun("골드")} → {@code "골드는"}, {@code eunneun("젬")} → {@code "젬은"}. */
    public static String eunneun(String word) {
        return word + (hasFinalConsonant(word) ? "은" : "는");
    }

    /**
     * 마지막 글자에 받침이 있는가. 한글 음절 블록은 {@code 0xAC00 + (초성*21 + 중성)*28 + 종성} 이라
     * 종성 인덱스({@code (code - 0xAC00) % 28})가 0 이 아니면 받침이 있다.
     */
    private static boolean hasFinalConsonant(String word) {
        if (word == null || word.isEmpty()) {
            return true;
        }
        char last = word.charAt(word.length() - 1);
        if (last < 0xAC00 || last > 0xD7A3) {
            return true; // 한글 음절이 아니면 판정 불가 — 틀린 말이 안 나오는 쪽으로.
        }
        return (last - 0xAC00) % 28 != 0;
    }
}
