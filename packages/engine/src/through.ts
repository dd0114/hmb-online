import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import type { Pitch } from "./pitch";
import type { PassOption } from "./perception";
import { laneDangerOn } from "./perception";
import { fclamp, fdist, toFixed } from "./fixedmath";
import { attackProgressX, clampToPitch, distToAttackGoal } from "./pitch";
import { offsideLineProg } from "./contest";
import { ballReachTicks } from "./kick";
import { passDelivery, speedStep } from "./decision";

/**
 * through — **공간 타깃 패스 후보(스루패스 본체)**, #377 트랙 D M3-C.
 *
 * ## 무엇이 없었나
 * `passOptions` 는 동료 **개체**만 후보로 낸다. 조준점은 언제나 리시버의 (미래) 발밑이고
 * (`decision.ts:leadAim`), 그래서 리드 거리 p50 이 **3.48m** 였다 — 스루패스는 10~25m 다.
 * `ActionCandidate` 는 S2(#279)부터 **좌표가 1급**이라 "사람은 정해져 있는데 공은 그 앞 공간으로"
 * 가 문법적으로 표현 가능했는데, **그 좌표를 만드는 생성기가 없었다.**
 *
 * ## 왜 지금 되나 (M3-A 가 선행 조건인 이유)
 * 공간 후보의 성공확률은 **경주**다 — 러너가 먼저 닿나, 수비가 먼저 닿나. 러너가 서 있으면
 * 언제나 수비가 먼저 닿아 EV 가 낮고 후보가 **한 번도 안 뽑힌다**(W0 §3 이 "C 먼저"를 기각한
 * 근거). M3-A(#369 예고 패스)가 착지해 리시버가 예고를 읽고 **이미 뛰고 있으므로**, 여기서
 * 그 런의 앞을 조준하면 경주가 성립한다. 실제로 이 파일은 `mate.targetFx`(= 예고를 읽은 리시버가
 * 향하는 지점)를 런 방향으로 쓴다 — 두 웨이브가 한 축으로 맞물리는 지점이다.
 *
 * ## 새 행동을 만들지 않는다
 * 결과물은 그냥 `PassOption` 이다(`aimFx` 가 채워진). 실행은 `planPass`, 도착은 `resolveArrival`,
 * 이벤트는 `pass`, 반칙 판정은 `checkOffside` — 전부 기존 함수 그대로다. `packages/shared` 무변경
 * (#326 재발 방지: 0.26.0 의 `clearance` 타입 추가가 계약 프리즈를 깼다).
 *
 * ## 결정론
 * Rng 를 **한 번도** 안 쓴다(순수 기하). 후보 수가 RNG 소비량에 영향을 주지 않으므로 재개 계약이
 * 후보 공간의 함수가 되지 않는다(#369 가 경고한 함정). 반복은 `state.players` 배열 순서 고정,
 * 산술은 전부 정수 고정소수, 삼각함수 없음.
 */

/**
 * 오프사이드 라인 = **심판의 자**를 그대로 쓴다(`contest.ts:offsideLineProg`).
 *
 * ⚠️ 여기에 사본을 두지 않는다(#377 M3-C 독립검증 m5). 다른 자로 잡으면 "라인 뒤로 찔렀는데
 * 심판은 오프사이드라고 본다"(또는 그 반대)가 두 정의의 오차만큼 상시 발생한다. 초판은 그
 * 성질을 소스 문자열 비교로 걸었는데, 지금은 **같은 함수를 부르는 것**이 보장이다.
 */

/**
 * **생성 게이트 계측**(옵트인, 진단 전용) — `ChainProbe` 와 같은 규율.
 *
 * 왜 필요한가: 이 생성기는 게이트가 여섯 겹이라 "왜 안 뽑혔나"가 곧 "어느 게이트에서 죽었나"다.
 * S2 가 `ChainProbe` 를 만든 이유(*"탐색기를 바꿨는데 지표가 안 움직였다 → 왜인지 **추측했다**"*)가
 * 여기서 그대로 반복된다. 실제로 이 웨이브의 설계 수정 두 건(리드 산정 방식 · `stepToward` 제거)이
 * 전부 이 계측의 분포를 보고 나왔다.
 *
 * ⚠️ 결정론 영향 0: 기본 null(옵트인) · 시뮬 로직은 이 카운터를 **읽지 않는다**(쓰기 전용).
 */
