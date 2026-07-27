package online.hmb.match;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 팀 지시 <b>대변경 감지</b> — 새 지시가 건드리는 <b>전술 축의 개수</b> (#193 라운드2 라우팅).
 *
 * <h2>왜 "축 개수"인가 (직전 자카드 지표 폐기 사유)</h2>
 * 처음 지표는 old→new 어휘 자카드였다. 그런데 <b>실제 h1 경로에서 old 는 항상 빈 문자열</b>이다 —
 * 덱(A 베이스)에는 팀 지시가 없고, 매치 시점에 처음 입력되기 때문이다. 자카드는 한쪽이 비면 0 이므로
 * <b>팀 지시가 있는 모든 킥오프가 풀생성</b>으로 갔다. 이는 라운드2 맞대결과 정면으로 충돌한다:
 * <ul>
 *   <li>K2 소변경(old="") — 델타 <b>4.63</b> vs 풀생성 3.25 → 델타 승</li>
 *   <li>돌발 3종(C1·C2·C3, 전부 old="") — 델타 3.83~5.00 PASS</li>
 *   <li>풀생성이 이긴 것은 <b>K1(다축 대변경)</b> 하나 — 델타 3.13 vs 풀 4.75</li>
 * </ul>
 * 즉 오라우팅의 대가는 지연만이 아니라 <b>품질 하락</b>이다(소변경을 풀생성으로 보내면 4.63 → 3.25).
 * K1 만 가르는 신호는 "얼마나 다른 낱말인가"가 아니라 <b>"몇 개의 전술 축을 동시에 건드리는가"</b>였다:
 * K1 = 압박 + 라인 + 오버랩(3축), K2 = 템포(1축), C1 = 0축, C3 = 마킹(1축).
 *
 * <h2>지표</h2>
 * 새 팀 지시 문자열에 등장하는 <b>서로 다른 축 그룹의 수</b>. 축 그룹 = 지시 카탈로그
 * ({@code packages/server/src/prompt/directives/})의 축 + 그 동의어 몇 개. 한국어는 조사·어미가 붙으므로
 * ("압박을", "라인은") 토큰 일치가 아니라 <b>부분 일치(정규식)</b>로 센다. 같은 그룹이 여러 번 나와도 1로
 * 센다(<b>반복 강조가 아니라 범위</b>를 재는 지표다).
 *
 * <p>결정론(루트 §2-5): 형태소 분석기·임베딩·외부 사전 의존 0 — 같은 입력이면 언제나 같은 판정.
 * 튜닝은 코드가 아니라 임계 config({@code hmb.match.delta.overhaul-axis-count}).
 *
 * <h2>한계(수용)</h2>
 * ①카탈로그에 없는 어휘로 쓴 지시는 축이 안 잡힌다(→ 델타 유지 = 라운드2 기준 안전한 쪽).
 * ②old 를 보지 않으므로, 하프타임에 <b>기존 다축 지시를 통째로 다시 타이핑</b>하면서 한 군데만 고치면
 * 대변경으로 잡힌다. 실제 UI 는 하프타임 팀 프롬프트 textarea 가 <b>빈 칸에서 시작</b>하고
 * ({@code apps/web/src/match/HalftimePanel.tsx} — 이전 지시 프리필 없음) 변경 없는 재입력은 델타 자체가
 * null 이라 라우팅 대상이 아니므로, 이 경우는 사실상 발생하지 않는다. 발생 근거가 측정되면 그때
 * 보조 신호(어휘 유지율)를 임계와 함께 도입한다 — 근거 없는 임계는 넣지 않는다(§2-4).
 */
public final class OverhaulDetector {

    /**
     * 전술 축 그룹 → 그 축을 가리키는 <b>정규식 조각</b>들(소문자 기준, 부분 일치).
     *
     * <p>축 구성은 지시 카탈로그({@code packages/server/src/prompt/directives/}: press-trigger ·
     * tempo-control(템포·라인) · overlap · forward-run(침투) · long-ball(패스/빌드업) · marking)를 기준으로,
     * 감독이 실제로 쓰는 나머지 축(폭·트랩·콤팩트·드리블·슛)을 더한 것이다. <b>카탈로그가 늘면 여기도
     * 같이 늘린다</b>(축이 없으면 그 지시는 라우팅에서 안 보인다).
     *
     * <p>키워드 선정 규칙: <b>2글자 이상 + 전술 문맥에서만 등장</b>하는 표현만 넣는다. 한 글자("폭","런")는
     * 무관한 낱말("폭발","그런")에 걸려 축을 헛세므로 넣지 않는다.
     *
     * <p><b>왜 대부분 리터럴인데 정규식인가</b>(#193 최종검증 M-1). 두 글자짜리도 <b>더 긴 무관한 낱말
     * 안에</b> 그대로 들어 있으면 축을 헛센다 — 실제로 "온라인/가이드라인/사이드라인/라인업"이 line 축을,
     * "대인관계"가 marking 축을, "오프사이드/사이드라인"이 width 축을 켰다. 축을 하나 헛세면 임계 3 에서
     * 소변경이 대변경으로 뒤집히고, 라운드2 기준 그건 지연뿐 아니라 <b>품질 손실</b>(델타 4.63 → 풀 3.25)
     * 이다. 그래서 오탐이 실측된 세 축만 <b>전술 문맥 결합형</b>으로 좁혔고, 나머지는 리터럴 그대로다
     * (리터럴은 그 자체로 유효한 정규식이라 표기가 갈리지 않는다).
     */
    static final Map<String, List<String>> AXIS_KEYWORDS = axisKeywords();

    /**
     * "라인"이 <b>전술 축(수비 라인)</b>일 때만 켠다 — 두 갈래.
     * <ol>
     *   <li>축 전용 합성어(수비라인·하이라인·백라인 …) — 그 자체로 전술어라 문맥이 필요 없다.</li>
     *   <li>맨 "라인" + <b>라인 높이 동사</b>(올리/내리/높이/낮추 …)가 <b>6글자 이내</b>에 뒤따를 때.
     *       "라인 최대로 올리고"·"라인을 내려라" 같은 실제 지시 어순을 덮는다. 동사를 라인 높이로만
     *       한정한 이유: "유지/대로" 같은 범용어까지 넣으면 "가이드라인 대로 유지"가 다시 걸린다.
     *       못 잡은 표현("라인 신경 써")은 축이 안 잡혀 <b>델타 유지</b> = 라운드2 기준 안전한 쪽이다.</li>
     * </ol>
     * 두 갈래 모두에 앞서, 비전술 합성어(온라인·가이드라인·사이드라인 …)와 "라인업"은
     * lookbehind/lookahead 로 <b>뒤에 무엇이 오든</b> 차단한다.
     */
    private static final String LINE_COMPOUNDS = "수비라인|하이라인|로우라인|백라인|최종라인|포백라인";
    private static final String LINE_NOT_TACTICAL = "온|오프|가이드|사이드|터치|골|엔드|데드|타임|파이프|스카이|헤어|베이스|아웃|스타팅";
    private static final String LINE_HEIGHT_VERBS = "올려|올리|올린|높여|높이|내려|내리|내린|낮춰|낮추|끌어|당겨|세워|전진|후퇴";
    private static final String LINE_IN_CONTEXT =
            "(?<!" + LINE_NOT_TACTICAL + ")라인(?!업)[^.!?\\n]{0,6}?(" + LINE_HEIGHT_VERBS + ")";

    private static Map<String, List<String>> axisKeywords() {
        Map<String, List<String>> m = new LinkedHashMap<>();
        m.put("press", List.of("압박", "프레스", "프레싱"));                       // 전방압박·하이프레스·압박 자제
        m.put("line", List.of(LINE_COMPOUNDS, LINE_IN_CONTEXT));                   // 하이라인·"라인 내려" (≠ 온라인)
        m.put("tempo", List.of("템포", "점유", "포제션"));                          // 템포 조절·점유 운영
        // "사이드"는 "오프사이드"(트랩 축)·"사이드라인"(비전술) 안에 들어 있다 → 그 둘만 배제.
        m.put("width", List.of("측면", "와이드", "(?<!오프)사이드(?!라인)", "윙",
                "좁게", "좁혀", "넓게", "넓혀", "벌려", "벌리"));
        m.put("overlap", List.of("오버랩", "언더랩"));                              // 풀백 전진 가담
        m.put("trap", List.of("오프사이드", "트랩"));
        m.put("compact", List.of("콤팩트", "컴팩트", "밀집", "블록", "뭉쳐"));       // 로우블록·간격 압축
        // "대인"은 "대인관계"에도 들어 있다 → 마킹 결합형만("대인마크"는 "마크"가 이미 잡는다).
        m.put("marking", List.of("마크", "마킹", "막아", "전담", "대인방어"));
        m.put("run", List.of("침투", "뒷공간", "쇄도", "오프더볼"));
        m.put("pass", List.of("패스", "빌드업", "롱볼", "다이렉트", "전개", "크로스"));
        m.put("dribble", List.of("드리블", "돌파", "개인기"));
        m.put("shoot", List.of("슛", "슈팅", "마무리", "득점"));
        return Collections.unmodifiableMap(m); // 순서 고정(LinkedHashMap) — 로그·테스트가 재현 가능하게
    }

    /** 축별로 조각을 한 패턴으로 합쳐 <b>한 번만</b> 컴파일한다(매 판정마다 컴파일하지 않게). */
    static final Map<String, Pattern> AXIS_PATTERNS = compile(AXIS_KEYWORDS);

    static Map<String, Pattern> compile(Map<String, List<String>> catalog) {
        Map<String, Pattern> m = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> group : catalog.entrySet()) {
            m.put(group.getKey(), Pattern.compile(String.join("|", group.getValue())));
        }
        return Collections.unmodifiableMap(m);
    }

    private OverhaulDetector() {
    }

    /**
     * 텍스트가 언급하는 축 그룹 id 집합(카탈로그 등장 순서 유지, 중복 없음).
     * null·공백은 빈 집합. 로그·테스트가 "무엇 때문에 대변경인지" 읽을 수 있게 개수가 아니라 집합을 준다.
     */
    public static Set<String> axes(String text) {
        return axes(text, AXIS_PATTERNS);
    }

    /** 축 카탈로그를 주입하는 형태(테스트·향후 config 오버라이드용). */
    static Set<String> axes(String text, Map<String, Pattern> catalog) {
        Set<String> hit = new LinkedHashSet<>();
        if (text == null || text.isBlank()) {
            return hit;
        }
        String haystack = text.toLowerCase(Locale.ROOT);
        for (Map.Entry<String, Pattern> group : catalog.entrySet()) {
            if (group.getValue().matcher(haystack).find()) {
                hit.add(group.getKey()); // 같은 축은 몇 번 나오든 1
            }
        }
        return hit;
    }

    /** {@link #axes(String)} 의 크기 = 이 지시가 건드리는 전술 축의 폭. */
    public static int axisCount(String text) {
        return axes(text).size();
    }

    /**
     * 대변경 판정 — 새 지시가 <b>{@code minAxisCount} 개 이상</b>의 축을 건드리면 대변경(경계 포함).
     *
     * <p>단조롭게 읽힌다: 값이 클수록 엄격하다. {@code 0} 이면 팀 지시 변경 전부가 대변경(= 항상 풀생성,
     * A/B 계측용), 축 개수보다 큰 값(예: 99)을 주면 아무것도 안 걸린다(= 라우팅만 끄기).
     */
    public static boolean isOverhaul(String newText, int minAxisCount) {
        return axisCount(newText) >= minAxisCount;
    }
}
