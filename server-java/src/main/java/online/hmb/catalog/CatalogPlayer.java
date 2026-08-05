package online.hmb.catalog;

import java.util.Map;

/**
 * openapi CatalogPlayer 스키마 — 카탈로그 선수 + 보유 정보.
 * GET /api/players 응답 원소이자 뽑기 결과(GachaResultItem.player)에도 재사용된다.
 *
 * <p>{@code active} (#207 U-D7) = 카탈로그 차원의 운영 플래그({@code players.active}). 비활성 유닛도
 * <b>보유분이면 목록에 계속 내려가므로</b>(카드를 뺏지 않는다 — CatalogController javadoc 참조) 이 필드가
 * 없으면 클라는 "도감엔 있는데 아무리 뽑아도 안 나온다 = 버그인가?"를 구분할 수 없다. 도감이 "off"로
 * 표기하기 위한 관측 수단이며, <b>필터링에는 관여하지 않는다</b>(노출만).
 *
 * <p>{@code shortName} (#411 additive) = 밀집 UI 용 짧은 표시명({@code players.short_name}, V41).
 * <b>{@code null} 이 정상값</b>이다 — 구 발행물(v2.5 이하)엔 그 필드가 없고 어드민이 잠근 행은 시드
 * 갱신을 안 받는다. 소비 쪽 계약은 "없으면 풀네임으로 폴백"이고(web {@code player-stats-view.ts}),
 * 그래서 서버가 여기서 대신 {@code name} 을 채우지 <b>않는다</b>: 채우면 클라가 "짧은 이름이 실제로
 * 있는가"를 구분할 수 없고, 폴백 규칙이 서버·클라 두 벌이 된다.
 *
 * <p>⚠️ {@code openapi.yaml} 의 {@code CatalogPlayer} 스키마에는 아직 이 필드가 없다({@code docs/**}
 * 는 이 모듈의 owned-glob 밖) — {@code active} 와 같은 additive·비필수로 편입 요청이 필요하다.
 */
public record CatalogPlayer(String id, String name, String shortName, String position, String grade,
                            Map<String, Object> attributes, boolean owned, int ownedCount,
                            boolean active) {
}
