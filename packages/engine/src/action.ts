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
export type ActionKind = "shoot" | "pass" | "carry" | "hold" | "clear";

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
  | "hold"
  /** 걷어내기(#314 A) — 의도 수신자 없는 처리 킥. */
  | "clear";

/**
 * 생성기 출처. **한 필드가 세 가지 일을 한다**:
 *  1. 안정 정렬 tiebreak 의 첫 키(생성 순서가 전순서로 고정된다),
 *  2. 계측 라벨(생성기별 생성/채택 분포 — "왜 안 바뀌었나"를 추측이 아니라 수치로 답하게 한다),
 *  3. (S5) config 토글의 키.
 *
 * **순서가 계약이다.** 생성은 반드시 이 배열 순서로 돈다 → 후보 배열의 초기 순서가 상태의 함수로
 * 고정되고, 노드 예산 컷오프가 항상 같은 지점에서 걸린다.
 * S5 에서 `"lead" | "through" | "cross" | "switch"` 가 **뒤에** 추가된다(앞에 끼우면 기존 순서가 밀린다).
 * #314 A 가 `"clear"`(걷어내기)를 그 규율대로 **뒤에** 붙였다.
 * #377 M3-C 가 `"through"`(공간 타깃 스루패스)를 같은 규율대로 **맨 뒤에** 붙였다.
 */
export const GENERATORS = ["shoot", "direct", "long", "carry", "hold", "clear", "through"] as const;
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
    // #377 M3-C: **좌표가 1급이라는 S2 의 산출이 여기서 처음 쓰인다.** 발밑 패스면 리시버 위치와
    // 같고(기존과 bit-identical), 공간 타깃이면 라인 뒤 조준점이다 — `receiver` 는 "누구를 위한
    // 패스인가"로 남고 `toXFx/toYFx` 가 "공이 어디로 가나"를 소유한다.
    toXFx: opt.aimFx ? opt.aimFx.x : opt.receiver.posFx.x,
    toYFx: opt.aimFx ? opt.aimFx.y : opt.receiver.posFx.y,
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
  /**
   * **재시작 틱**으로 판정돼 킥 후보만 생성한 결정 수(#349). 이 틱에는 `carry`/`hold` 생성기가
   * 아예 안 돌므로, "매 결정마다 carry·hold 각 1개"라는 자릿수 계약이 여기만큼 어긋난다
   * (`chain-search.test.ts` 가 그 관계식을 그대로 검증한다).
   */
  restarts: number;
}

