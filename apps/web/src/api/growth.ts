/**
 * 성장/강화 응답 타입 (에픽 #179 G4 — 이중 트랙). SoT = packages/shared/src/growth.ts (zod).
 *
 * ⚠️ 이 엔드포인트들은 아직 openapi.yaml(generated schema.d.ts)에 없다 — server-java 소관.
 * 그래서 여기서 shared 계약을 손으로 미러링하되 Grade/PlayerAttributes 는 generated schema 를
 * 재사용해 드리프트를 막는다. openapi 에 편입되면 이 파일을 generated 타입으로 교체한다.
 */
import type { components } from "./schema";

type Grade = components["schemas"]["Grade"];
type PlayerAttributes = components["schemas"]["PlayerAttributes"];

/** GET /api/growth/card/{playerId} — 카드 상세(시안3): 현재/천장/기본 3표시. */
export interface CardEffective {
  playerId: string;
  baseGrade: Grade;
  effectiveGrade: Grade;
  attributes: PlayerAttributes; // 현재 유효 스탯(base+fill, cap 클램프)
  caps: PlayerAttributes; // 능력치별 천장(effectiveGrade 밴드 상한)
  base: PlayerAttributes; // 뽑기 롤 원본(기준선)
  ovr: number;
  completion: number; // 0..1
}

/** POST /api/growth/enhance | /limitbreak → 강화/한계돌파 결과. */
export interface EnhanceResult {
  playerId: string;
  enhanceLevel: number;
  limitBreak: number;
  effectiveGrade: Grade;
  ovr: number;
  promoted: boolean; // 이번 실행으로 등급 승급했나
  spent: { copies: number; points: number };
}

/** GET /api/growth/report/{matchId} — 매치 후 성장 리포트(ResultPage S1) 항목. */
export interface MatchGrowthEntry {
  playerId: string;
  name: string;
  xpDelta: number;
  ovrBefore: number;
  ovrAfter: number;
  leveledUp: boolean;
  topAttrs: string[];
}

export interface MatchGrowthReport {
  matchId: string;
  entries: MatchGrowthEntry[];
}

/** 강화 상한 도달 시 서버가 내려주는 4xx 코드. */
export const ENHANCE_MAX_CODE = "ENHANCE_MAX";
