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
/** [장 시작!] / [거래 안함] 결과 — 새 오퍼로 WAITING 진입한 슬롯 + 지갑 (#149). */
export type TradeStartResponse = SchemasV2["TradeStartResponse"];
export type FaProposeRequest = SchemasV2["FaProposeRequest"];
export type TradeResolveResponse = SchemasV2["TradeResolveResponse"];
export type TradeLogItem = SchemasV2["TradeLogItem"];

// 로그/랭킹 (W4)
export type MatchLogItem = SchemasV2["MatchLogItem"];
/**
 * rating(#245 D3 additive) — 리더보드 **정렬 기준**이 승수에서 레이팅으로 바뀌었다(hero 확정).
 * 구 서버 응답엔 없으므로 optional(없으면 표시만 생략, 화면은 그대로 돈다).
 */
/**
 * rank 가 nullable 이고 eligible 이 붙은 이유(#296): 랭킹은 **한 판이라도 끝낸 유저**만 싣는다.
 * 아직 안 한 유저는 순위가 **0위가 아니라 없다** — 0 으로 채우면 화면에서 0위가 1위보다 좋은
 * 건지 헷갈린다. 서버는 자격이 없어도 200 + 리더보드를 준다(404 면 클라가 로드 실패로 그린다).
 */
export type RankingEntry = Omit<SchemasV2["RankingEntry"], "rank"> & {
  rank: number | null;
  rating?: number;
  eligible?: boolean;
};
/** leaderboard/me 항목도 확장 RankingEntry(=rating additive)를 쓴다 — 생성 스키마의 중첩 타입을 덮는다. */
export type RankingsResponse = Omit<SchemasV2["RankingsResponse"], "leaderboard" | "me"> & {
  leaderboard: RankingEntry[];
  me?: RankingEntry;
};
export type PersonalRecords = SchemasV2["PersonalRecords"];

// 리그 (W5)
export type LeagueTeam = SchemasV2["LeagueTeam"];
export type LeagueStanding = SchemasV2["LeagueStanding"];
export type LeagueFixture = SchemasV2["LeagueFixture"];
export type LeagueSeason = SchemasV2["LeagueSeason"];
export type LeagueResponse = SchemasV2["LeagueResponse"];
export type LeagueNextMatchResponse = SchemasV2["LeagueNextMatchResponse"];
