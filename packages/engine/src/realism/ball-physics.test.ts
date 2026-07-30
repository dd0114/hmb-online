import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { createRng } from "../rng";
import { aimErrorDeg, aimWithError, isLofted, passPowerFx } from "../kick";

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

function logOf(seed: string): MatchLog {
  return runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
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
    expect(avg, `무소유 급정지 ${avg.toFixed(1)}회/경기 — ${detail}`).toBeLessThanOrEqual(25);
  });

  it("raw 급정지(hero 제보 지표) ≤ 260회/경기 (수정 전 524회)", () => {
    // 래칫: 구 524 의 절반 이하를 박제한다. 잔여는 데드볼 배치 + "받고 그 자리에 서기"라
    // 이 웨이브의 스코프 밖이고, 그 사실은 `unownedDeadStops` 계약이 분리해서 증명한다.
    const per = SEEDS.map((s) => ({ seed: s, n: deadStops(logOf(s)) }));
    const avg = per.reduce((t, p) => t + p.n, 0) / per.length;
    const detail = per.map((p) => `${p.seed}:${p.n}`).join(" ");
    expect(avg, `raw 급정지 ${avg.toFixed(1)}회 — ${detail}`).toBeLessThanOrEqual(260);
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

  /** 헤더 슛 / 헤더 골 집계(20시드). 8시드면 0/1 사이를 오가 플래키해진다. */
  function countHeaders(): { headerShots: number; headerGoals: number } {
    let headerShots = 0;
    let headerGoals = 0;
    for (const l of REALISM_SEEDS.map(logOf)) {
      // 헤더 슛 → 골 연결: 같은 팀의 직전 슛이 헤더였던 goal 이벤트.
      const lastShotWasHeader = new Map<string, boolean>();
      for (const e of l.events) {
        if (e.type === "shot" && e.team) {
          const isHeader = e.detail === "header";
          lastShotWasHeader.set(e.team, isHeader);
          if (isHeader) headerShots++;
        }
        if (e.type === "goal" && e.team && lastShotWasHeader.get(e.team)) headerGoals++;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`  [#306] ${REALISM_SEEDS.length}경기 헤더 슛 ${headerShots}건 · 헤더 골 ${headerGoals}건`);
    return { headerShots, headerGoals };
  }

  it("헤더 슛이 나온다", () => {
    expect(countHeaders().headerShots, "헤더 슛 총 0건").toBeGreaterThan(0);
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
    expect(countHeaders().headerGoals, "헤더 골 총 0건").toBeGreaterThan(0);
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
