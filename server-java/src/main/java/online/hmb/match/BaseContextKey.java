package online.hmb.match;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import online.hmb.common.Hashes;

/**
 * A(베이스 생성) 크로스매치 캐시 <b>키 규약</b>의 Java 재현.
 *
 * <p>키 재료(정규 JSON)는 shared {@code packages/shared/src/tactical-patch.ts} 의
 * {@code baseContextKeyMaterial} 이 SoT다. 여기서는 그 규약을 <b>바이트 동일</b>하게 재현한다
 * (같은 덱 → 같은 material → 같은 A-key → 크로스매치·양팀 재사용). 불일치는 캐시 미스(치명적 아님)이나
 * 목적(재사용) 상실이므로 {@code BaseContextKeyReproTest} 가 TS 산출 픽스처와 대조한다.
 *
 * <p>규약: matchId/side/half/seed <b>제외</b>. roster 는 slotIndex 오름차순 정규화. 상위 키/중첩 키는
 * 전부 알파벳 정렬(= {@link Hashes#canonicalJson} 의 ORDER_MAP_ENTRIES_BY_KEYS). 규약 버전 {@code v:1}.
 *
 * <p>주의(number 직렬화): attributes 는 정수, manualTactics 는 0..1 소수 — Jackson/JS 모두 동일 표기.
 * 단 {@code 1.0} 같이 소수부가 0인 double 은 JS가 "1"로, Jackson이 "1.0"으로 직렬화해 어긋날 수 있다
 * (실사용값은 정수 attributes·0&lt;x&lt;1 전술이라 발생 안 함 — 캐시 미스일 뿐 정합성 문제 아님).
 */
public final class BaseContextKey {

    private BaseContextKey() {
    }

    /** 키 재료 1인분(선발). attributes 는 원본 능력치(컨디션 미적용 — 덱 스냅샷 기준). */
    public record RosterKey(String playerId, int slotIndex, Map<String, Object> attributes) {
    }

    /**
     * A-key 재료(정규 JSON 문자열). TS {@code baseContextKeyMaterial} 과 바이트 동일해야 한다.
     *
     * @param manualTactics 수동 팀 전술(없으면 {@code null} — 규약상 {@code null} 직렬화).
     */
    public static String material(String formation,
                                  List<RosterKey> roster,
                                  String teamPrompt,
                                  Map<String, String> playerPrompts,
                                  Map<String, Object> manualTactics) {
        List<RosterKey> sorted = new ArrayList<>(roster);
        sorted.sort(Comparator.comparingInt(RosterKey::slotIndex));
        List<Map<String, Object>> rosterList = new ArrayList<>(sorted.size());
        for (RosterKey r : sorted) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("playerId", r.playerId());
            entry.put("slotIndex", r.slotIndex());
            entry.put("attributes", r.attributes());
            rosterList.add(entry);
        }
        Map<String, Object> root = new LinkedHashMap<>();
        // 규약 버전 — A 성향 결정 로직 변경 시 올려 캐시 무효화. **TS baseContextKeyMaterial 과 동시에**
        // 올려야 한다(한쪽만 올리면 전 매치 캐시 미스). 두 값은 크로스언어 앵커 테스트가 묶는다.
        // v2 (#324): 프롬프트가 슬롯 기준 좌표를 전달하고 겹침을 금지하도록 계약이 바뀌었다 —
        //            그 이전 A 산출(라이브 78개 중 9개가 겹친 배치)을 재사용하면 고쳐도 안 바뀐다.
        root.put("v", 2);
        root.put("formation", formation);
        root.put("roster", rosterList);
        root.put("teamPrompt", teamPrompt);
        root.put("playerPrompts", new TreeMap<>(playerPrompts));
        root.put("manualTactics", manualTactics); // null 허용 — canonicalJson 이 "null" 로 직렬화.
        return Hashes.canonicalJson(root);
    }

    /** A-잡 id(= 캐시 키): {@code sha256(material)[:32]}. */
    public static String baseId(String material) {
        return Hashes.sha256Hex(material).substring(0, 32);
    }
}
