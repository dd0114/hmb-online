import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS, GUARD_SEEDS } from "./harness";
import { createRng } from "../rng";
import { aimErrorDeg, aimWithError, isLofted, passPowerFx } from "../kick";
import { unownedRuns } from "./loft";
import { countHeaders as countHeaderStats } from "./header";

/**
 * 공 물리 계약 — #313(H5 루즈볼) · #306(S6 공중볼) · #312(H1 세기·정확도).
 *
 * §2.5 E2E-TDD: hero 실관전 제보를 **계량 계약으로 박제**한 뒤 고친다. 여기 있는 수치는
 * 전부 `freekick-probe.test.ts` 와 **같은 정의**로 잰다(진단과 계약이 다른 자를 쓰면
 * "진단은 좋아졌는데 계약은 안 움직인다"가 된다).
 *
 * ⚠️ 밸런스 지표(골·전환율)는 여기 없다 — S8 소관이다(로드맵 §4 "판정 기준").
 * 여기서 지키는 것은 **구조**(공이 어떻게 움직이는가)뿐이다.
 */

const cfg = defaultEngineConfig;
const select = makeSelectData();

/** 계약 측정용 시드(진단 하네스와 같은 20시드). */
const SEEDS = REALISM_SEEDS.slice(0, 8);

/**
 * #371: **같은 (seed, 기본 config) 을 여러 it 이 다시 시뮬하던 것을 캐시한다.**
 * `runMatch` 는 §2-5 결정론 계약상 같은 입력에 같은 로그를 돌려주므로 이것은 순수한 중복 제거다
 * (계약·임계·표본 어느 것도 안 바꿨다). 이 파일만 8시드를 7번 다시 돌려 56경기(≈27초)를 썼다.
 *
 * ⚠️ 캐시는 **SEEDS(8) 범위로만** 건다. `GUARD_SEEDS`(60) 까지 붙들면 상주 메모리가 60로그가 되고,
 * 그건 이 파일이 지금까지 가져 본 적 없는 최고점이다(60로그는 `countHeaders` 안에서 한 번 만들어졌다
 * 사라졌다). 60시드 쪽 중복은 캐시가 아니라 **호출 자체를 1회로 줄여서** 없앤다(아래 `HEADERS`).
 */
const logCache = new Map<string, MatchLog>();