export function newChainProbe(): ChainProbe {
  const zero = (): Record<GeneratorId, number> => {
    const r = {} as Record<GeneratorId, number>;
    for (const g of GENERATORS) r[g] = 0;
    return r;
  };
  return {
    restarts: 0,
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

/**
 * 볼 소유자 **결정 관측자**(진단 전용, 옵트인) — `ChainProbe` 와 같은 규율의 두 번째 계측 포인트.
 *
 * 왜 별도인가: `ChainProbe` 는 사슬 코어(`chain.ts`) **안**에서 생성기 라벨을 세므로
 *  (a) `chain.mode="weighted"` 대조군을 못 재고,
 *  (b) 결정 **당시의 상태**(누가 어디 서 있었나)를 볼 수 없다.
 * "기하 조건이 성립한 틱에서 엔진이 실제로 무엇을 골랐나"를 재려면 두 정보가 같은 지점에서
 * 필요하다. 그래서 관측 지점은 `match.ts` 의 `decide` 직후 — **두 코어가 합류하고 실행 직전**이라
 * 상태가 결정 시점 그대로다(이동·경합 전).
 *
 * ⚠️ **결정론 영향 0.**
 *  - 기본값 `null`(옵트인). 프로덕션 경로는 `if (obs)` 한 줄이다.
 *  - 시뮬 로직은 이 훅의 반환값을 **읽지 않는다**(void). 관측이 상태가 되지 않는다.
 *  - 관측자는 상태를 **읽기만** 해야 한다(쓰면 그 순간 결정론이 깨진다 — 진단자의 책임).
 */
export type DecisionObserver = (
  state: unknown,
  owner: SimPlayer,
  kind: ActionKind | "dribble" | "clearance",
) => void;

let activeDecisionObserver: DecisionObserver | null = null;

/** 결정 관측 켜기/끄기(옵트인). 켜고 끄는 것이 시뮬 결과를 바꾸지 않는다. */
export function setDecisionObserver(o: DecisionObserver | null): void {
  activeDecisionObserver = o;
}

/** 현재 활성 결정 관측자(없으면 null). */
export function decisionObserver(): DecisionObserver | null {
  return activeDecisionObserver;
}

/**
 * **피로 관측자**(#346, 진단 전용·옵트인) — `DecisionObserver` 와 같은 규율.
 *
 * 왜 필요한가: `fatigue` 는 스냅샷·이벤트 **어디에도 노출되지 않는다**. 그래서 "경기의 79% 가
 * 전원 fatigue = 1.0" 이라는 사실이 로그 어디에서도 안 보였고, 그게 #346 이 이렇게 오래 안 잡힌
 * 이유다. 계약이 이 성질을 지키려면 곡선을 읽을 창이 하나는 있어야 한다.
 *
 * ⚠️ 결정론 영향 0: 기본 null(옵트인) · 반환값을 시뮬이 읽지 않는다 · 관측자는 읽기만 해야 한다.
 * 매 틱 **끝**(applyFatigue 직후)에 그 틱의 (선수, 피로) 를 흘려보낸다.
 */
export type FatigueObserver = (tick: number, samples: { id: string; side: string; isGK: boolean; fatigue: number }[]) => void;

let activeFatigueObserver: FatigueObserver | null = null;

/** 피로 관측 켜기/끄기(옵트인). 켜고 끄는 것이 시뮬 결과를 바꾸지 않는다. */
export function setFatigueObserver(o: FatigueObserver | null): void {
  activeFatigueObserver = o;
}

/** 현재 활성 피로 관측자(없으면 null). */
export function fatigueObserver(): FatigueObserver | null {
  return activeFatigueObserver;
}

/**
 * **예고 읽기 관측자**(#369, 진단 전용·옵트인) — `FatigueObserver` 와 같은 규율·같은 이유.
 *
 * 왜 필요한가: 누가 예고를 **읽었는가**는 스냅샷·이벤트 어디에도 안 나온다. 그런데 이 웨이브의
 * AC 는 정확히 "읽은 리시버가 먼저 움직인다"라서, 읽은 쪽과 안 읽은 쪽을 **가르지 못하면**
 * 관찰량이 반사실 팔(`readBase=1` 로 경기 전개를 통째로 바꾼 config)로 밀려난다 — 독립검증 m1 이
 * 지적한 것이 그것이다. 여기서 읽기 판정을 그대로 흘려보내면 **출하 config 그대로** 두 표본을
 * 가를 수 있다(신호도 6.6배로 훨씬 크다).
 *
 * ⚠️ 판정식을 진단 쪽에서 **다시 구현하지 않는다**는 것이 핵심이다 — 그러면 계약이 구현과
 * 조용히 갈린다(이 리포가 `loft.ts`·`jitter.ts` 에서 지켜 온 "측정 함수 공유" 규율).
 *
 * ⚠️ 결정론 영향 0: 기본 null(옵트인) · 반환값을 시뮬이 읽지 않는다 · 관측자는 읽기만 해야 한다.
 */
export type PlanReadObserver = (sample: {
  tick: number;
  side: string;
  /** 예고 대상(리시버) id. */
  forId: string;
  /** 그 예고가 게시된 틱(수명 판정의 기준). */
  planTick: number;
  /** 도착 예정 지점(고정소수). */
  xFx: number;
  yFx: number;
  /** 이 틱에 실제로 읽었는가. */
  read: boolean;
}) => void;

let activePlanReadObserver: PlanReadObserver | null = null;

/** 예고 읽기 관측 켜기/끄기(옵트인). 켜고 끄는 것이 시뮬 결과를 바꾸지 않는다. */
export function setPlanReadObserver(o: PlanReadObserver | null): void {
  activePlanReadObserver = o;
}

/** 현재 활성 예고 읽기 관측자(없으면 null). */
export function planReadObserver(): PlanReadObserver | null {
  return activePlanReadObserver;
}

/**
 * **패스 조준 관측자**(#377 M3-C, 진단 전용·옵트인) — 위 관측자들과 같은 규율.
 *
 * 왜 필요한가: 이 웨이브의 AC 는 *"리드 거리 분포가 이동한다 — 10~25m 구간 후보가 실제로
 * 뽑힌다"* 다. 그런데 로그에는 **조준점이 없다** — `pass` 이벤트는 도착 틱에 리시버 id 로
 * 발행되고(`resolveArrival`), 스냅샷에는 공 좌표뿐이다. 로그로 되추론하면 실제 도달점(오차·
 * 굴러간 거리 포함)을 재게 되는데, 그건 "무엇을 골랐나"가 아니라 "어떻게 끝났나"라 다른 질문이다.
 *
 * 그래서 **결정 직후 계획 조준점**을 그대로 흘려보낸다. 이 창이 있어야 계약과 증거가
 * **출하 config 한 경기 안에서** through 팔과 발밑 팔을 가를 수 있다(M3-A 독립검증 m1 의 교훈 —
 * `enabled:false` 반사실 팔로 재면 경기 전개 자체가 다르다).
 *
 * ⚠️ 결정론 영향 0: 기본 null(옵트인) · 반환값을 시뮬이 읽지 않는다 · 관측자는 읽기만 해야 한다.
 */
export type PassAimObserver = (sample: {
  tick: number;
  side: string;
  /** 어느 생성기가 낸 후보였나 — `"through"` 가 공간 타깃이다. */
  gen: GeneratorId;
  form: ActionForm;
  passerId: string;
  receiverId: string;
  /** **리드 거리**(fixed): 발사 틱 리시버 위치 → 계획 조준점. 발밑 패스면 leadAim 거리다. */
  leadFx: number;
  /** 패서 → 계획 조준점 거리(fixed). */
  distFx: number;
  /** 계획 조준점(fixed). */
  aimXFx: number;
  aimYFx: number;
  /** 조준점이 상대 오프사이드 라인 뒤인가(`through.ts:offsideLineProg` 와 같은 자). */
  behindLine: boolean;
  /** 경주 계수(공간 타깃만). 발밑 패스는 null. */
  raceFrac: number | null;
}) => void;

let activePassAimObserver: PassAimObserver | null = null;

/** 패스 조준 관측 켜기/끄기(옵트인). 켜고 끄는 것이 시뮬 결과를 바꾸지 않는다. */
export function setPassAimObserver(o: PassAimObserver | null): void {
  activePassAimObserver = o;
}

/** 현재 활성 패스 조준 관측자(없으면 null). */
export function passAimObserver(): PassAimObserver | null {
  return activePassAimObserver;
}

/**
 * **수비 레인 예측 관측자**(#379 M3-B, 진단 전용·옵트인) — 위 관측자들과 같은 규율.
 *
 * 왜 필요한가: 이 웨이브의 판정은 *"출하 config 에서 레인을 **읽은** 수비수가 안 읽은 수비수보다
 * 레인으로 실제로 다가간다"* 인데, **누가 읽었는지는 스냅샷·이벤트 어디에도 없다**(M3-A 가
 * `setPlanReadObserver` 를 만든 것과 같은 이유). 게다가 **어느 레인을 읽었는지**(선분 두 끝점)를
 * 로그에서 되추론할 방법이 없다 — 그건 인지 기억(`player.seen`)의 함수라 관측 시점에만 존재한다.
 *
 * 판정식을 진단이 다시 구현하지 않는 것이 핵심이다. 여기서 흘려보내는 것은 **엔진이 실제로 쓴
 * 값**이고, 계약·증거는 그 위에서 다음 틱 실제 위치만 재면 된다(같은 자[尺] = `laneClosest`).
 *
 * ⚠️ 결정론 영향 0: 기본 null(옵트인) · 반환값을 시뮬이 읽지 않는다 · 관측자는 읽기만 해야 한다.
 */
export type LaneReadObserver = (sample: {
  tick: number;
  side: string;
  /** 레인을 읽은(또는 읽지 못한) 수비수. */
  playerId: string;
  /** 그 수비수의 인지 능력 (positioning+mental)/2. */
  attr: number;
  /** 읽기 판정 — false 면 이 틱에 이 레인을 선점하지 않는다(대조군). */
  read: boolean;
  /** 레인 시작(공=캐리어 위치) fixed. */
  fromXFx: number;
  fromYFx: number;
  /** 레인 끝(**인지한** 위협 리시버의 마지막 본 위치) fixed. */
  toXFx: number;
  toYFx: number;
  /** 그 리시버 id. */
  toId: string;
  /** 지금 내 위치에서 레인까지 최단거리(fixed). */
  laneDistFx: number;
  /**
   * 그 레인에 대한 **수비 팀 전체의 최근접 거리**(fixed) = `perception.ts:laneDangerOn`.
   * AC 의 "레인 점유"가 쓰는 자[尺] 그대로다 — 개인이 다가갔는지가 아니라 **레인이 실제로
   * 막혔는지**를 같은 함수로 본다. 이 값은 `readLane` 의 "이미 막힌 레인엔 겹치지 않는다" 게이트가
   * **이미 계산한 것**을 그대로 흘린 것이다(진단이 다시 재면 두 정의가 갈릴 수 있다).
   */
  laneDangerFx: number;
  /** 이번 틱 목표에 더한 선점 이동량(fixed). 안 읽었으면 0. */
  stepFx: number;
}) => void;

let activeLaneReadObserver: LaneReadObserver | null = null;

/** 레인 예측 관측 켜기/끄기(옵트인). 켜고 끄는 것이 시뮬 결과를 바꾸지 않는다. */
export function setLaneReadObserver(o: LaneReadObserver | null): void {
  activeLaneReadObserver = o;
}

/** 현재 활성 레인 예측 관측자(없으면 null). */
export function laneReadObserver(): LaneReadObserver | null {
  return activeLaneReadObserver;
}

/**
 * **압박 유닛 관측자**(#377 S3-A, 진단 전용·옵트인) — 위 셋과 같은 규율·같은 이유.
 *
 * 왜 필요한가: **누가 압박 유닛에 배정됐는지는 스냅샷·이벤트 어디에도 안 나온다.** 좌표에서
 * 역할을 되추론하면 이 트랙이 이미 물린 함정을 다시 밟는다 — #378 이 벽/백업을 좌표로 되추론했다가
 * 백업 2/3 을 벽으로 오분류해 "9.15m 침범 566건"이라는 **가짜 위반**을 만들었다(1m 차이가 계측을
 * 속였다). 그래서 그때와 같은 처방을 쓴다: **배정한 쪽이 역할 라벨을 단다.**
 *
 * 두 종류를 흘린다(질문이 다르다):
 *  - `kind:"unit"` — 그 틱 그 팀의 **배정 총원**과 위험거리. **인원 0 인 틱도 나온다**(중요:
 *    멤버 샘플만 모으면 0 인 틱이 표본에서 빠져 평균이 위로 편향된다).
 *  - `kind:"member"` — 배정된 개인의 역할·최종 목표. `ballDistFx` 가 **목표 오염**(#303 마지막 항)의
 *    직접 관찰량이다.
 *
 * ⚠️ 결정론 영향 0: 기본 null(옵트인) · 반환값을 시뮬이 읽지 않는다 · 관측자는 읽기만 해야 한다.
 */
export type PressUnitSample =
  | {
      kind: "unit";
      tick: number;
      side: string;
      /** 위험거리(fixed) = 공→우리 골 + wideWeight × 횡오프셋. */
      dangerFx: number;
      /** 그 팀의 압박 강도 슬라이더(0..1). */
      intensity: number;
      /** 배정 총원(압박 담당 + 커버). 0 = 아무도 안 나간다(트리거 게이트 등). */
      count: number;
      /** 그중 커버 수. */
      coverCount: number;
      /** 유닛이 legacy 경로인가(= `press.unit.enabled=false`). */
      legacy: boolean;
      /**
       * **생성 게이트 계측** — "커버가 왜 안 뽑혔나"를 추측이 아니라 수치로 답한다
       * (M3-C `ThroughProbe.gates` 와 같은 목적·같은 형태). 이 웨이브의 초판이 정확히 이것
       * 때문에 헛돌았다: 커버가 팀-틱의 2.4% 에서만 생겨서 지표가 안 움직였는데, 계측이 없으면
       * 어느 문이 닫혔는지 못 본다.
       */
      gates: {
        /** 사거리 안 커버 후보 수비수. */
        cands: number;
        /** 막을 값이 있다고 판정된 레인 수. */
        lanes: number;
        /** 원하는 커버 수(= 총원 − 1). */
        want: number;
        /** 전진 이득 부족으로 버린 상대. */
        rejGain: number;
        /** 이미 막혀 있어서(`coveredM`) 버린 레인. */
        rejCovered: number;
        /** 레인이 사거리(`reachM`) 밖이라 버린 (수비수,레인) 쌍. */
        rejReach: number;
        /** 가치 ≤ 0 이라 버린 쌍. */
        rejVal: number;
      };
    }
  | {
      kind: "member";
      tick: number;
      side: string;
      playerId: string;
      role: "presser" | "cover" | "support";
      /** 이 선수의 **최종 목표**에서 공까지 거리(fixed). 압박 담당은 0 이어야 한다(오염 없음). */
      ballDistFx: number;
      /** 커버가 맡은 레인의 리시버 id(압박 담당·지원은 null). */
      laneToId: string | null;
      /** 배정 시점 그 구성원에서 목표 지점까지 거리(fixed). 압박 담당은 0. */
      laneDistFx: number;
    };

export type PressUnitObserver = (sample: PressUnitSample) => void;

let activePressUnitObserver: PressUnitObserver | null = null;

/** 압박 유닛 관측 켜기/끄기(옵트인). 켜고 끄는 것이 시뮬 결과를 바꾸지 않는다. */
export function setPressUnitObserver(o: PressUnitObserver | null): void {
  activePressUnitObserver = o;
}

/** 현재 활성 압박 유닛 관측자(없으면 null). */
export function pressUnitObserver(): PressUnitObserver | null {
  return activePressUnitObserver;
}

/**
 * **수비 형태 관측**(#377 S3-B) — 공유 수비 라인 · 오픈플레이 레스트디펜스.
 *
 * S3-A 와 같은 처방을 쓴다: **배정한 쪽이 역할 라벨을 단다.** #378 이 벽/백업을 좌표로 되추론했다가
 * 가짜 위반 566건을 만든 전례가 있고, 여기서는 그 위험이 더 크다 — "라인 멤버"와 "그냥 뒤에 있는
 * 선수"는 좌표만으로 구분되지 않는다(둘 다 자기 진영에 서 있다).
 *
 * 네 종류를 흘린다(질문이 다르다):
 *  - `kind:"line"` — 그 틱 그 팀의 라인 요약. **멤버 0/미달 틱도 나온다**(안 그러면 "라인이 안
 *    잡힌 틱"이 표본에서 빠져 발화율을 과대평가한다 — S3-A `kind:"unit"` 과 같은 이유).
 *  - `kind:"lineMember"` — 보정 전/후/목표 진행도. **`before`↔`after` 가 L2 의 직접 관찰량**이고,
 *    `desired` 와의 차이가 `lineDiscipline` 이 실제로 걸렸는지를 말한다.
 *  - `kind:"rest"` — 그 틱 그 팀의 잔류 배정 요약(요청 인원 vs 실제 배정).
 *  - `kind:"restMember"` — 잔류 개인의 상한 적용 전/후. `capped` 가 **"상한이 물었나"** 의 직접 관찰량.
 *
 * ⚠️ 결정론 영향 0: 기본 null(옵트인) · 반환값을 시뮬이 읽지 않는다 · 관측자는 읽기만 해야 한다.
 */
export type DefShapeSample =
  | {
      kind: "line";
      tick: number;
      side: string;
      /** 라인 멤버 수. `minMembers` 미달이면 보정이 안 걸리고 이 값만 나온다. */
      members: number;
      /** 압박 유닛이 데려가 라인에서 빠진 인원(진단 — 멤버가 왜 적은지의 답). */
      excludedByUnit: number;
      /** 보정이 실제로 걸렸나(`enabled` · `minMembers` · `lineDiscipline>0` 전부 통과). */
      applied: boolean;
      /** 기준선 진행도(fixed, 자기 골 0). */
      refProgFx: number;
      /** 라인 높이 가감량(fixed) — `defensiveLineHeight` 슬라이더의 실권한. */
      heightBiasFx: number;
      /** 보정 **전** 멤버 진행도 산포(fixed, max−min). */
      beforeSpreadFx: number;
      /** 보정 **후** 산포(fixed). */
      afterSpreadFx: number;
    }
  | {
      kind: "lineMember";
      tick: number;
      side: string;
      playerId: string;
      /** 보정 전 목표 진행도(fixed). */
      beforeProgFx: number;
      /** 보정이 겨냥한 진행도(fixed) = 기준선 + 역할 오프셋. */
      desiredProgFx: number;
      /** 보정 후 목표 진행도(fixed). */
      afterProgFx: number;
      /**
       * 이 틱 **실제 위치**의 진행도(fixed).
       *
       * ⚠️ 이게 없으면 이 계약이 **동어반복**이 된다 — 목표만 보면 "보정이 목표를 모았다"는 정의상
       * 참이다. 실제로 답해야 하는 질문은 "그래서 **선수들이** 한 줄에 서는가"이고, 그건 위치로만
       * 답할 수 있다(#377 M2 `wallClearM` 이 정확히 이 함정에 빠졌다).
       */
      posProgFx: number;
    }
  | {
      kind: "rest";
      tick: number;
      side: string;
      /** 가담도 매핑이 요청한 잔류 인원. */
      want: number;
      /** 실제로 잔류로 배정된 인원. */
      assigned: number;
      /** 그중 상한에 실제로 걸린 인원. */
      capped: number;
    }
  | {
      kind: "restMember";
      tick: number;
      side: string;
      playerId: string;
      /** 상한 적용 전 목표 진행도(fixed). */
      beforeProgFx: number;
      /** 적용 후(fixed). */
      afterProgFx: number;
      /** 상한이 실제로 물었나. */
      capped: boolean;
    };

export type DefShapeObserver = (sample: DefShapeSample) => void;

let activeDefShapeObserver: DefShapeObserver | null = null;

/** 수비 형태 관측 켜기/끄기(옵트인). 켜고 끄는 것이 시뮬 결과를 바꾸지 않는다. */
export function setDefShapeObserver(o: DefShapeObserver | null): void {
  activeDefShapeObserver = o;
}

/** 현재 활성 수비 형태 관측자(없으면 null). */
export function defShapeObserver(): DefShapeObserver | null {
  return activeDefShapeObserver;
}
