import { describe, it, expect } from "vitest";
import { runMatch, defaultEngineConfig, makeTacticalInput, makeSelectData } from "@hmb/engine";
import type { TacticalInput } from "@hmb/shared";
import { DIRECTIVES } from "./directives/index.js";

/**
 * 광고 ↔ 실효 감사 (#367 / 에픽 #360) — <b>프롬프트가 광고하는 필드가 실제로 경기를 바꾸는가</b>.
 *
 * <p>왜 필요한가: 이 리포가 같은 함정에 세 번 빠졌다(#321 GK 능력치 · #337 stamina · #338 죽은 노브).
 * 공통 형태는 "계약·프롬프트·UI 는 완비인데 <b>엔진 소비자가 0</b>" 이고, 그동안 LLM 은 그 필드에
 * 매 호출 토큰을 쓴다. 그래서 판정 기준은 <b>참조가 있다</b>가 아니라 <b>값을 바꾸면 경기가 달라진다</b>
 * 다(#360 전역 AC 1) — 정적 grep 이면 "조회는 하지만 확률식엔 안 들어가는" #321 을 그대로 통과시킨다.
 *
 * <p>계약 형태: 아래 {@link KNOWN_DEAD} 가 "광고 중이지만 아직 안 살린 필드"의 <b>전량</b>이다.
 * 어느 쪽으로 어긋나도 깨진다 —
 * <ul>
 *   <li>새 필드가 소비자 0 인 채로 광고되기 시작하면 → 목록에 없어서 실패(재발 차단).</li>
 *   <li>T1/T3/T5 가 배선을 넣어 살아나면 → 목록에 남아 있어서 실패(⚠️ 주석·목록을 걷으라는 신호).</li>
 * </ul>
 * 즉 이 테스트는 <b>죽은 필드를 지금 지우라는 게 아니라</b>, 광고와 실물이 조용히 갈라지지 않게
 * 묶어 둔다(#338 이 `config.ts` 에 단 ⚠️ 주석의 실행 가능한 버전).
 */

/** 광고 중인 필드 → 지금 이 값을 바꾸면 경기가 달라지는가. */
type Verdict = "effective" | "dead";

/**
 * 광고 중이지만 <b>엔진 소비자가 0</b> 인 필드 — 각 항목은 살릴 웨이브(SoT)를 달고 있다.
 * 여기 있는 동안 프롬프트의 해당 문구는 <b>사실이 아니다</b>. 비우는 것이 목표다.
 */
const KNOWN_DEAD: Record<string, string> = {
  // #360 T1(#361) — 한 줄 배선 3종. 살리면 overlap.ts·tempo-control.ts·press-trigger.ts 의 광고가 사실이 된다.
  "team.width": "#361 (T1)",
  "team.pressingScheme.triggerLine": "#361 (T1)",
  "players[].behavior.passDirectness": "#361 (T1) — decision.ts:375 에 참조는 있으나 chain 모드에선 그 경로가 안 돈다",
  // #360 T3(#363) — 격려·질책의 종점. 살리지 않기로 하면 프롬프트·계약에서 빼야 한다(방치가 최악).
  "players[].mentalModifier": "#363 (T3, ⚠️ 게임 설계 판단)",
  // #360 T5(#366) — 배선하거나 계약에서 빼거나.
  "players[].duty": "#366 (T5)",
};

const sel = makeSelectData();
/** 1차 판정 = 6분 경기 1시드(빠름). '무효'로 보이면 2차(다른 시드 + 긴 경기)로 재확인 — 오탐 방지. */
const SHORT = { ...defaultEngineConfig, matchMinutes: 6 };
const LONGER = { ...defaultEngineConfig, matchMinutes: 20 };
const PASS1 = [{ seed: "42", config: SHORT }];
const PASS2 = [
  { seed: "20260731", config: SHORT }, // 시드 의존(그 6분에 그 상황이 안 나왔을 뿐)인지
  { seed: "42", config: LONGER }, // 길이 의존(짧아서 안 드러났을 뿐)인지
];

const run = (mut: (t: TacticalInput) => TacticalInput, seed: string, config: typeof SHORT): string =>
  JSON.stringify(runMatch(seed, mut(makeTacticalInput("H", seed)), makeTacticalInput("A", seed), sel, config));

const setTeam = (k: string, v: number) => (t: TacticalInput): TacticalInput =>
  k === "pressingScheme.intensity" || k === "pressingScheme.triggerLine"
    ? { ...t, team: { ...t.team, pressingScheme: { ...t.team.pressingScheme, [k.split(".")[1]!]: v } } }
    : { ...t, team: { ...t.team, [k]: v } };
const setBehavior = (k: string, v: number) => (t: TacticalInput): TacticalInput => ({
  ...t,
  players: t.players.map((p) => ({ ...p, behavior: { ...p.behavior, [k]: v } })),
});
const setMental = (v: number) => (t: TacticalInput): TacticalInput => ({
  ...t,
  players: t.players.map((p) => ({ ...p, mentalModifier: v * 2 - 1 })), // 0..1 → -1..1
});
const setDuty = (v: number) => (t: TacticalInput): TacticalInput => ({
  ...t,
  players: t.players.map((p) => ({ ...p, duty: (v < 0.34 ? "defend" : v < 0.67 ? "support" : "attack") as never })),
});