function logOf(seed: string): MatchLog {
  const hit = logCache.get(seed);
  if (hit) return hit;
  const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
  if (SEEDS.includes(seed)) logCache.set(seed, log);
  return log;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * "비행 중 급정지" — 직전 틱에 3m 넘게 날아간 공이 다음 틱에 **0.2m 미만**으로 딱 서는 것.
 * (freekick-probe.test.ts 의 `stops` 와 동일 정의.)
 */
function deadStops(log: MatchLog): number {
  const S = log.tickSnapshots;
  let stops = 0;
  for (let i = 2; i < S.length; i++) {
    const a = S[i - 2]!.ball, b = S[i - 1]!.ball, c = S[i]!.ball;
    const d1 = dist(a.x, a.y, b.x, b.y);
    const d2 = dist(b.x, b.y, c.x, c.y);
    if (d1 > 3 && d2 < 0.2) stops++;
  }
  return stops;
}

/**
 * "무소유 급정지" — 급정지 중에서도 **아무도 컨트롤하지 않은 공**이 날다가 그 자리에 서는 것.
 * 이것이 `settleSpeed: 0` 의 순수한 증상이다(#313). 데드볼 재배치 틱과, 사람이 트래핑해서
 * 멈춘 경우는 제외한다 — 그건 굴림이 아니라 각각 재시작 배치와 볼 컨트롤이다.
 */
function unownedDeadStops(log: MatchLog): number {
  const S = log.tickSnapshots;
  const cut = new Set<number>();
  for (const e of log.events) {
    const kind = e.type === "kickoff" && e.detail ? e.detail : e.type;
    if (["corner", "goal_kick", "throw_in", "free_kick", "penalty", "kickoff", "goal"].includes(kind)) {
      for (let t = e.tick - 1; t <= e.tick + 1; t++) cut.add(t);
    }
  }
  let n = 0;
  for (let i = 2; i < S.length; i++) {
    const a = S[i - 2]!, b = S[i - 1]!, c = S[i]!;
    if (cut.has(b.tick) || cut.has(c.tick)) continue;
    if (b.ballOwner != null || c.ballOwner != null) continue;
    const d1 = dist(a.ball.x, a.ball.y, b.ball.x, b.ball.y);
    const d2 = dist(b.ball.x, b.ball.y, c.ball.x, c.ball.y);
    if (d1 > 3 && d2 < 0.2) n++;
  }
  return n;
}

describe("#313 H5 — 루즈볼은 굴러간다(비행 중 급정지)", () => {
  it("무소유 공의 급정지 ≤ 25회/경기 (settleSpeed 0 일 때 52회)", () => {
    // 이것이 #313 이 고치는 것의 **정확한 지표**다. hero 제보의 원 수치(524회)는 raw 지표라
    // ①데드볼 재배치 ②선수가 받아서 트래핑 ③settle 정지 를 전부 합산한다 — ①②는 이 이슈가
    // 건드리는 층이 아니다(각각 데드볼 트랙·의사결정층). 아래 raw 계약이 총량을 함께 지킨다.
    const per = SEEDS.map((s) => ({ seed: s, n: unownedDeadStops(logOf(s)) }));
    const avg = per.reduce((t, p) => t + p.n, 0) / per.length;
    const detail = per.map((p) => `${p.seed}:${p.n}`).join(" ");
    // 통과할 때도 찍는다 — 아래 raw 래칫을 재기준할 때 **분해값**(raw − 무소유 = 데드볼+트래핑)이
    // 없으면 "총량이 늘었다"를 귀속할 수 없다(#357 에서 실제로 그 값이 필요했다).
    // eslint-disable-next-line no-console
    console.log(`  [#313] 무소유 급정지 ${avg.toFixed(1)}회/경기 (상한 25)`);
    expect(avg, `무소유 급정지 ${avg.toFixed(1)}회/경기 — ${detail}`).toBeLessThanOrEqual(25);
  });

  it("raw 급정지(hero 제보 지표) ≤ 320회/경기 (수정 전 524회)", () => {
    // 래칫: 구 524 를 기준으로 한 **총량** 상한이다. 잔여는 데드볼 배치 + "받고 그 자리에
    // 서기"라 이 웨이브의 스코프 밖이고, 그 사실은 `unownedDeadStops` 계약이 분리해서 증명한다.
    //
    // ── 재기준 260 → 320 (#279 0.26.0 합류) ─────────────────────────────────────────
    // raw 를 분해하면 **데드볼 + 트래핑(받아서 서기) + 무소유**다. 0.26.0 에서 증가한 것은
    // **트래핑**이고, 그건 이 웨이브가 소유를 회복시킨 것(공 소유 틱 25% → 60.1%)의 정의상
    // 귀결이다 — 받는 사람이 늘면 "받고 서는" 틱도 는다.
    // 이 웨이브가 책임지는 물리 지표는 **무소유 급정지**이고 그건 31.3 → 21.1 로 이미
    // 해소됐다(위 계약, 상한 25 는 **그대로 둔다** — 그게 진짜 게이트다).
    // 320 인 이유: 실측 308. 360(A조 제안)은 여유가 과해 회귀를 놓친다.
    //
    // ── 재기준 320 → 345 (#357 볼륨 재보정) ────────────────────────────────────────
    // **분해가 근거다**(위 계약이 이제 통과할 때도 무소유 값을 찍는다):
    //   #327:  raw 308.0 · 무소유 21.1 → 데드볼+트래핑 286.9
    //   #353:  raw 345.5 · 무소유 35.3 → 데드볼+트래핑 310.2   (RED)
    //   #357:  raw 338.4 · 무소유 **16.1** → 데드볼+트래핑 322.3
    // 즉 **이 계약이 책임지는 층(무소유)은 21.1 → 16.1 로 역대 최저**다(상한 25 는 그대로).
    // 늘어난 것은 데드볼+트래핑뿐이고, 그건 팀당 슛을 23.1 → 12.7 로 되돌린 것의 정의상
    // 귀결이다 — 슛으로 끝나지 않는 소유가 늘면 "받고 서는" 틱이 는다.
    // 345 = 실측 338.4 + 2%. 원 버그값 524 에 대한 이빨은 그대로다.
    const per = SEEDS.map((s) => ({ seed: s, n: deadStops(logOf(s)) }));
    const avg = per.reduce((t, p) => t + p.n, 0) / per.length;
    const detail = per.map((p) => `${p.seed}:${p.n}`).join(" ");
    expect(avg, `raw 급정지 ${avg.toFixed(1)}회 — ${detail}`).toBeLessThanOrEqual(345);
  });

  it("루즈볼 굴림 구간이 실제로 존재한다 — 소유 없는 저속 이동 틱", () => {
    // 굴림이 없으면 공은 "비행(빠름) 또는 정지(0)"뿐이라 이 구간이 0 이 된다.
    let rolling = 0;
    for (const seed of SEEDS) {
      const S = logOf(seed).tickSnapshots;
      for (let i = 1; i < S.length; i++) {
        const a = S[i - 1]!, b = S[i]!;
        if (b.ballOwner != null || a.ballOwner != null) continue;
        const d = dist(a.ball.x, a.ball.y, b.ball.x, b.ball.y);
        // #320 통합: 공이 속도 벡터가 되며 `settleSpeed`(굴림 상한 노브)가 사라졌다 —
        // 굴림은 이제 "마찰로 감속 중"이라 상한이 없다. 대신 **정지 임계 위 ~ 느린 구간**을 굴림으로 본다.
        if (d > cfg.ball.stopSpeedM && d <= cfg.ball.rollSpeedM) rolling++;
      }
    }
    expect(rolling / SEEDS.length, "경기당 굴림 틱").toBeGreaterThan(20);
  });
});

describe("#306 S6 — 공중볼과 헤딩", () => {
  const logs = SEEDS.map(logOf);

  it("헤딩 경합이 실제로 일어난다 — detail=\"header\" 이벤트", () => {
    const n = logs.reduce(
      (t, l) => t + l.events.filter((e) => e.detail === "header").length,
      0,
    );
    // eslint-disable-next-line no-console
    console.log(`  [#306] 헤딩 이벤트 ${n}건 / ${logs.length}경기 = ${(n / logs.length).toFixed(1)}건/경기`);
    expect(n / logs.length, "경기당 헤딩 이벤트").toBeGreaterThan(1);
  });

  /**
   * 헤더 슛 / 헤더 골 집계. 세는 함수는 `realism/header.ts` 와 **공유**한다(#357) — 진단 스윕이
   * 격자 매 점에서 같은 수를 봐야 하고, 두 곳에서 각자 세면 계약과 진단이 조용히 갈린다.
   *
   * ⚠️ **표본 20 → 60**(#358). 임계는 한 자리도 안 건드렸다(`> 0` 그대로) — 바뀐 것은 표본뿐이다.
   * 이 파일은 이미 같은 이유로 한 번 8 → 20 으로 올렸다("8시드면 0/1 사이를 오가 플래키해진다").
   * 지금 헤더 골은 **60경기에 2~5건**이라 20경기 기대값이 0.7~1.7 이고, 포아송이면 20경기에서
   * 0 이 나올 확률이 **18~50%** 다 = 게이트가 동전 던지기였다(0.28.0 이 통과한 것도 20경기 3건이라는
   * 운 좋은 표본 덕이다 — 같은 config 의 60경기 환산은 3배가 아니라 5건이다). 60경기면 기대값이
   * 2~5 로 올라 오탐이 14% 이하로 내려간다. `harness.ts` 의 GUARD_SEEDS 도입 근거와 같은 논리다.
   */
  // ⚠️ **표본 60 → 120**(#377 M3-A). 같은 이유·같은 방식이다 — 임계(`> 0`)는 한 자리도 안
  // 건드리고 표본만 늘린다. 이번엔 60경기 표본이 실제로 0 을 뽑았다: 같은 웨이브에서
  // `movement.passPlan.pull` 0.45 → 0.75 로 가며 GUARD_SEEDS 60경기 헤더 골이 3 → **0** 이 됐는데,
  // **120경기로 넓혀 재면 39슛/6골 → 48슛/4골** 이다(헤더 슛은 오히려 **늘었다**).
  // 즉 헤딩이 죽은 것이 아니라 60경기 기대값이 2~3 이라 포아송 P(0) ≈ 5~14% 인 게이트가
  // 그 눈금을 뽑은 것이다. 120경기면 기대값 4~6 → P(0) ≈ 0.2~1.8%.
  // (헤더 슛 래칫은 GUARD_SEEDS 60 그대로 둔다 — 고빈도라 검정력이 충분하고, 기준선 이력이
  //  그 표본에 붙어 있다. 표본을 바꾸면 그 이력이 끊긴다.)
  const HEADER_SEEDS = [
    ...GUARD_SEEDS,
    ...REALISM_SEEDS.map((s) => `29${s}`),
    ...REALISM_SEEDS.map((s) => `31${s}`),
    ...REALISM_SEEDS.map((s) => `37${s}`),
  ];

  function countHeaders(): { headerShots: number; headerGoals: number; goalSample: number } {
    const c = countHeaderStats(GUARD_SEEDS.map(logOf));
    const wide = countHeaderStats(HEADER_SEEDS.map(logOf));
    // eslint-disable-next-line no-console
    console.log(
      `  [#306] ${GUARD_SEEDS.length}경기 헤더 슛 ${c.headerShots}건 · ` +
        `헤더 골 ${wide.headerGoals}건(${HEADER_SEEDS.length}경기 표본)`,
    );
    return { ...c, goalSample: wide.headerGoals };
  }

  /**
   * #371: **한 번만 센다.** 아래 세 it 이 각각 `countHeaders()` 를 불러 60경기를 **세 번**
   * 다시 시뮬했다(180경기 ≈ 86초). 세 it 이 보는 것은 같은 표본의 서로 다른 필드이므로
   * 한 번 세서 나눠 쓰면 값·임계·표본이 하나도 안 바뀐다(순수 중복 제거).
   * 60로그는 여기서 만들어져 집계 후 바로 버려진다 — 상주하지 않는다(위 `logCache` 주석).
   */
  const HEADERS = countHeaders();

  it("헤더 슛이 나온다", () => {
    expect(HEADERS.headerShots, "헤더 슛 총 0건").toBeGreaterThan(0);
  });

  /**
   * **헤더 슛 총량 래칫**(#358 신설). 헤더 골은 60경기에도 한 자릿수라 그것만으로는
   * "헤딩이 조용히 죽는" 회귀를 못 잡는다. 상류(공중볼 경합 → 헤더 슛)는 고빈도라 잡을 수 있다.
   * 기준선: 0.28.0 = 24건 / 60경기, 이 웨이브 = 28건(**올랐다**). 하한 20 = 기준선의 0.83배.
   */
  it("헤더 슛 총량이 기준선 아래로 침식되지 않는다 (60경기, 경기 길이 환산)", () => {
    // #365(경기 90 → 45분): 총량 래칫은 **경기 길이에 비례하는 카운트**다. 상수 20 을 그대로 두면
    // 길이를 반으로 줄인 날 "헤딩이 침식됐다"는 거짓 신호가 난다. 래칫의 뜻(기준선의 0.83배)은
    // 그대로 두고 **길이로 환산**한다. 기준선 이력: 0.28.0 = 24건/60경기(90분) · #358 = 28건.
    const floor = Math.round(20 * (defaultEngineConfig.matchMinutes / 90));
    expect(HEADERS.headerShots, `헤더 슛 총량 래칫 (하한 ${floor})`).toBeGreaterThanOrEqual(floor);
  });

  // ── 헤더 골 = **S5(크로스 생성기)에서 해소** — 지금은 test.fail 로 박제한다 ──────────────
  // 0.25.0 볼륨 재보정 후 재측정: 20경기 헤더 슛 **8건** · 헤더 골 **0건**.
  // 볼륨(골/경기 1.98→5.10)을 2.6배 올려도 따라오지 않았다 — 즉 전환율 문제가 아니라 **입력이
  // 없다**. 헤더 슛 8건/20경기 = 0.2건/팀-경기이고, 그 상류인 크로스가 팀당 2.93회뿐이다.
  // 사슬 탐색은 "지금 있는 후보 중" 최선을 고를 뿐 **크로스 후보를 만들지 않는다**(chain.ts 의
  // 후보 생성기는 pass/dribble/shoot/hold 뿐) — 그래서 config 로는 못 넘는 **구조적 상한**이다.
  // 해소는 S5(공격 후보 생성기 4종: lead/through/**cross**/switch) 소관이고, 그때 이 test.fail 이
  // 저절로 실패(=통과)로 뒤집혀 알려준다.
  // ⚠️ 기대치를 0 으로 낮추지 말 것 — "헤더로도 골이 난다"는 요구는 유지되고, 미달을 숨기지 않는다.
  //
  // ── ✅ 해소(#314, S5 를 기다리지 않고) ────────────────────────────────────────────────
  // 예상은 "크로스 생성기(S5)가 들어와야 입력이 생긴다"였는데, **걷어내기(#314 A)가 먼저 그 입력을
  // 만들었다**. 걷어내기는 `lofted` 라 도착이 헤딩 경합(`resolveAerial`)으로 가고, 그 경합을 이긴
  // 공격수가 골 근처면 헤더 슛이 된다. 크로스 없이도 **공중볼 경합의 총량**이 올라간 것이 원인이다.
  // → `it.fails` 해제. 이제 이 계약은 정방향 게이트다.
  it("헤더 슛 중 골도 0 이 아니다", () => {
    expect(HEADERS.goalSample, `헤더 골 총 0건 (${HEADER_SEEDS.length}경기)`).toBeGreaterThan(0);
  });

  // ── #327 착지 계약 — "떠 있는 공은 반드시 떨어진다" ────────────────────────────────
  // 이 두 계약이 **없었기 때문에** 0.26.0 합류에서 lofted 착지 전이 부재가 11개 실패
  // 어디에도 안 걸렸다. 그때 유일하게 반응한 것이 스로인이었는데 그건 절대 게이트가 아니라
  // 벤치 표에만 있었다. 그래서 여기에 **구조 불변식 + 절대 밴드** 둘 다 박제한다.

  it("한 번의 접촉으로 공이 피치 대각선(≈125m)보다 멀리 가지 않는다", () => {
    // 왜 이것이 옳은 자를 재는가: `friction.lofted = 0.92` 는 v0=16 m/tick 에서 감속 거리가
    // **188m** 다. 105×68 피치의 대각선은 125m 라, 착지하지 않는 공은 어느 방향으로도
    // 피치 안에 설 수 없다 — 즉 "구조적으로 100% 필드 밖"이다. 마찰값·볼륨 노브와 무관하게
    // 참이어야 하는 성질이라, 튜닝이 움직여도 이 계약은 안 흔들린다.
    const runs = SEEDS.flatMap((s) => unownedRuns(logOf(s), s));
    const diagM = Math.hypot(105, 68);
    const worst = runs.reduce((a, b) => (b.pathM > a.pathM ? b : a), runs[0]!);
    expect(runs.length, "무소유 비행 구간 표본").toBeGreaterThan(100);
    expect(
      worst.pathM,
      `최장 비행 ${worst.pathM.toFixed(1)}m (seed ${worst.seed} t${worst.startTick}, ${worst.ticks}틱) — 피치 대각선 ${diagM.toFixed(0)}m`,
    ).toBeLessThanOrEqual(diagM);
  });

  it("스로인/팀 이 벤치 밴드의 경기 길이 환산(8.5–9.5) 안이다", () => {
    // #327 의 두 번째 요구: 스로인에 **절대 게이트가 없어서** 18.09 → 30.05 회귀가
    // 조용히 통과했다. 벤치 대조표(`bench.ts`)에만 있으면 스윕 때만 보인다.
    let throwIns = 0;
    for (const seed of SEEDS) {
      throwIns += logOf(seed).events.filter(
        (e) => e.type === "kickoff" && e.detail === "throw_in",
      ).length;
    }
    const perTeam = throwIns / SEEDS.length / 2;
    // eslint-disable-next-line no-console
    console.log(`  [#327] 스로인 ${perTeam.toFixed(2)}/팀경기 (밴드 8.5–9.5 · 경기 ${defaultEngineConfig.matchMinutes}분 환산)`);
    // #365(경기 90 → 45분): 벤치(`bench.ts` 17–19)는 **90분 축구** 값이라 그대로 쓸 수 없다.
    // 스로인은 실측이 거의 선형으로 따라온다(90분 17.45 → 45분 9.35 = ×0.54)라 **환산이 성립하는
    // 몇 안 되는 지표**다(슛·골은 초반 밀도 때문에 선형이 아니다 — shot-frequency 헤더 참조).
    // 그래서 밴드를 새로 만들지 않고 벤치를 경기 길이로 나눈다 = 기준의 출처가 그대로 유지된다.
    const scale = defaultEngineConfig.matchMinutes / 90;
    const lo = 17 * scale, hi = 19 * scale; // 8.5 – 9.5
    // 8시드는 60시드보다 분산이 크므로 여유를 준다(구 ±2 도 같은 길이 환산으로 ±1).
    expect(perTeam, `스로인 ${perTeam.toFixed(2)}/팀경기`).toBeGreaterThanOrEqual(lo - 2 * scale);
    expect(perTeam, `스로인 ${perTeam.toFixed(2)}/팀경기`).toBeLessThanOrEqual(hi + 2 * scale);
  });

  it("전달 종류가 실제로 갈린다 — 롱볼/크로스는 lofted, 숏패스는 ground", () => {
    // 엔진 내부 상태를 직접 본다(뷰어 계약을 안 건드리기 위해 MatchLog 에는 안 싣는다).
    expect(cfg.ball.loftMinDistM).toBeGreaterThan(0);
    expect(cfg.ball.loftSpeedMult).toBeLessThan(1);
    // 지상 숏패스는 lofted 가 아니고, 롱볼은 거리와 무관하게 lofted 다.
    const shortFx = cfg.fixedScale * 10;
    const longFx = cfg.fixedScale * 40;
    expect(isLofted(shortFx, false, cfg)).toBe(false);
    expect(isLofted(longFx, false, cfg)).toBe(true);
    expect(isLofted(shortFx, true, cfg)).toBe(true);
  });
});

describe("#312 H1 — 세기와 정확도(의도 vs 실제)", () => {
  it("세기가 상수가 아니다 — 거리·능력치·압박으로 갈린다", () => {
    const scale = cfg.fixedScale;
    const near = passPowerFx(5 * scale, 50, 0, cfg);
    const far = passPowerFx(40 * scale, 50, 0, cfg);
    expect(far, "먼 패스가 더 세다").toBeGreaterThan(near);
    const weak = passPowerFx(20 * scale, 20, 0, cfg);
    const strong = passPowerFx(20 * scale, 90, 0, cfg);
    expect(strong, "passing 이 높으면 더 세다").toBeGreaterThan(weak);
    const pressed = passPowerFx(20 * scale, 50, 3, cfg);
    const free = passPowerFx(20 * scale, 50, 0, cfg);
    expect(pressed, "압박받으면 힘이 덜 실린다").toBeLessThan(free);
  });

  it("조준 오차가 능력치로 줄고 압박으로 커진다", () => {
    const c = cfg.contest;
    const base = aimErrorDeg(c.passAimErrorDeg, 50, c.passAimAttrSwing, 0, c.passPressureAimPenalty);
    const skilled = aimErrorDeg(c.passAimErrorDeg, 95, c.passAimAttrSwing, 0, c.passPressureAimPenalty);
    const pressed = aimErrorDeg(c.passAimErrorDeg, 50, c.passAimAttrSwing, 2, c.passPressureAimPenalty);
    expect(skilled).toBeLessThan(base);
    expect(pressed).toBeGreaterThan(base);
    expect(c.passAimErrorDeg, "오차 개념 자체가 있어야 한다(구 엔진은 0)").toBeGreaterThan(0);
  });

  it("도달점이 의도와 어긋난다 — 편차 분포가 생긴다(구 엔진은 항상 0)", () => {
    // `aimWithError` 를 같은 조준점으로 여러 번 굴려 분포가 퍼지는지 본다.
    const rng = createRng("aim-spread");
    const from = { x: 0, y: 0 };
    const aim = { x: 20 * cfg.fixedScale, y: 0 };
    const devs: number[] = [];
    for (let i = 0; i < 400; i++) {
      const hit = aimWithError(from.x, from.y, aim.x, aim.y, { errDeg: 6, powerErrFrac: 0.16 }, rng);
      devs.push(Math.hypot(hit.x - aim.x, hit.y - aim.y) / cfg.fixedScale);
    }
    const mean = devs.reduce((t, v) => t + v, 0) / devs.length;
    const max = Math.max(...devs);
    expect(mean, `평균 편차 ${mean.toFixed(2)}m`).toBeGreaterThan(0.5);
    expect(max, `최대 편차 ${max.toFixed(2)}m`).toBeGreaterThan(2);
    // 오차 0 이면 정확히 의도대로(모델이 오차만의 함수임을 박제).
    const exact = aimWithError(from.x, from.y, aim.x, aim.y, { errDeg: 0, powerErrFrac: 0 }, rng);
    expect(exact).toEqual({ x: aim.x, y: aim.y });
  });

  it("공/선수 속도비가 6.7배에서 내려온다", () => {
    // 실측: 비행 틱의 공 이동량 / 같은 틱 선수 평균 이동량.
    // 정의는 이슈(#312)와 동일하게 맞춘다: **비행 틱**에서의 공 이동량 / 같은 틱 선수 평균 이동량
    // (구 엔진 = 공 18 m/tick · 선수 2.694 m/tick = 6.7배). 분모를 전체 틱으로 잡으면 같은 엔진이
    // 다른 숫자를 내므로 게이트가 이슈와 대화하지 못한다.
    let ballSum = 0, ballN = 0, playerSum = 0, playerN = 0;
    for (const seed of SEEDS) {
      const S = logOf(seed).tickSnapshots;
      for (let i = 1; i < S.length; i++) {
        const a = S[i - 1]!, b = S[i]!;
        if (a.ballOwner != null || b.ballOwner != null) continue;
        const bd = dist(a.ball.x, a.ball.y, b.ball.x, b.ball.y);
        // 비행 중인 틱만(정지·굴림은 속도비의 분자가 아니다).
        // #320: settleSpeed 제거 → 굴림 상한을 `rollSpeedM` 으로.
        if (bd <= cfg.ball.rollSpeedM) continue;
        ballSum += bd;
        ballN++;
        const prev = new Map(a.players.map((p) => [`${p.team}:${p.playerId}`, p]));
        for (const p of b.players) {
          const q = prev.get(`${p.team}:${p.playerId}`);
          if (!q) continue;
          const d = dist(p.pos.x, p.pos.y, q.pos.x, q.pos.y);
          if (d > 12) continue;
          playerSum += d;
          playerN++;
        }
      }
    }
    const ratio = (ballSum / ballN) / (playerSum / playerN);
    // eslint-disable-next-line no-console
    console.log(`  [#312] 공/선수 속도비 ${ratio.toFixed(2)}배 · 공 ${(ballSum / ballN).toFixed(2)} m/tick · 선수 ${(playerSum / playerN).toFixed(3)} m/tick`);
    expect(ratio, `공/선수 속도비 ${ratio.toFixed(2)}배 (구 엔진 6.7배)`).toBeLessThan(4.5);
  });
});
