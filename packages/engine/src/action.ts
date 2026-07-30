import type { SimPlayer } from "./simstate";
import type { PassOption } from "./perception";

/**
 * action — **볼 소유자 행동 후보의 통합 표현형**(#279 S2).
 *
 * ## 왜 이 파일이 존재하나
 * 지금 후보를 담는 그릇은 `PassOption` 하나뿐이고, 그 안의 `receiver` 는 **non-nullable `SimPlayer`** 다
 * (`perception.ts:12`). 즉 "공이 도착할 지점"이라는 개념 자체가 타입에 없다 — 타깃은 언제나 **사람**이다.
 * 그래서 크로스·컷백·스루패스·사이드전환·캐리 방향은 **문법상 표현할 수 없다**(로드맵 R1/C1).
 * 로드맵 §1 이 62개 전술 → 능력 15개로 환원했을 때 맨 위(C1)에 온 게 이것이고,
 * W2 실험이 "탐색기를 고급화해도 후보 공간이 없으면 아무것도 안 바뀐다"를 실측으로 확인했다(§8).
 *
 * 그래서 S2 는 **고를 것을 담을 그릇만** 만든다. 행동은 한 개도 늘리지 않는다:
 * shoot · direct pass · long pass · carry · hold — 지금 있는 그대로다.
 * 늘리는 건 S5(lead/through/cross/switch 생성기)이고, 그때 이 파일은 **한 줄도 안 바뀐다**는 것이
 * 이 표현형이 옳게 잡혔다는 판정 기준이다.
 *
 * ## 좌표가 1급이다
 * `toXFx/toYFx` 는 **공이 도착할 지점**이다. 사람 타깃이면 리시버 위치와 같고, `receiver === null`
 * 이면 **순수 공간 타깃**(누가 먼저 닿는지로 결과가 갈린다). 이 null 하나가 S5 전체를 연다.
 *
 * ## 결정론
 * 이 파일에 Rng·시각·부동소수 비교가 없다. EV 는 `EV_SCALE` 정수 고정소수이고(아래),
 * 정렬 tiebreak 는 `candidateKey` 의 **전순서 문자열**이다(§5-3).
 */

/**
 * EV(기대가치)의 고정소수 스케일. **EV 는 정수다.**
 *
 * 왜: 사슬 코어는 EV 를 **비교·정렬해서 행동을 고른다**. 부동소수로 비교하면 (a) 같은 값이어야 할
 * 두 후보가 마지막 비트에서 갈려 "동점 tiebreak"가 아예 안 불리고, (b) 누적 곱/합의 반올림이
 * 플랫폼·엔진 버전에 따라 달라지면 **정렬이 뒤집혀 행동이 갈린다**(= 무음 desync).
 * 정수는 IEEE754 상 +−×÷ 가 전부 정확히 규정돼 있어 플랫폼 불변이고, **동점이 정확히 동점**이다.
 * (`Math.pow/exp/sin/cos` 만이 구현 근사다 — 그래서 `powFrac` 는 반복 곱으로 만든다.)
 *
 * 1e4 인 이유: EV 의 실질 범위가 대략 −3..+12(goalValue 12 가 상한 근처)라 정수 표현은
 * −3e4..1.2e5 로 2^53 에 한참 못 미치고, 확률(1e4)·가중치(1e4)와 곱해도 최대 ~1e9 로 안전하다.
 */
export const EV_SCALE = 10000;

/** 확률·가중치·정규화된 0..1 항의 고정소수 스케일(EV 와 같은 자리로 맞춰 곱셈을 단순화). */
export const FRAC_SCALE = 10000;

/** 무엇을 하는가. `Action`(decision.ts)의 실행 계약과 1:1 은 아니다 — carry → Action.dribble. */
export type ActionKind = "shoot" | "pass" | "carry" | "hold";

/**
 * 어떤 **형태**의 행동인가. kind 보다 잘게 나눈 축으로, 계측 라벨과 (S5 이후) 실행 분기의 근거가 된다.
 * `lead/through/switch/cross` 는 **S5 에서 생성기가 붙는다** — 지금은 어휘만 선언해 둔다
 * (이 union 이 나중에 넓어지면 그때 스위치문 전수가 깨진다. 어휘를 먼저 고정하는 게 싸다).
 */
export type ActionForm =
  | "direct"
  | "lead"
  | "through"
  | "switch"
  | "long"
  | "cross"
  | "carry"
  | "shoot"
  | "hold";

