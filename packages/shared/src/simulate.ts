import { z } from "zod";
import { SelectData } from "./select-data.js";
import { TacticalInput } from "./tactical-input.js";
import { MatchLog } from "./match-log.js";

/**
 * SimulateRequest/SimulateResponse — 엔진러너(ts-servants ①) RPC 계약.
 * (docs/plan-v2/LLD-ts-servants.md §2, docs/plan-v2/LLD-server-java.md §5.3)
 *
 * half=1: 전반만 실행 → matchLog(전반분) + resumeState(불투명) + lastHash.
 * half=2 + resumeState: 전반 상태 승계 재개 → matchLog(후반분만) + lastHash. (resumeState 없음 — 매치 종료)
 * half=2 단독(resumeState 생략): 로스터 교체 시 독립 후반 시뮬(LLD-server-java §5.4 — 연속성 손실 PoC 허용).
 *
 * resumeState 는 러너 내부 표현(엔진 시뮬 상태 직렬화)이며 계약상 unknown — Java 는 해석하지 않고
 * 그대로 보관했다가 half=2 요청에 그대로 실어 돌려준다.
 */

export const SimulateHalf = z.union([z.literal(1), z.literal(2)]);
export type SimulateHalf = z.infer<typeof SimulateHalf>;

export const SimulateRequest = z.object({
  seed: z.string(),
  selectData: SelectData,
  homeInput: TacticalInput,
  awayInput: TacticalInput,
  half: SimulateHalf,
  resumeState: z.unknown().optional(),
});
export type SimulateRequest = z.infer<typeof SimulateRequest>;

export const SimulateResponse = z.object({
  matchLog: MatchLog,
  resumeState: z.unknown().optional(),
  /** matchLog.tickSnapshots 마지막 틱의 해시(경량 정합성 확인용). */
  lastHash: z.string(),
});
export type SimulateResponse = z.infer<typeof SimulateResponse>;
