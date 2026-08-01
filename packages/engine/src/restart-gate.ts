import type { EngineConfig } from "./config";
import type { SimState } from "./simstate";
import type { Pitch } from "./pitch";
import type { TeamSide } from "@hmb/shared";
import { freeKickWallCount } from "./setpiece";

/**
 * restart-gate — **재개를 무엇이 기다리는가**. (#378)
 *
 * ## hero 요구
 * *"데드볼하면 선수들이 항상 고정된 자리로 돌아가. 돌아가는 동안 기다리며 움직이는 게 이상해.
 * 진짜 축구처럼 볼을 준비하고 심판이 휘슬을 불면 선수들이 **자리를 찾기 전에도 진행 가능**하고,
 * 선수들도 **위치 찾아가면서 판단**하면서 진행하고 싶어. 1에서 말한 상황은 심판이 프리킥 벽
 * 세울 때까지 기다려야 돼. 골킥은 자기팀 선수들이 앞으로 나갈 때까지 기다려도 돼."*
 *
 * ## 조사가 말한 것 (`research/deadball-restart.md`)
 * 이 세 가지는 **IFAB Laws 에 이미 그 이름으로 존재한다.** 실축의 기본값은 **quick** 이고
 * (Law 13 은 재개 전 휘슬을 요구하지 **않는다**), "의식(ceremonial)"은 **예외**이며 심판만
 * 만들 수 있다. *"벽을 세우라고 재개를 잡아 둘 의무는 심판을 포함해 누구에게도 없다."*
 * 조사한 어떤 게임(FC26 · eFootball · FM26)도 "전원이 고정 자리로 돌아갈 때까지 기다린다"를
 * 하지 않는다. 즉 우리 엔진은 **규칙의 예외를 모든 재시작에 강제**하고 있었다.
 *
 * ## 구 동작이 왜 그렇게 됐나 (되돌리면 안 되는 것)
 * 정지 길이는 `walkStoppage` 가 **taker 의 도보 시간**으로 정했고, 그 위에 `base`(스로인/코너/골킥
 * 12틱 · 프리킥 8틱)가 **하한**으로 깔려 있었다. 즉 재개 시점을 정하는 것이 전술이 아니라
 * **taker 가 우연히 얼마나 멀리 있었나**였다. 그 하한이 곧 "전원이 자리 잡을 시간"이고,
 * hero 가 본 어색함의 정체다.
 *
 * ## 그래서 무엇을 바꾸나 — **정지 길이를 게이트의 함수로**
 *  - `quick`: taker 가 공에 닿으면 끝. **남들이 어디 있든 상관없다.** 하한은 공을 놓는 데
 *    필요한 최소 틱뿐(`quickBaseTicks`).
 *  - `ceremonial`: 벽이 설 시간을 준다(구 동작 = `freeKickStoppageTicks + wallSetupTicks`).
 *  - `teamShape`: 우리 팀이 올라갈 시간을 준다(골킥 롱볼 선택).
 *
 * **이게 왜 "이동 중 판단"까지 주는가**: 정지가 짧아지면 재개 틱에 아직 걸어가는 중인 선수가
 * 남는다. 그 선수는 재개 직후 **평소 오프더볼 로직**(`decideOffBall`)으로 돌아가므로,
 * 자리를 찾아가면서 인식·판단을 계속한다. 정지 중 로직을 건드리지 않고도 요구가 성립한다 —
 * 정지 중 `decideOffBall` 을 켜는 안은 #185(제자리 왕복)·#174(단독 질주)를 되살려 **기각**했다
 * (0.25.0 "목표 램프" 실측 전례: 왕복 0.00 → 1.17/100).
 *
 * ## 결정론·상태
 * **순수 함수다.** `SetPiece` 에 필드를 더하지 않는다 — 그러면 `resumeState` 와 서버 직렬화
 * (`packages/server`, 계약 프리즈)까지 건드려야 한다. 게이트의 입력(종류·스팟·팀 지시)은
 * 정지 창 내내 불변이라 매번 다시 구해도 같은 값이다.
 */
export type RestartGate = "quick" | "ceremonial" | "teamShape";

/** 킥으로 재개되는 세트피스 중 게이트가 적용되는 종류. */
export type GatedKind = "throw_in" | "goal_kick" | "free_kick";