/**
 * 생성기 출처. **한 필드가 세 가지 일을 한다**:
 *  1. 안정 정렬 tiebreak 의 첫 키(생성 순서가 전순서로 고정된다),
 *  2. 계측 라벨(생성기별 생성/채택 분포 — "왜 안 바뀌었나"를 추측이 아니라 수치로 답하게 한다),
 *  3. (S5) config 토글의 키.
 *
 * **순서가 계약이다.** 생성은 반드시 이 배열 순서로 돈다 → 후보 배열의 초기 순서가 상태의 함수로
 * 고정되고, 노드 예산 컷오프가 항상 같은 지점에서 걸린다.
 * S5 에서 `"lead" | "through" | "cross" | "switch"` 가 **뒤에** 추가된다(앞에 끼우면 기존 순서가 밀린다).
 */
export const GENERATORS = ["shoot", "direct", "long", "carry", "hold"] as const;
export type GeneratorId = (typeof GENERATORS)[number];

/**
 * 행동 후보 하나.
 *
 * ⚠️ **지금 실제로 채울 수 있는 것만 넣었다.** 설계 초안에 있던 `ownEta/oppEta/control/behindLine/
 * receiverOnside` 는 전부 **pitch control(누가 먼저 닿나)** 과 **공유 수비 라인**을 전제로 하는데,
 * 전자는 S5, 후자는 S3 의 산출물이다. 지금 넣으면 값이 없는 필드가 되고, 값이 없는 필드는
 * 곧 "0 을 진짜 0 으로 읽는" 버그가 된다. 그래서 S3/S5 가 자기 웨이브에서 추가한다.
 */
export interface ActionCandidate {
  kind: ActionKind;
  form: ActionForm;
  gen: GeneratorId;

  /**
   * 공이 **도착할 지점**(고정소수). 사람 타깃이면 리시버 위치와 같다.
   * **좌표가 1급**이라는 것이 이 표현형의 전부다 — `receiver` 는 부가정보로 내려간다.
   */
  toXFx: number;
  toYFx: number;

  /**
   * 의도 수신자. **null 이면 순수 공간 타깃**(누가 먼저 닿나로 결정).
   * S2 의 생성기는 아직 전부 사람 타깃(pass) 또는 타깃 없음(shoot/carry/hold)이라
   * "사람은 없는데 좌표는 있는" 후보는 나오지 않는다. 그 조합을 **만들 수 있게 하는 것**이 S2 의 산출이다.
   */
  receiver: SimPlayer | null;

  /** 실행 파라미터 — 엔진이 그대로 쓴다(재계산 금지). 공이 안 나가는 행동(carry/hold)은 0. */
  ballSpeedFx: number;
  /** 공이 타깃까지 나는 데 걸리는 틱(= ceil(dist/speed)). 공이 안 나가면 0. */
  flightTicks: number;

  /**
   * 행동 완료까지 총 소요 틱.
   *
   * **시간 할인의 지수가 될 자리다.** 현재 사슬 코어의 할인은 `discount^깊이` 인 상수라,
   * "3틱 날아가는 롱볼"과 "1틱짜리 짧은 패스"가 **같은 값으로 할인된다**. 다이렉트 스피드
   * 5.69 m/s(벤치 1.4–2.1)를 노브로 못 잡은 구조적 원인이 이것이다.
   * ⚠️ **S2 는 이 필드를 채우기만 하고 소비하지 않는다** — 소비하는 순간 다이렉트 스피드가
   * 움직이고, 그건 S2 의 게이트("행동을 안 늘렸으니 지표가 안 움직여야 한다")를 정면으로 깬다.
   * 소비는 S4(국면·템포가 할인을 소유하는 웨이브)가 한다.
   */
  durationTicks: number;

  /**
   * 기하 특징 — **생성 시 1회 계산**한다. 평가에서 재계산하면 depth-2 에서 비용이 제곱된다
   * (후보 N개 × 각 후보의 재귀 N개). 상대가 하나도 없으면 `laneDangerFx = Infinity`
   * (`perception.ts:passOptions` 의 기존 관용구를 그대로 유지 — 어댑터가 값을 손대지 않는다).
   */
  laneDangerFx: number;
  /** 상대 골에 얼마나 가까워지는가(양수 = 전진), 고정소수. */
  forwardGainFx: number;
  /** 출발점 → 타깃 거리(고정소수). */
  distFx: number;

  /**
   * 원본 `PassOption`(패스 후보일 때만). `planPass`/`computePassProb` 가 이걸 그대로 받으므로
   * **weighted 경로와 같은 함수를 같은 인자로** 부를 수 있다(재구현 0 = 드리프트 0).
   * S5 의 좌표 타깃 후보는 이 필드가 `undefined` 이고, 그때 `planPass` 의 좌표 오버로드가 필요해진다.
   */
  opt?: PassOption;
}

/**
 * 정렬 tiebreak 용 **전순서** 키.
 *
 * `state.players` 배열 순서에 기대면 안 된다(퇴장이 splice 로 순서를 바꾼다, §5-3).
 * `gen` 을 맨 앞에 두는 이유: 좌표 타깃이 들어오면 `receiver` 가 전부 `null` 이라 receiver 키가
 * 변별력을 잃는다. 그때 남는 유일한 안정 축이 (생성기, 좌표)다.
 */
