import type { SimState, TeamPhase, Intent, SetPiece, DeferredRestart } from "./simstate";

/** 문자열 열거를 해시에 넣기 위한 고정 코드(값은 바뀌면 안 된다 — 골든이 움직인다). */
const PHASE_CODE: Record<TeamPhase, number> = {
  open: 1,
  build: 2,
  progress: 3,
  final_third: 4,
  transition_win: 5,
  transition_lose: 6,
};
// ⚠️ 이 Record 는 **전수(exhaustive)** 다 — 의도 종류를 늘리면 여기서 컴파일이 깨진다.
// 그게 의도다: 해시에 안 들어간 상태는 desync 를 조용히 만든다.
const INTENT_CODE: Record<Intent["kind"], number> = { pass_to: 1, run_to: 2, cross_from: 3, pass_plan: 4 };
/** 공 비행 종류 코드(#306). 0 = 비행 없음. */
const FLIGHT_KIND_CODE: Record<"pass" | "shot" | "loose", number> = { pass: 1, shot: 2, loose: 3 };
// ⚠️ 위와 같은 전수 Record(#377 M3-A 2R). 세트피스 종류를 늘리면 여기서 컴파일이 깨진다 =
// "해시에 넣을 코드를 정하라"는 신호다. 0 은 `setPiece === null` 센티넬이라 쓰지 않는다.
const SET_PIECE_CODE: Record<SetPiece["kind"], number> = {
  corner: 1,
  throw_in: 2,
  goal_kick: 3,
  kickoff: 4,
  goal: 5,
  free_kick: 6,
  penalty: 7,
  shot_out: 8,
};
/** 지연 재시작 종류 코드. 0 = `restart` 없음 센티넬. */
const DEFERRED_RESTART_CODE: Record<DeferredRestart["kind"], number> = { corner: 1, goal_kick: 2, penalty: 3 };

