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

/**
 * **계수 오버레이**(#383) — `EngineConfig` 의 수치/불리언 리프를 **점경로**로 덮어쓴다.
 * 예: `{"contest.shootXgThreshold": 0.07, "contest.shootRange": 22}`
 * (⚠️ `decisionWeights.*` 는 예로 쓰지 않는다 — 8개 전부 #338 INERT 라 작성 게이트가 400 을 낸다.)
 *
 * 중첩 JSON 이 아니라 평평한 맵인 이유는 **오타가 조용히 죽지 않게** 하기 위해서다 — 중첩
 * deep-merge 는 존재하지 않는 키를 받아도 성공하고 아무 일도 안 일어난다("필드가 계약에 있다 ≠
 * 엔진이 읽는다", #321·#337·#338). 평평한 경로는 기본 config 의 리프 전수와 집합 대조가 되므로
 * 미지 경로가 곧 **작성 시점 400** 이다. 판정·병합의 SoT = 러너
 * (`packages/server/src/runner/config-overlay.ts`) — 어떤 경로가 유효한지는 엔진을 손에 든 쪽만 안다.
 *
 * ⚠️ **거절은 작성 게이트에서만 한다.** 이미 매치에 박힌 오버레이의 **재생**은 그 사이 엔진이 노브를
 * 지웠더라도 죽지 않는다 — 그 경로를 버리고 `SimulateResponse.droppedOverrides` 로 보고한다(B3).
 * 노브 삭제는 엔진 열차의 정상 활동이고, 정상 활동이 진행 중 매치와 이후 모든 신규 매치를 죽이면 안 된다.
 *
 * 값 타입이 number|boolean 뿐인 이유: `EngineConfig` 의 비수치 리프는 **넷**이다 —
 * `version` · `coordMode` · `formations` (여기까지 구조) 그리고 **`chain.mode`**. 마지막 것은 구조가
 * 아니라 **결정 코어 롤백 스위치**(이 엔진에서 파급이 가장 큰 레버)인데 문자열이라 오버레이가
 * 불가능하고 배포로만 바뀐다. "셋뿐이고 셋 다 구조"라고 쓴 초판은 **틀렸다**(독립검증 M3·M7).
 */
export const EngineConfigOverrides = z.record(z.string(), z.union([z.number(), z.boolean()]));
export type EngineConfigOverrides = z.infer<typeof EngineConfigOverrides>;

export const SimulateRequest = z.object({
  seed: z.string(),
  selectData: SelectData,
  homeInput: TacticalInput,
  awayInput: TacticalInput,
  half: SimulateHalf,
  resumeState: z.unknown().optional(),
  /**
   * 계수 오버레이(#383). **additive optional** — 없으면 러너 기본값 = 이 필드 이전과 bit-identical.
   *
   * 서버는 이 값을 **매치 생성 시점에 매치 행에 복사**해 두고 두 하프에 같은 값을 실어 보낸다.
   * 진행 중 매치가 "지금 라이브 값"을 조회하는 경로는 없다 — 그게 #241(버전 범프가 진행 매치를
   * FAILED 로 밀어낸 사건) 재발을 규율이 아니라 구조로 막는 자리다.
   */
  configOverrides: EngineConfigOverrides.optional(),
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
  /**
   * **이 하프가 실제로 어떤 config 로 돌았나**의 지문(#383, sha256 앞 16자).
   *
   * 오버레이가 아니라 **병합된 유효 config 전체**의 해시다 — 러너 이미지가 바뀌어 기본값이
   * 달라지면 같은 오버레이라도 다른 경기가 나오고, 그 사고가 지문에 잡혀야 한다. 서버는 이 값을
   * 하프 번들(`match_halves`)에 박아 재현 계약의 네 번째 항("어떤 config 였나")을 완결시킨다.
   *
   * additive optional — 구 러너는 안 준다(그때는 `matches.engine_version` 만이 근거였다).
   */
  effectiveConfigHash: z.string().optional(),
  /**
   * **박힌 오버레이 중 이번 재생에서 적용하지 못해 버린 경로**(#383, 독립검증 B3).
   *
   * 매치는 생성 시점의 오버레이를 그대로 들고 두 하프를 돈다. 그 사이 엔진이 배포돼 노브가
   * **삭제·개명**되거나(0.26.0 이 `ball.settleSpeed` 를 지웠다) 타입이 바뀌면 그 경로는 더 이상
   * 적용할 수 없다. 그때 러너가 400 을 내면 ①그 오버레이가 박힌 진행 중 매치가 전부 FAILED 가
   * 되고 ②원장의 현재 리비전이 그 키를 든 채라 **이후 생성되는 모든 매치**가 h1 에서 죽는다.
   * 노브 삭제는 사고가 아니라 엔진 열차의 정상 활동이므로, 정상 활동이 게임 루프를 멈추면 안 된다.
   *
   * 그래서 **버리되 조용히 버리지 않는다** — 이 필드로 나가고 서버가 하프 번들에 박아 WARN 을
   * 찍는다. 재현 계약은 `effectiveConfigHash`(실제로 돈 config 전체의 지문)가 계속 완결시킨다.
   *
   * additive optional — 정상 경로에서는 **키 자체가 없다**.
   */
  droppedOverrides: z
    .array(z.object({ path: z.string(), reason: z.string() }))
    .optional(),
});
export type SimulateResponse = z.infer<typeof SimulateResponse>;