/**
 * 이 재시작을 무엇이 기다리는가.
 *
 *  - **프리킥**: 위협거리 매핑이 벽을 부르면 `ceremonial`(hero: *"심판이 벽 세울 때까지 기다려야"*),
 *    사거리 밖이면 `quick`(Law 13 기본값).
 *  - **골킥**: 팀의 `passDirectness` 가 임계 이상이면 `teamShape`(전원 전진 후 롱볼 —
 *    hero: *"골킥은 자기팀이 앞으로 나갈 때까지 기다려도 돼"*), 아니면 `quick`(짧게 빨리 —
 *    2019 Law 16 개정이 1급으로 만든 선택지). **어느 쪽인지를 팀 지시가 정한다** = 죽어 있던
 *    입력이 또 하나 살아나는 자리.
 *  - **스로인**: 항상 `quick`(Law 15, 실축에서 거의 항상 빠르다. 우리 빈도 최다라 체감이 가장 크다).
 *
 * 코너는 게이트를 쓰지 않는다 — 박스 크라우딩이 성립해야 코너라서 정지가 그 배치의 시간이다.
 */
export function restartGateOf(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  kind: GatedKind,
  side: TeamSide,
  spotX: number,
  spotY: number,
): RestartGate {
  const g = config.rules.restart.gate;
  if (!g.enabled) return "ceremonial"; // 롤백: 전부 구 동작(= 항상 기다린다)
  switch (kind) {
    case "free_kick":
      return freeKickWallCount(pitch, config, side, spotX, spotY) > 0 ? "ceremonial" : "quick";
    case "goal_kick":
      return teamGoalKickDirectness(state, side) >= g.goalKickDirectThreshold ? "teamShape" : "quick";
    case "throw_in":
      return "quick";
  }
}

/**
 * 팀의 골킥 다이렉트 성향(0..1). `passDirectness` 는 **선수별** 필드라 팀 지시를 그대로 쓸 수
 * 없다 — 그 팀 아웃필더의 평균으로 팀 성향을 만든다(프롬프트가 "길게 넘겨라"를 팀 전체에
 * 걸면 평균이 올라간다). GK 는 제외한다: 차는 사람의 성향이 아니라 **받을 사람들**의 성향이
 * "앞으로 나갈 것인가"를 정하기 때문이다.
 */
function teamGoalKickDirectness(state: SimState, side: TeamSide): number {
  let sum = 0;
  let n = 0;
  for (const p of state.players) {
    if (p.side !== side || p.isGK) continue;
    sum += p.behavior.passDirectness;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * 게이트별 **정지 하한 틱**. `walkStoppage` 의 `base` 로 들어간다(taker 가 더 멀면 도보 시간이 이긴다).
 *
 * ⚠️ 상한(`walkStoppage` 의 `base + 16`)은 그대로 둔다 — 데드락 방지(#231/#239)가 최우선이라
 * 어떤 게이트도 무한 대기가 될 수 없다.
 */
export function gateBaseTicks(
  config: EngineConfig,
  gate: RestartGate,
  kind: GatedKind,
  withWall: boolean,
): number {
  const r = config.rules.restart.gate;
  // ⚠️ `withWall` 을 **반드시 호출부에서 받아야 한다**. 초판은 여기서 `true` 를 상수로 넘겨서,
  // 롤백 경로(`enabled=false`)의 **사거리 밖 프리킥이 8틱이 아니라 14틱**이 됐다 = 0.32.0 이
  // 아니었다. 그 위에 이 웨이브의 관계식 계약과 증거 수치가 전부 걸려 있었다(독립검증 B2).
  // 롤백 스위치가 조용히 다른 동작을 하는 것은 이 리포가 `vision`·`hold-pressure` 해시로
  // 계약화해 온 규율의 정면 위반이다.
  if (!r.enabled) return legacyBase(config, kind, withWall);
  switch (gate) {
    case "quick":
      return r.quickBaseTicks;
    case "teamShape":
      return r.teamShapeTicks;
    case "ceremonial":
      return legacyBase(config, kind, withWall);
  }
}

/** 구 동작의 하한(롤백·의식 경로). */
function legacyBase(config: EngineConfig, kind: GatedKind, withWall: boolean): number {
  if (kind === "free_kick") {
    return (
      config.rules.freeKickStoppageTicks +
      (withWall ? config.setPiece.freeKick.wallSetupTicks : 0)
    );
  }
  return config.setPiece.stoppageTicks;
}
