/**
 * Phase-2 API type surface (합성 소비 지점).
 *
 * 타입 파이프라인 = 2스펙 병합:
 *   - schema.d.ts    ← docs/plan-v2/api/openapi.yaml    (V1, `npm run gen:types:v1`)
 *   - schema-v2.d.ts ← docs/plan-v3/api/openapi-v2.yaml (Phase2 델타, `npm run gen:types:v2`)
 * 두 파일은 별도 모듈로 두고(각 스펙 = 1 생성물), 클라이언트는 여기서 합성 소비한다.
 *
 * dedup: 두 스펙 모두 ApiError·ErrorCode·WalletInfo·PlayerRef 등 공통 스키마를 선언한다
 * (openapi-v2 §"공통(V1 미러 + Phase2 superset)"). 충돌을 피하려고 공통 스키마의 canonical
 * 소스는 V1(`./schema` + `./client`의 ErrorCode)로 고정하고, 이 배럴은 **Phase2 신규 스키마만**
 * 재노출한다. (ErrorCode 는 V2 가 TRADE_INVALID/LEAGUE_INVALID 를 추가한 superset 이므로
 * 트레이드/리그 웨이브 진입 시 client.ts 의 ErrorCode 유니온에 그 두 값을 더한다.)
 */
import type { components } from "./schema-v2";

export type SchemasV2 = components["schemas"];

// 프리셋/스냅샷 (W1)
export type TeamSnapshot = SchemasV2["TeamSnapshot"];
export type TeamTactics = SchemasV2["TeamTactics"];
export type SnapshotSlot = SchemasV2["SnapshotSlot"];
export type TeamPresetSlot = SchemasV2["TeamPresetSlot"];
export type TeamSnapshotSaveRequest = SchemasV2["TeamSnapshotSaveRequest"];

// 컨디션/관계 (W2)
export type ConditionMap = SchemasV2["ConditionMap"];
export type PlayerRelation = SchemasV2["PlayerRelation"];
export type RelationsResponse = SchemasV2["RelationsResponse"];
export type Personality = SchemasV2["Personality"];

// 트레이드 (W3)
export type PlayerRef = SchemasV2["PlayerRef"];
export type TradeSlot = SchemasV2["TradeSlot"];
export type TradeSlotsResponse = SchemasV2["TradeSlotsResponse"];
export type TradeSpeedupResponse = SchemasV2["TradeSpeedupResponse"];
export type FaProposeRequest = SchemasV2["FaProposeRequest"];
export type TradeResolveResponse = SchemasV2["TradeResolveResponse"];
export type TradeLogItem = SchemasV2["TradeLogItem"];

// 로그/랭킹 (W4)
export type MatchLogItem = SchemasV2["MatchLogItem"];
export type RankingEntry = SchemasV2["RankingEntry"];
export type RankingsResponse = SchemasV2["RankingsResponse"];

// 리그 (W5)
export type LeagueTeam = SchemasV2["LeagueTeam"];
export type LeagueStanding = SchemasV2["LeagueStanding"];
export type LeagueFixture = SchemasV2["LeagueFixture"];
export type LeagueSeason = SchemasV2["LeagueSeason"];
export type LeagueResponse = SchemasV2["LeagueResponse"];
export type LeagueNextMatchResponse = SchemasV2["LeagueNextMatchResponse"];
