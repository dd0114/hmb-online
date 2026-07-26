package online.hmb.match;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

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
 * ("압박을", "라인은") 토큰 일치가 아니라 <b>부분 문자열 포함</b>으로 센다. 같은 그룹이 여러 번 나와도 1로
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
     * 전술 축 그룹 → 그 축을 가리키는 표현들(부분 문자열, 소문자 기준).
     *
     * <p>축 구성은 지시 카탈로그({@code packages/server/src/prompt/directives/}: press-trigger ·
     * tempo-control(템포·라인) · overlap · forward-run(침투) · long-ball(패스/빌드업) · marking)를 기준으로,
     * 감독이 실제로 쓰는 나머지 축(폭·트랩·콤팩트·드리블·슛)을 더한 것이다. <b>카탈로그가 늘면 여기도
     * 같이 늘린다</b>(축이 없으면 그 지시는 라우팅에서 안 보인다).
     *
     * <p>키워드 선정 규칙: <b>2글자 이상 + 전술 문맥에서만 등장</b>하는 표현만 넣는다. 한 글자("폭","런")는
     * 무관한 낱말("폭발","그런")에 걸려 축을 헛세므로 넣지 않는다.
     */
    static final Map<String, List<String>> AXIS_KEYWORDS = axisKeywords();

    private static Map<String, List<String>> axisKeywords() {
        Map<String, List<String>> m = new LinkedHashMap<>();
        m.put("press", List.of("압박", "프레스", "프레싱"));                       // 전방압박·하이프레스·압박 자제
        m.put("line", List.of("라인"));                                            // 하이라인·수비라인·라인 내려
        m.put("tempo", List.of("템포", "점유", "포제션"));                          // 템포 조절·점유 운영
        m.put("width", List.of("측면", "와이드", "사이드", "윙", "좁게", "좁혀", "넓게", "넓혀", "벌려", "벌리"));
        m.put("overlap", List.of("오버랩", "언더랩"));                              // 풀백 전진 가담
        m.put("trap", List.of("오프사이드", "트랩"));
        m.put("compact", List.of("콤팩트", "컴팩트", "밀집", "블록", "뭉쳐"));       // 로우블록·간격 압축
        m.put("marking", List.of("마크", "마킹", "막아", "전담", "대인"));
        m.put("run", List.of("침투", "뒷공간", "쇄도", "오프더볼"));
        m.put("pass", List.of("패스", "빌드업", "롱볼", "다이렉트", "전개", "크로스"));
        m.put("dribble", List.of("드리블", "돌파", "개인기"));
        m.put("shoot", List.of("슛", "슈팅", "마무리", "득점"));
        return Collections.unmodifiableMap(m); // 순서 고정(LinkedHashMap) — 로그·테스트가 재현 가능하게
    }

    private OverhaulDetector() {
    }

    /**
     * 텍스트가 언급하는 축 그룹 id 집합(카탈로그 등장 순서 유지, 중복 없음).
     * null·공백은 빈 집합. 로그·테스트가 "무엇 때문에 대변경인지" 읽을 수 있게 개수가 아니라 집합을 준다.
     */
    public static Set<String> axes(String text) {
        return axes(text, AXIS_KEYWORDS);
    }

    /** 축 카탈로그를 주입하는 형태(테스트·향후 config 오버라이드용). */
    static Set<String> axes(String text, Map<String, List<String>> catalog) {
        Set<String> hit = new LinkedHashSet<>();
        if (text == null || text.isBlank()) {
            return hit;
        }
        String haystack = text.toLowerCase(Locale.ROOT);
        for (Map.Entry<String, List<String>> group : catalog.entrySet()) {
            for (String keyword : group.getValue()) {
                if (haystack.contains(keyword)) {
                    hit.add(group.getKey());
                    break; // 같은 축은 몇 번 나오든 1
                }
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
