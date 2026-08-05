/**
 * 스태틱 모드가 소비하는 **다른 패키지의 런타임**(#444) — 타입 경계.
 *
 * <b>왜 소스를 직접 타입체크하지 않는가</b>: `apps/web` 은 `noUnusedLocals`/`noUnusedParameters`
 * 를 켠 프로젝트이고 `packages/engine` 은 아니다. 엔진 소스를 web 의 프로그램에 끌어들이면 **남의
 * owned-glob 을 web 의 린트 설정으로 심판**하게 되고(실제로 engine 5건이 그 이유로 red 였다),
 * 고치려면 QA #25 도메인을 건드려야 한다. 각 패키지는 자기 프로젝트가 타입체크한다 —
 * 여기서는 **호출 계약만** 선언한다.
 *
 * 번들은 `vite.config.ts` 의 alias 가 붙인다(같은 이름 두 곳 = 짝). 이름을 실제 패키지명
 * (`@hmb/engine`)이 아니라 `-runtime` 접미로 둔 것도 그래서다 — 실제 이름이면 node_modules
 * 워크스페이스 링크가 먼저 해석돼 이 선언이 무시된다.
 */

declare module "@hmb/engine-runtime" {
  import type { MatchLog, SelectData, TacticalInput } from "@hmb/shared";

  /** 하프 사이에 들고 다니는 엔진 내부 상태(불투명 — 이 계층은 내용을 읽지 않는다). */
  export interface CarryState {
    configVersion: string;
    seed: string;
    snapshots: unknown[];
    events: unknown[];
    state: { score: { home: number; away: number } };
  }

  export const defaultEngineConfig: unknown;

  export function runFirstHalf(
    seed: string,
    home: TacticalInput,
    away: TacticalInput,
    select: SelectData,
    config?: unknown,
  ): CarryState;

  export function resumeSecondHalf(
    carry: CarryState,
    deltaHome: TacticalInput,
    deltaAway: TacticalInput,
  ): MatchLog;
}

declare module "@hmb/server-stub" {
  /**
   * AI 미로그인 폴백의 SoT — `packages/server/src/executor/executors/stub.ts`.
   * 산출은 계약상 `unknown`(검증 게이트가 executor 밖에 있다) → 호출부가 `TacticalInput` 으로 읽는다.
   */
  export function stubExecutor(): {
    readonly name: string;
    execute(job: unknown, attempt?: { feedback: string }): Promise<unknown>;
  };
}