/** 광고 필드 경로 → 그 값을 세팅하는 뮤테이터. 여기 없는 경로는 감사 대상 밖(구조·문자열 필드). */
const SETTER: Record<string, (v: number) => (t: TacticalInput) => TacticalInput> = {
  "team.width": (v) => setTeam("width", v),
  "team.tempo": (v) => setTeam("tempo", v),
  "team.compactness": (v) => setTeam("compactness", v),
  "team.defensiveLineHeight": (v) => setTeam("defensiveLineHeight", v),
  "team.pressingScheme.intensity": (v) => setTeam("pressingScheme.intensity", v),
  "team.pressingScheme.triggerLine": (v) => setTeam("pressingScheme.triggerLine", v),
  "players[].behavior.widthTendency": (v) => setBehavior("widthTendency", v),
  "players[].behavior.forwardRunFreq": (v) => setBehavior("forwardRunFreq", v),
  "players[].behavior.supportDepth": (v) => setBehavior("supportDepth", v),
  "players[].behavior.pressAggression": (v) => setBehavior("pressAggression", v),
  "players[].behavior.passRisk": (v) => setBehavior("passRisk", v),
  "players[].behavior.passDirectness": (v) => setBehavior("passDirectness", v),
  "players[].behavior.shootTendency": (v) => setBehavior("shootTendency", v),
  "players[].behavior.dribbleTendency": (v) => setBehavior("dribbleTendency", v),
  "players[].behavior.positioningFreedom": (v) => setBehavior("positioningFreedom", v),
  // 카탈로그 outputFields 밖이지만 coach.ts 글로서리(PATCH_FIELD_GLOSSARY)·context-blocks 가 광고하는 축.
  "players[].mentalModifier": setMental,
  // 카탈로그·글로서리엔 없지만 web 셀렉트·계약·SimPlayer 까지 배선된 열거형(#366).
  "players[].duty": setDuty,
};

/**
 * 값을 끝에서 끝까지(그리고 중간) 흔들어 하나라도 다른 경기가 나오면 '유효'.
 *
 * <p>양끝 2점만 보면 <b>문턱형</b> 필드를 무효로 오판한다 — `pressingScheme.intensity` 가 실제로
 * 그렇다(0/0.25/0.5/0.75/1 다섯 값에서 산출은 <b>2종</b>뿐 = 불리언 스위치, #360 T2 의 대상).
 * 그래서 3점을 본다.
 */
function verdictOf(path: string, runs: readonly { seed: string; config: typeof SHORT }[]): Verdict {
  const make = SETTER[path]!;
  for (const { seed, config } of runs) {
    const first = run(make(0), seed, config);
    // 하나라도 다르면 그 자리에서 '유효' — 나머지 값은 돌리지 않는다(살아 있는 필드가 다수라 비용을 지배한다).
    if ([0.5, 1].some((v) => run(make(v), seed, config) !== first)) return "effective";
  }
  return "dead";
}

describe("광고 ↔ 실효 감사 (#367) — 프롬프트가 약속한 필드가 경기를 바꾸는가", () => {
  it("카탈로그 outputFields 는 전부 감사 대상에 등록돼 있다(새 광고가 조용히 빠져나가지 못한다)", () => {
    const advertised = new Set(DIRECTIVES.flatMap((d) => d.outputFields));
    // 구조·문자열 필드는 값 스윕으로 잴 수 없다 — 감사 대상 밖임을 명시(실효는 G2/G3/G4 게이트가 본다).
    const notMeasurable = new Set(["players[].markTarget", "players[].basePosition", "team.offsideTrap"]);
    const missing = [...advertised].filter((f) => !SETTER[f] && !notMeasurable.has(f));
    expect(missing, `카탈로그가 광고하는데 감사되지 않는 필드: ${missing.join(", ")}`).toEqual([]);
  });

  it("죽은 필드 목록이 실물과 정확히 일치한다(늘어도·줄어도 깨진다)", () => {
    const dead: string[] = [];
    for (const path of Object.keys(SETTER)) {
      // 1차에서 무효로 보이면 2차로 재확인 — 짧은 경기·한 시드에서만 안 드러난 축을 죽었다고
      // 오판하면 이 계약이 거짓말을 하게 된다(반대 방향 오탐은 이 목록이 곧 잡는다).
      if (verdictOf(path, PASS1) === "effective") continue;
      if (verdictOf(path, PASS2) === "effective") continue;
      dead.push(path);
    }
    expect(dead.sort(), "죽은 채로 광고 중인 필드").toEqual(Object.keys(KNOWN_DEAD).sort());
  }, 600_000);

  it("죽은 필드마다 살릴 웨이브(SoT 이슈)가 달려 있다 — '선언만 남기고 방치'가 최악이다", () => {
    for (const [field, owner] of Object.entries(KNOWN_DEAD)) {
      expect(owner, `${field} 의 후속 이슈`).toMatch(/#\d+/);
    }
  });
});
