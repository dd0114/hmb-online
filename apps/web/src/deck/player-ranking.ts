/**
 * 보유 선수 리스트 "추천 순위" 정렬 (이슈 #98 요구 5) — 순수/결정론 함수 (§2-5: RNG·Date 금지).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 추천정렬 규칙 (그대로 이슈에 인용 가능)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 리스트는 현재 포지션 필터에 대한 "추천 점수(recScore)" 내림차순으로 정렬한다:
 *   - 특정 포지션 필터(GK/DF/MF/FW):
 *        recScore = positionWeight(선수position, 필터position) × playerOverall(attributes)
 *     → 그 포지션에 대한 "적합도"가 높은 선수가 위로. positionWeight·playerOverall 은 Auto 배치
 *       근거(auto-lineup / team-power)를 그대로 재사용 — 리스트 추천과 Auto 배치가 같은 기준.
 *   - ALL 필터: recScore = playerOverall(attributes) (스탯 총량 대용 지표).
 *   - tie-break: 추천 점수 동점이면 playerId 사전순(오름차순). 결정론 — 입력 순서와 무관.
 *
 * (positionWeight 정의는 auto-lineup.ts 모듈 주석 참조: 정확 일치 1.0 · GK↔필드 교차 0.2 ·
 *  필드 포지션 rank 거리당 감점.)
 */
import type { Position } from "./deck-logic";
import { positionWeight } from "./auto-lineup";
import { playerOverall } from "./team-power";
import type { components } from "../api/schema";

type PlayerAttributes = components["schemas"]["PlayerAttributes"];

/** Minimal shape needed to rank (CatalogPlayer satisfies it). */
export interface RankablePlayer {
  id: string;
  position: Position;
  attributes: PlayerAttributes;
}

/** 추천 점수 — 필터가 특정 포지션이면 적합도(fit), ALL 이면 overall. */
export function recommendScore(player: RankablePlayer, filter: Position | "ALL"): number {
  const overall = playerOverall(player.attributes);
  if (filter === "ALL") return overall;
  return positionWeight(player.position, filter) * overall;
}

/**
 * Sort players by recommendation for the given filter (desc), tie-break playerId asc.
 * Pure & stable-by-value: same input set → same order regardless of input order.
 */
export function rankPlayers<T extends RankablePlayer>(players: T[], filter: Position | "ALL"): T[] {
  return [...players].sort((a, b) => {
    const d = recommendScore(b, filter) - recommendScore(a, filter);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
