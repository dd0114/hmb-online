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
 */
public record CatalogPlayer(String id, String name, String position, String grade,
                            Map<String, Object> attributes, boolean owned, int ownedCount,
                            boolean active) {
}
