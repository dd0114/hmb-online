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
  /**
   * **이 하프를 연출 페이싱으로 처음부터 끝까지 보는 데 걸리는 실시간(ms)** (#365).
   *
   * 왜 러너가 주나: 서버는 하프 마감 시각(`phase_ends_at`)을 정해야 하는데, 재생 길이는
   * 틱 수가 아니라 **그 경기에 슛·골·정지가 몇 개냐**가 정한다(슬로우모션·홀드). 계산 규칙은
   * viewer-core `autoPaceDurationMs` 한 곳에 있고 그건 렌더 루프와 같은 상수를 읽는 TS 라,
   * 로그를 이미 손에 든 러너가 재는 것이 유일하게 갈라지지 않는 자리다.
   *
   * 이 값이 창이 되면 **재생 속도를 창에 맞춰 보정할 필요가 사라진다**(hero 확정: 고정 배속만).
   * 없으면(구 러너) 서버가 `hmb.match.clock.half-real-ms` 폴백을 쓴다 — 그때는 예전처럼
   * 클라 배율 보정이 필요하다. 그래서 **optional 이고 additive** 다.
   */
  playbackMs: z.number().int().positive().optional(),
});
export type SimulateResponse = z.infer<typeof SimulateResponse>;