/**
 * hash — 틱 상태 해시(FNV-1a, 32bit 정수).
 * 공/선수 좌표(fixed) + 소유 + 스코어를 정수 스트림으로 직렬화해 해시한다.
 * 재현/desync 검증에 쓰인다(동일 입력 → 동일 해시).
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** 짧은 식별자 문자열(`H9`·`A11`)을 32bit 정수로 — 해시에만 쓴다(결정론: 순수 함수). */
function strCode(v: string | undefined): number {
  if (!v) return 0;
  let x = 2166136261;
  for (let i = 0; i < v.length; i++) {
    x ^= v.charCodeAt(i) & 0xff;
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

function mix(h: number, v: number): number {
  // 32bit 정수 v 를 4바이트로 흡수.
  let x = h;
  x ^= v & 0xff;
  x = Math.imul(x, FNV_PRIME);
  x ^= (v >>> 8) & 0xff;
  x = Math.imul(x, FNV_PRIME);
  x ^= (v >>> 16) & 0xff;
  x = Math.imul(x, FNV_PRIME);
  x ^= (v >>> 24) & 0xff;
  x = Math.imul(x, FNV_PRIME);
  return x >>> 0;
}

/**
 * 결정론 틱 해시. 선수는 id 정렬 순으로 좌표를 흡수(순서 독립성 보장).
 * 반환은 8자리 16진 문자열.
 */
export function hashState(state: SimState): string {
  let h = FNV_OFFSET >>> 0;
  h = mix(h, state.tick | 0);
  h = mix(h, state.score.home | 0);
  h = mix(h, state.score.away | 0);
  h = mix(h, state.ball.posFx.x | 0);
  h = mix(h, state.ball.posFx.y | 0);
  h = mix(h, state.possession === "home" ? 1 : 2);
  // #306: 비행 상태(종류·전달·속도·목표)를 흡수한다. 이 값들은 재개로 관통하는데 해시에
  // 없으면 유실돼도 그 틱은 통과하고 **다음 틱부터** 갈라진다(로드맵 §5-6). 특히 `delivery` 는
  // 도착 판정을 지상/공중으로 가르므로 유실이 곧 다른 경기다.
  const fl = state.ball.flight;
  h = mix(h, fl ? FLIGHT_KIND_CODE[fl.kind] : 0);
  if (fl) {
    h = mix(h, fl.delivery === "lofted" ? 2 : 1);
    h = mix(h, fl.speed | 0);
    h = mix(h, fl.toX | 0);
    h = mix(h, fl.toY | 0);
    // #320: **속도 벡터가 운동의 권위**다 — 재개로 관통하는 상태 중 가장 중요한 두 값이다.
    // 해시에 없으면 유실돼도 그 틱은 통과하고 다음 틱부터 공이 다른 방향으로 날아간다
    // (로드맵 §5-6 · #154 와 같은 무음 desync 함정). `speed` 는 파생값이라 이걸 대신 못 한다.
    h = mix(h, fl.vxFx | 0);
    h = mix(h, fl.vyFx | 0);
    // #327: `hangTicks` 는 이제 **소비되는 체공 예산**이다(장식값이 아니라 착지 시점의 권위).
    // 유실되면 재개 시 떠 있던 공이 다른 틱에 떨어진다 — 마찰이 갈리고 헤딩 경합 시점도 갈린다.
    h = mix(h, fl.hangTicks ?? 0);
  }
  // #279 S1: 해시에 **없는** 상태가 유실되면 그 틱은 통과하고 다음 틱부터 갈라진다(무음 desync).
  // 그래서 재개로 관통하는 상태는 **전부** 흡수한다. 비용은 mix 몇 줄이고, 얻는 것은
  // "해시는 맞는데 상태가 유실된" 조용한 구간의 제거다(#154 로 한 번 밟은 함정).
  //
  // ⚠️ 초판 주석은 "lastTurnover 는 possessionSince 와 같은 지점에서만 갱신되므로 뺀다"였는데
  //    **그 문장은 거짓이었다** — 독립 검증 계측(데모 1경기): possessionSince 유효 갱신 389회
  //    (turnover 281 + restart 102 + goal 5 + kickoff 1) vs lastTurnover 갱신 281회.
  //    두 필드는 서로 다른 지점 집합에서 갱신된다. 그대로 뒀다면 S4 가 lastTurnover 로
  //    카운터프레스를 트리거하는 순간, 이 필드를 흘리는 경로에서 무음 desync 가 났다.
  h = mix(h, state.possessionSince | 0);
  h = mix(h, state.plan.home.lineX | 0);
  h = mix(h, state.plan.away.lineX | 0);
  // blockDepth 는 실수라 정수화해서 흡수(좌표와 같은 규율).
  h = mix(h, Math.round(state.plan.home.blockDepth * 1e6) | 0);
  h = mix(h, Math.round(state.plan.away.blockDepth * 1e6) | 0);
  // null 은 0 센티넬. 있으면 side/tick/좌표를 전부 흡수.
  const lt = state.lastTurnover;
  h = mix(h, lt ? 1 : 0);
  if (lt) {
    h = mix(h, lt.side === "home" ? 1 : 2);
    h = mix(h, lt.tick | 0);
    h = mix(h, lt.xFx | 0);
    h = mix(h, lt.yFx | 0);
  }
  // S4/S5 가 소비할 자리. S1 에서는 phase 가 항상 "open", intents 는 항상 비어 있다 —
  // 그래도 **지금** 해시에 넣어야 그 스테이지에서 골든을 다시 움직이지 않는다.
  h = mix(h, PHASE_CODE[state.phase.home]);
  h = mix(h, PHASE_CODE[state.phase.away]);
  h = mix(h, state.intents.length | 0);
  for (const it of state.intents) {
    h = mix(h, INTENT_CODE[it.kind]);
    h = mix(h, it.xFx | 0);
    h = mix(h, it.yFx | 0);
    h = mix(h, it.expiresTick | 0);
    // ⚠️ `side`·`forId` 도 섞는다(#369, 독립검증 m3). 예고 패스가 들어오면서 **누구에게 붙은
    // 의도인가가 동작을 결정하는 상태**가 됐다 — `forId` 가 다르면 다음 틱에 움직이는 선수가
    // 달라진다. 해시에 없으면 그 값만 어긋난 상태가 **그 틱은 통과하고 다음 틱부터 갈라진다**
    // (바로 아래 `runOrder` 주석이 같은 이유를 적어 뒀다). 문자열은 정수 스트림으로 흡수한다.
    h = mix(h, it.side === "home" ? 1 : 2);
    h = mix(h, strCode(it.forId));
  }

  // ⚠️ **데드볼 상태**(#377 M3-A 2R). `stoppage`·`setPiece` 는 재개로 관통하는데 **해시에 한 번도
  // 들어간 적이 없었다** — 하프 경계가 정지 중이면(스로인·프리킥·골 세리머니) 그 상태가 유실돼도
  // 그 틱은 통과하고 **다음 틱부터** 갈라진다. `possessionSince`/`runOrder`/`hangTicks` 가 각각
  // 밟은 것과 **정확히 같은 함정**이고(#154 계열), 그것들을 하나씩 메워 온 이 파일의 규율은
  // "재개로 관통하는 상태는 전부 흡수한다"이다. 데드볼 가족을 여기서 닫는다.
  // (일부만 넣으면 더 나쁘다 — 커버된 줄 알고 `x/y/restart` 유실을 못 잡는다. 그래서 전부다.)
  // ⚠️ **여기가 닫는 것은 데드볼 가족뿐이다** — 이 해시는 재개 상태의 전수 커버가 아니다.
  // 미포함이 확인된 것(독립검증 3R 변이체 스캔 실측, 전부 조작해도 해시가 안 갈린다):
  //   · `teams`(TeamInput)·`seedHash` — **경기 내내 상수**인 입력(재개 요청이 다시 실어 준다)
  //   · `ball.owner`·`ball.ownerSide`·`player.markTarget`·`dribbleStreak`·`seen`·`sentOff`·`yellow`
  // 이것들이 위험하지 않은 이유는 두 겹이다: ①전부 **서버 스키마에 있어** 왕복 등가성 계약
  // (`resume-roundtrip.test.ts` 의 전체 deep-equal)이 직접 본다 ②매 틱 소비되는 값이라 유실되면
  // **다음 틱 동작이 갈려** 해시 체인이 결국 잡는다(해시가 놓치는 것은 "그 틱 하나"뿐이다).
  // 그래도 **커버리지를 과대평가하지 말 것** — 초판 주석은 "안 닫힌 가족이 하나 남는다"라고 적어
  // 다음 사람이 나머지를 닫힌 것으로 오해할 수 있었다(3R minor n3R-1).
  h = mix(h, state.stoppage | 0);
  const sp = state.setPiece;
  h = mix(h, sp ? SET_PIECE_CODE[sp.kind] : 0);
  if (sp) {
    h = mix(h, sp.side === "home" ? 1 : 2);
    h = mix(h, sp.x | 0);
    h = mix(h, sp.y | 0);
    const r = sp.restart;
    h = mix(h, r ? DEFERRED_RESTART_CODE[r.kind] : 0);
    if (r) {
      h = mix(h, r.side === "home" ? 1 : 2);
      // nearY 는 corner 변형에만 있다(다른 변형은 0 센티넬).
      h = mix(h, r.kind === "corner" ? r.nearY | 0 : 0);
    }
  }

  // id 정렬 사본으로 순서 독립.
  const sorted = [...state.players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of sorted) {
    h = mix(h, p.posFx.x | 0);
    h = mix(h, p.posFx.y | 0);
    h = mix(h, Math.round(p.fatigue * 1e6) | 0);
    // #314 B: 런 오더는 재개로 관통하는 상태다 — 해시에 없으면 유실돼도 그 틱은 통과하고
    // **다음 틱부터** 갈라진다(로드맵 §5-6). 0 = 런 없음 센티넬.
    const ro = p.runOrder;
    h = mix(h, ro ? 1 : 0);
    if (ro) {
      h = mix(h, ro.xFx | 0);
      h = mix(h, ro.yFx | 0);
      h = mix(h, ro.untilTick | 0);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