export interface ThroughProbe {
  /** 후보 심사에 들어온 (결정 × 동료) 쌍. */
  mates: number;
  /** 이미 오프사이드 위치라 제외. */
  offside: number;
  /** 전진 중이 아니라 제외(`minRunGainM`). */
  notRunning: number;
  /** 조준점이 라인 뒤가 아니라 제외(`behindLineM`). */
  notBehind: number;
  /** 리드가 하한 미만이라 제외(`minLeadM`). */
  shortLead: number;
  /** 전진 이득이 없어 제외. */
  noForward: number;
  /** 그 세기로 조준점까지 못 가서 제외. */
  unreachable: number;
  /** 러너가 계획 창 안에 못 닿아 제외. */
  runnerLate: number;
  /** 수비와의 경주에서 여유가 모자라 제외(`minMarginTicks`). */
  lostRace: number;
  /** 최종 생성된 후보 수. */
  generated: number;
}

export function newThroughProbe(): ThroughProbe {
  return {
    mates: 0, offside: 0, notRunning: 0, notBehind: 0, shortLead: 0,
    noForward: 0, unreachable: 0, runnerLate: 0, lostRace: 0, generated: 0,
  };
}

let activeThroughProbe: ThroughProbe | null = null;

/** 게이트 계측 켜기/끄기(옵트인). 켜고 끄는 것이 시뮬 결과를 바꾸지 않는다. */
export function setThroughProbe(p: ThroughProbe | null): void {
  activeThroughProbe = p;
}

/** 현재 활성 게이트 계측기(없으면 null). */
export function throughProbe(): ThroughProbe | null {
  return activeThroughProbe;
}

/**
 * 볼 소유자의 **공간 타깃 패스 후보**. 각 후보는 `aimFx`(라인 뒤 지점)와 `raceFrac`(경주 계수)를
 * 가진 `PassOption` 이고, 사슬 생성기가 그대로 `ActionCandidate` 로 감싼다.
 */
