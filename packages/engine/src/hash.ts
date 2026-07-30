import type { SimState, TeamPhase, Intent } from "./simstate";

/** 문자열 열거를 해시에 넣기 위한 고정 코드(값은 바뀌면 안 된다 — 골든이 움직인다). */
const PHASE_CODE: Record<TeamPhase, number> = {
  open: 1,
  build: 2,
  progress: 3,
  final_third: 4,
  transition_win: 5,
  transition_lose: 6,
};
const INTENT_CODE: Record<Intent["kind"], number> = { pass_to: 1, run_to: 2, cross_from: 3 };
/** 공 비행 종류 코드(#306). 0 = 비행 없음. */
const FLIGHT_KIND_CODE: Record<"pass" | "shot" | "loose", number> = { pass: 1, shot: 2, loose: 3 };

/**
 * hash — 틱 상태 해시(FNV-1a, 32bit 정수).
 * 공/선수 좌표(fixed) + 소유 + 스코어를 정수 스트림으로 직렬화해 해시한다.
 * 재현/desync 검증에 쓰인다(동일 입력 → 동일 해시).
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

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
  }

  // id 정렬 사본으로 순서 독립.
  const sorted = [...state.players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of sorted) {
    h = mix(h, p.posFx.x | 0);
    h = mix(h, p.posFx.y | 0);
    h = mix(h, Math.round(p.fatigue * 1e6) | 0);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