export function candidateKey(c: ActionCandidate): string {
  return `${c.gen}|${c.kind}|${c.receiver?.id ?? ""}|${c.toXFx}|${c.toYFx}`;
}

/**
 * `PassOption` → `ActionCandidate` 어댑터.
 *
 * **`PassOption` 은 유지한다.** weighted 경로(`decision.ts:decideBallOwner`·`selectPassOption`·
 * `scoreOption`)가 계속 쓰고, 그 경로는 골든이 곧 롤백 보장이라 한 줄도 건드리면 안 된다.
 * 그래서 사슬 코어만 이 어댑터를 통해 통합 표현형으로 흡수한다 — 두 세계가 **같은 원본 데이터**를
 * 공유하므로 기하 특징이 갈릴 여지가 없다.
 */
export function toActionCandidate(
  opt: PassOption,
  gen: GeneratorId,
  form: ActionForm,
  ballSpeedFx: number,
): ActionCandidate {
  const flightTicks = ballSpeedFx > 0 ? Math.ceil(opt.dist / ballSpeedFx) : 0;
  return {
    kind: "pass",
    form,
    gen,
    toXFx: opt.receiver.posFx.x,
    toYFx: opt.receiver.posFx.y,
    receiver: opt.receiver,
    ballSpeedFx,
    flightTicks,
    durationTicks: flightTicks,
    laneDangerFx: opt.laneDanger,
    forwardGainFx: opt.forwardGain,
    distFx: opt.dist,
    opt,
  };
}

/* ------------------------------------------------------------------------- *
 * 계측(probe)
 * ------------------------------------------------------------------------- */

/**
 * 생성기별 계측 카운터.
 *
 * 왜 필요한가: W2 실험의 교훈은 "탐색기를 바꿨는데 지표가 안 움직였다 → **왜인지 추측했다**" 였다.
 * 생성/채택 분포가 있으면 그 질문이 수치로 답해진다 — "long 이 12% 생성되는데 채택 0.3%" 처럼.
 * S5 에서 생성기를 넣고 지표가 안 움직일 때, 생성이 0인지 채택이 0인지를 **먼저** 봐야 한다.
 *
 * ⚠️ **결정론 영향 0 이어야 한다.** 그래서
 *  - 기본값 `null`(옵트인) — 켜지 않으면 코드 경로가 `if (probe)` 한 줄뿐이고,
 *  - 시뮬 로직은 이 카운터를 **절대 읽지 않는다**(쓰기 전용). 읽는 순간 관측이 상태가 된다.
 */
export interface ChainProbe {
  /** 결정 호출 수(= 볼 소유자가 사슬 코어로 행동을 고른 횟수). */
  decisions: number;
  /**
   * 생성기별 후보 생성 수(누적) — **루트에서만** 센다.
   * 재귀 안쪽 생성까지 합치면 `picked`(루트에서만 일어난다)와 자릿수가 안 맞아 "채택률"이
   * 해석 불가능해진다. 재귀를 포함한 총 비용은 `evalNodes` 가 대표한다.
   */
  generated: Record<GeneratorId, number>;
  /** 생성기별 **채택** 수(실제로 실행된 행동). */
  picked: Record<GeneratorId, number>;
  /** EV 평가 노드 수(누적) — 노드 예산이 실제로 얼마를 쓰는지. */
  evalNodes: number;
  /** 한 결정에서 만들어진 후보 수의 최댓값(= beamTop 기본값을 정할 근거). */
  maxCandidates: number;
  /** 빔(beamTop)이 실제로 후보를 잘라낸 결정 수. 0 이면 빔이 안 물린 것. */
  beamClipped: number;
  /** 재귀 빔(recurseBeam)이 실제로 잘라낸 결정 수. */
  recurseClipped: number;
  /** 노드 예산(maxNodes) 소진으로 조기 확정한 결정 수. */
  budgetHit: number;
}

export function newChainProbe(): ChainProbe {
  const zero = (): Record<GeneratorId, number> => {
    const r = {} as Record<GeneratorId, number>;
    for (const g of GENERATORS) r[g] = 0;
    return r;
  };
  return {
    decisions: 0,
    generated: zero(),
    picked: zero(),
    evalNodes: 0,
    maxCandidates: 0,
    beamClipped: 0,
    recurseClipped: 0,
    budgetHit: 0,
  };
}

let activeProbe: ChainProbe | null = null;

/** 계측 켜기/끄기(옵트인). 시뮬 결과에 영향을 주지 않는다 — 쓰기 전용 카운터다. */
export function setChainProbe(p: ChainProbe | null): void {
  activeProbe = p;
}

/** 현재 활성 계측기(없으면 null). */
export function chainProbe(): ChainProbe | null {
  return activeProbe;
}
