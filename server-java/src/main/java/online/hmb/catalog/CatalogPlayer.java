package online.hmb.catalog;

import java.util.Map;

/**
 * openapi CatalogPlayer 스키마 — 카탈로그 선수 + 보유 정보.
 * GET /api/players 응답 원소이자 뽑기 결과(GachaResultItem.player)에도 재사용된다.
 */
public record CatalogPlayer(String id, String name, String position, String grade,
                            Map<String, Object> attributes, boolean owned, int ownedCount) {
}