export function throughPassOptions(
  state: SimState,
  owner: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
): PassOption[] {
  const tp = config.chain.throughPass;
  if (!tp.enabled) return [];
  const lineProg = offsideLineProg(state, owner.side, pitch);
  if (lineProg === null) return [];

  const scale = config.fixedScale;
  // 진행도(0..1)와 미터를 오가는 환산 — 피치 길이 기준(`checkOffside` 의 tolerance 환산과 동일).
  const behindNorm = tp.behindLineM / config.pitch.width;
  const tolNorm = config.rules.offside.toleranceM / config.pitch.width;
  const minRunFx = toFixed(tp.minRunGainM, scale);
  const minLeadFx = toFixed(tp.minLeadM, scale);
  const maxLeadFx = toFixed(tp.maxLeadM, scale);
  const ownGoalDist = distToAttackGoal(pitch, owner.side, owner.posFx.x, owner.posFx.y);
  const wait = Math.max(0, Math.round(config.contest.arrivalWaitMaxTicks));

  const pr = throughProbe();
  const out: PassOption[] = [];
  for (const mate of state.players) {
    if (mate.side !== owner.side || mate.id === owner.id || mate.isGK) continue;
    if (pr) pr.mates++;

    // ① 지금 온사이드인가. 이미 라인 뒤에 서 있는 동료에게 찌르는 것은 스루패스가 아니라
    //    **오프사이드 패스**다(`checkOffside` 가 그 자리에서 깃발을 든다). 그래서 후보로 안 낸다.
    const mateProg = attackProgressX(pitch, owner.side, mate.posFx.x);
    if (mateProg > lineProg + tolNorm) { if (pr) pr.offside++; continue; }

    // ② 전진 중인가. 판정은 **목표**로 한다 — 예고(#369)를 읽고 라인 뒤로 출발한 러너가
    //    바로 이 조건으로 잡힌다(읽기 전에는 자기 역할 자리라 대개 전진량이 작다).
    const mateGoalDist = distToAttackGoal(pitch, owner.side, mate.posFx.x, mate.posFx.y);
    const runGain = mateGoalDist - distToAttackGoal(pitch, owner.side, mate.targetFx.x, mate.targetFx.y);
    if (runGain < minRunFx) { if (pr) pr.notRunning++; continue; }

    // ③ 조준점 = 러너의 **런 방향 앞**. 리드는 **러너가 실제로 닿을 수 있는 거리**로 잡는다:
    //
    //      리드 = clamp(러너 속도 × (공 도달 틱 + 계획 창), minLeadM, maxLeadM)
    //
    //    ⚠️ 초판은 리드를 "라인 뒤 `behindLineM` 까지 필요한 전진량"으로 잡았는데, 실측하니
    //    **모든 후보의 리드가 정확히 `minLeadM`(10.0m)** 이었다 — 라인 뒤로 조준점이 나오는
    //    경우가 애초에 "러너가 라인 코앞에 있을 때"뿐이라 필요량이 언제나 하한 아래였다.
    //    그 형태에서는 `maxLeadM` 이 **한 번도 발화하지 않고**(= 죽은 노브) AC 의 "10~25m 구간"이
    //    사실상 한 점이 된다. 지금 형태는 "받을 수 있는 만큼 멀리 찔러 넣는다"라는 실축의 의미와
    //    같고, 밴드 전체가 실제로 쓰인다.
    //
    //    ⚠️ 리드는 공 도달 틱에, 공 도달 틱은 조준점(거리)에 의존한다 — 순환이다. `leadAim`(#181)
    //    이 쓰는 것과 **같은 관용구**로 2회 반복해 수렴시킨다(전부 정수 산술이라 결정론 유지).
    const dx = mate.targetFx.x - mate.posFx.x;
    const dy = mate.targetFx.y - mate.posFx.y;
    const runLen = Math.max(1, fdist(mate.posFx.x, mate.posFx.y, mate.targetFx.x, mate.targetFx.y));
    const runStep = Math.max(1, speedStep(mate, config));
    // ⚠️ `stepToward` 를 **쓰지 않는다**(초판이 썼다가 실측으로 걸렀다): 그 함수는 남은 거리가
    // step 보다 짧으면 **목표에 스냅**한다. 러너의 목표는 대개 몇 m 앞이라 리드가 그 자리로
    // 접혀 후보가 통째로 죽었다. 여기서 필요한 것은 **런 방향의 반직선**이고, 정수 정규화는
    // `match.ts` 의 패서 따라들어가기와 같은 관용구다.
    const rayAt = (lead: number): { x: number; y: number } =>
      clampToPitch(
        pitch,
        mate.posFx.x + Math.round((dx * lead) / runLen),
        mate.posFx.y + Math.round((dy * lead) / runLen),
      );
    const clampLead = (v: number): number => (v < minLeadFx ? minLeadFx : v > maxLeadFx ? maxLeadFx : v);

    let leadFx = maxLeadFx;
    let aim = rayAt(leadFx);
    let distFx = fdist(owner.posFx.x, owner.posFx.y, aim.x, aim.y);
    let speedFx = 0;
    let lofted = false;
    let ballT = Infinity;
    for (let iter = 0; iter < 2; iter++) {
      // 세기·궤도는 실행(`planPass`)과 **같은 함수**로 뽑는다 — 후보가 예측한 비행과 실제 비행이
      // 갈리면 경주 계산이 통째로 허구가 된다(#312 가 세운 규율).
      const probe: PassOption = { receiver: mate, dist: distFx, laneDanger: Infinity, forwardGain: 0, long: false };
      const d = passDelivery(state, owner, probe, config);
      speedFx = d.speedFx;
      lofted = d.lofted;
      ballT = ballReachTicks(distFx, speedFx, lofted, config);
      if (!Number.isFinite(ballT)) break;
      leadFx = clampLead(runStep * (ballT + wait));
      aim = rayAt(leadFx);
      distFx = fdist(owner.posFx.x, owner.posFx.y, aim.x, aim.y);
    }
    if (!Number.isFinite(ballT)) { if (pr) pr.unreachable++; continue; } // 그 세기로는 조준점까지 못 간다.
    if (distFx === 0) continue;

    // ④ **결과로 판정한다.** 런 방향이 옆이거나 조준점이 라인에 클램프되면 "앞 공간"이 아니다.
    //    의도로 판정하면 그 무발화가 숨는다 — 트랙 D 가 반복해서 걸린 자리다.
    if (attackProgressX(pitch, owner.side, aim.x) < lineProg + behindNorm) { if (pr) pr.notBehind++; continue; }
    const leadActualFx = fdist(mate.posFx.x, mate.posFx.y, aim.x, aim.y);
    if (leadActualFx < minLeadFx) { if (pr) pr.shortLead++; continue; }

    const forwardGain = ownGoalDist - distToAttackGoal(pitch, owner.side, aim.x, aim.y);
    if (forwardGain <= 0) { if (pr) pr.noForward++; continue; }

    const opt: PassOption = {
      receiver: mate,
      dist: distFx,
      laneDanger: laneDangerOn(state, owner.side, owner.posFx.x, owner.posFx.y, aim.x, aim.y),
      forwardGain,
      // 롱볼로 분류하지 않는다: `long` 은 "인식 반경 밖 동료에게 거는 의도적 롱볼"(E2)이라는
      // 별개 축이고, 켜면 `detail:"long"`·`isLofted` 강제가 따라와 롱패스 시도율 게이트까지
      // 오염된다. 스루패스는 **지상으로 찔러 넣는 패스**다(25m 이상이면 `isLofted` 가 알아서 띄운다).
      long: false,
      aimFx: aim,
    };

    // ⑤ **경주** — 이 후보의 성공확률이 무엇으로 결정되는지가 여기 있다.
    //    창 = 공 도달 + 계획 창(`arrivalWaitMaxTicks`). 그 사이에 claimant 가 닿으면 계획대로
    //    배달되고(`resolveArrival` 1단계), 못 닿으면 계획이 소멸하고 먼저 닿은 사람이 임자다.
    //    즉 이 창은 **엔진이 이미 쓰고 있는 규칙**이지 새 임계가 아니다.
    //    ③ 이 리드를 이 창에 맞춰 잡았으므로 아래 판정은 대개 통과한다 — 남는 것은
    //    `maxLeadM` 클램프에 걸려 리드가 창보다 길어진 경우다(그때는 러너가 못 닿는다).
    const runT = Math.ceil(leadActualFx / runStep);
    if (runT > ballT + wait) { if (pr) pr.runnerLate++; continue; }

    let oppT = Infinity;
    for (const opp of state.players) {
      if (opp.side === owner.side) continue;
      const t = Math.ceil(
        fdist(opp.posFx.x, opp.posFx.y, aim.x, aim.y) / Math.max(1, speedStep(opp, config)),
      );
      if (t < oppT) oppT = t;
    }
    const margin = Number.isFinite(oppT) ? oppT - runT : tp.minMarginTicks;
    // ⚠️ **보수적으로 시작한다** — W0 §5-3 의 hero 검사 항목("스루패스가 실패해 골킥이 되는
    // 그림이 자주 보여도 괜찮나, 아니면 성공 가능성이 높을 때만 찌를까")에 hero 회신이 없어
    // **보수(성공 가능성이 높을 때만)** 를 기본값으로 잡았다. hero 가 반대로 정하면
    // `minMarginTicks` 를 0 이나 음수로 내리면 된다 — 코드는 안 바꾼다.
    if (margin < tp.minMarginTicks) { if (pr) pr.lostRace++; continue; }
    opt.raceFrac = fclamp(tp.raceBase + tp.raceGainPerTick * margin, 0, 1);

    if (pr) pr.generated++;
    out.push(opt);
  }
  return out;
}
