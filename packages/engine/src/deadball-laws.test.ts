import { describe, it, expect } from "vitest";
import type { MatchLog, MatchEvent, TeamSide } from "@hmb/shared";
import { runMatch } from "./match";
import { defaultEngineConfig, type EngineConfig } from "./config";
import { makeTacticalInput, makeSelectData, demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import { showcaseConfig } from "../dev-viewer/generate-demo";
import { REALISM_SEEDS } from "./realism/harness";
import { freeKickWallCount } from "./setpiece";
import { createPitch } from "./pitch";

/**
 * #176 — 데드볼 정지 중 "상대는 물러나 있어야 한다"(실제 축구 규칙) 계약.
 *
 * 버그: 정지 구간 동안 상대가 재시작 스팟까지 자유롭게 걸어 들어와, 정지가 끝나는 순간
 * 바로 옆에서 태클/인터셉트로 강탈한다(골킥이면 박스 안 키퍼에게서 뺏어 즉시 실점).
 * 원인 = 엔진에 Law 13/14/15/16/17 의 "접근 금지" 개념이 아예 없다(match.ts 정지 루프가
 * 평소 오프더볼 로직을 그대로 돌리고, 그 로직은 수비팀을 공 쪽으로 수축시킨다).
 *
 * 이 파일은 **튜닝값이 아니라 규칙**을 박제한다 — 거리는 config 가 아니라 IFAB 상수를 직접
 * 쓴다(config 를 읽으면 노브를 낮추는 것만으로 계약이 통과해버린다). config 가 규칙과
 * 어긋나지 않는지는 별도 계약으로 확인한다.
 *
 * 실행 가능한 보장(순간이동 금지 = #59 철학 유지):
 *  - A) 재시작이 실행되는 틱에는 금지구역 안에 상대가 **한 명도 없다** ← 강탈 경로 차단
 *  - B) 정지 중 밖에 있던 상대가 안으로 **들어오지 않는다**(일방통행 벽)
 *  - C) 안에 있던 상대는 **나가는 방향으로만** 움직인다(더 파고들지 않는다)
 *  - D) taker 가 공을 차기 전에 상대에게 뺏기지 않는다(#176 원 증상의 전 세트피스 일반형)
 *  - E) 위 전부를 **걷기 속도**로 달성한다(순간이동/텔레포트 금지)
 */

/** IFAB 경기규칙 상수. 밸런싱 노브가 아니라 규칙이므로 테스트가 직접 들고 있는다. */
const LAW = {
  /** Law 8(킥오프)·13(프리킥)·14(페널티)·17(코너): 상대는 9.15m 밖. */
  distanceM: 9.15,
  /** Law 15(스로인): 상대는 2m 밖. */
  throwInDistanceM: 2,
};

/** 스냅샷 좌표는 소수 2자리 반올림 → 경계 판정 여유(1cm + 고정소수 1mm). */
const EPS = 0.05;
/** 걷기 상한(m/tick). config.speed.maxPerTick=7 보다 여유. 초과 = 순간이동. */
const MAX_WALK = 8;
/** 정지 창 탐색 상한(틱). walkStoppage 동적 연장 포함. */
const MAX_WINDOW = 45;

interface Zone {
  /** 스팟(m). */
  x: number;
  y: number;
  /** 스팟 중심 금지 반경(m). 0 이면 원 제약 없음. */
  rM: number;
  /** 페널티박스 금지구역(m). null 이면 없음. */
  box: { cx: number; cy: number; hx: number; hy: number } | null;
}

/** side 팀이 지키는(=자기) 페널티박스. */
function ownBox(side: TeamSide, config: EngineConfig): NonNullable<Zone["box"]> {
  return {
    cx: side === "home" ? 0 : config.pitch.width,
    cy: config.pitch.height / 2,
    hx: config.rules.penalty.boxDepthM,
    hy: config.rules.penalty.boxHalfWidthM,
  };
}

/** side 팀이 공격하는(=상대) 페널티박스. */
function oppBox(side: TeamSide, config: EngineConfig): NonNullable<Zone["box"]> {
  return ownBox(side === "home" ? "away" : "home", config);
}

function insideBox(b: NonNullable<Zone["box"]>, x: number, y: number): boolean {
  return Math.abs(x - b.cx) < b.hx - EPS && Math.abs(y - b.cy) < b.hy - EPS;
}

/**
 * 재시작 종류별 상대 금지구역(규칙). side = 재시작(수혜) 팀.
 * 구현을 import 하지 않고 규칙에서 직접 세운다(자기검수 회피).
 */
function lawZone(
  kind: string,
  side: TeamSide,
  spot: { x: number; y: number },
  config: EngineConfig,
): Zone | null {
  switch (kind) {
    // Law 16: 상대는 차는 팀 페널티에어리어 밖.
    case "goal_kick":
      return { x: spot.x, y: spot.y, rM: 0, box: ownBox(side, config) };
    // Law 15: 스로인 지점에서 2m.
    case "throw_in":
      return { x: spot.x, y: spot.y, rM: LAW.throwInDistanceM, box: null };
    // Law 17(코너)·8(킥오프): 9.15m.
    case "corner":
    case "kickoff":
      return { x: spot.x, y: spot.y, rM: LAW.distanceM, box: null };
    // Law 13: 9.15m. 수비팀이 자기 박스 안에서 차면 상대는 박스 밖까지.
    case "free_kick": {
      const own = ownBox(side, config);
      const inOwn = insideBox(own, spot.x, spot.y);
      return { x: spot.x, y: spot.y, rM: LAW.distanceM, box: inOwn ? own : null };
    }
    // Law 14: 키커·수비GK 외 전원이 박스 밖 + 스팟 9.15m 밖.
    case "penalty":
      return { x: spot.x, y: spot.y, rM: LAW.distanceM, box: oppBox(side, config) };
    default:
      return null;
  }
}

/**
 * 금지구역 여유(m). 음수면 위반(안에 있음), 값이 클수록 밖.
 * 원과 박스 둘 다 있으면 더 빡빡한 쪽(작은 값)을 쓴다.
 */
function clearance(z: Zone, x: number, y: number): number {
  let c = Infinity;
  if (z.rM > 0) c = Math.min(c, Math.hypot(x - z.x, y - z.y) - z.rM);
  if (z.box) {
    c = Math.min(c, Math.max(Math.abs(x - z.box.cx) - z.box.hx, Math.abs(y - z.box.cy) - z.box.hy));
  }
  return c;
}

/** 재시작 이벤트 → 계약 검사에 쓰는 종류 문자열. 세트피스가 아니면 null. */
function restartKind(e: MatchEvent): string | null {
  if (e.type === "free_kick") return "free_kick";
  if (e.type === "penalty") return "penalty";
  // kickoff 이벤트는 detail 로 종류를 구분(detail 없음 = 골 후/후반 센터 킥오프).
  if (e.type === "kickoff") return e.detail ?? "kickoff";
  return null;
}

export interface Violation {
  kind: string;
  tick: number;
  playerId: string;
  detail: string;
  /** #378: 이 재시작이 **무엇을 기다렸는가**. 계약 A 가 이 축으로 갈린다(아래 주석). */
  ceremonial?: boolean;
}

/** 한 경기의 데드볼 규칙 위반 전수 스캔. */
function scanLaws(log: MatchLog, config: EngineConfig, tag: string): {
  atRestart: Violation[];
  entered: Violation[];
  deeper: Violation[];
  teleport: Violation[];
  windows: number;
} {
  const pitch = createPitch(config);
  const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
  const atRestart: Violation[] = [];
  const entered: Violation[] = [];
  const deeper: Violation[] = [];
  const teleport: Violation[] = [];
  let windows = 0;
  // 하프/종료 휘슬은 데드볼을 도중에 잘라낸다(재시작이 실행되지 않고 킥오프로 리셋).
  // 그런 창은 "물러날 시간" 자체가 없으므로 규칙이 성립하지 않는다 → 계약에서 제외.
  const whistles = log.events.filter((w) => w.type === "half_whistle" || w.type === "full_whistle").map((w) => w.tick);
  // **새 재시작이 선언되면 그 이전 창은 끝난다.** 안 그러면 같은 스팟에서 상대에게 재선언된
  // 세트피스(예: 라인 위 스로인이 곧장 다시 아웃 → 상대 스로인)의 **새 taker** 를 "상대가 스팟에
  // 서 있다"로 오판한다 — 규칙 위반이 아니라 정당한 소유 이전이다.
  const restartTicks = log.events.filter((w) => restartKind(w) != null).map((w) => w.tick);

  for (const e of log.events) {
    const kind = restartKind(e);
    if (!kind || !e.team) continue;
    const s0 = byTick.get(e.tick);
    if (!s0) continue;
    const spot = { x: s0.ball.x, y: s0.ball.y };
    const zone = lawZone(kind, e.team, spot, config);
    if (!zone) continue;
    // `>=` 인 이유: 종료 휘슬은 마지막 틱(total-1)에 나므로 재시작과 **같은 틱**일 수 있다.
    if (whistles.some((w) => w >= e.tick && w <= e.tick + MAX_WINDOW)) continue;
    const oppPrefix = e.team === "home" ? "A" : "H";
    const oppGk = `${oppPrefix}0`;
    windows++;

    // 규칙이 적용되는 창 = 재시작 선언 ~ **공이 인플레이 되기 직전**.
    // 인플레이 판정(스냅샷만으로 관측 가능한 신호): taker 가 차면 소유가 비고(flight) 공이
    // 날아가거나, 드리블이면 공이 스팟에서 움직인다. 정지·홀드 중엔 공이 스팟에 정확히 정지한다.
    // (공이 3m 이동할 때까지로 잡으면 taker 가 이미 찬 뒤의 정상 경합까지 위반으로 센다.)
    const prev = new Map<string, { x: number; y: number; c: number }>();
    let lastTick = e.tick;
    for (let t = e.tick; t <= e.tick + MAX_WINDOW; t++) {
      const s = byTick.get(t);
      if (!s) break;
      if (t > e.tick && (s.ballOwner == null || Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) > 0.3)) break;
      if (t > e.tick && restartTicks.includes(t)) break; // 새 재시작 선언 → 이 창 종료
      lastTick = t;
      for (const p of s.players) {
        if (!p.playerId.startsWith(oppPrefix) || p.playerId === oppGk) continue;
        const c = clearance(zone, p.pos.x, p.pos.y);
        const before = prev.get(p.playerId);
        if (before) {
          const step = Math.hypot(p.pos.x - before.x, p.pos.y - before.y);
          if (step > MAX_WALK) {
            teleport.push({ kind, tick: t, playerId: p.playerId, detail: `${step.toFixed(1)}m/tick` });
          }
          // B) 밖(여유>=0) → 안(여유<0) 진입 금지.
          if (before.c >= -EPS && c < -EPS) {
            entered.push({ kind, tick: t, playerId: p.playerId, detail: `여유 ${before.c.toFixed(2)}→${c.toFixed(2)}m` });
          }
          // C) 안에 있는 동안 더 파고들기 금지.
          else if (before.c < -EPS && c < before.c - EPS) {
            deeper.push({ kind, tick: t, playerId: p.playerId, detail: `여유 ${before.c.toFixed(2)}→${c.toFixed(2)}m` });
          }
        }
        prev.set(p.playerId, { x: p.pos.x, y: p.pos.y, c });
      }
    }

    // A) 재시작 실행 틱(정지 마지막 틱)에는 구역 안이 비어 있어야 한다.
    const sEnd = byTick.get(lastTick);
    if (sEnd) {
      for (const p of sEnd.players) {
        if (!p.playerId.startsWith(oppPrefix) || p.playerId === oppGk) continue;
        const c = clearance(zone, p.pos.x, p.pos.y);
        if (c < -EPS) {
          atRestart.push({
            kind,
            tick: lastTick,
            playerId: p.playerId,
            detail: `여유 ${c.toFixed(2)}m`,
            // #378: 의식(ceremonial) 재시작인가 = "심판이 거리를 재준" 재개인가.
            // 코너는 박스 크라우딩이 성립해야 하므로 항상 의식이고, 프리킥은 **벽을 부를 때만**이다.
            // 스로인·골킥은 빠른 재개(quick)라 "이미 물러나 있을 것"을 요구하지 않는다(Law 13/16).
            ceremonial:
              kind === "corner" ||
              kind === "penalty" ||
              kind === "kickoff" ||
              (kind === "free_kick" && freeKickWallCount(pitch, config, e.team!, spot.x, spot.y) > 0),
          });
        }
      }
    }
  }
  void tag;
  return { atRestart, entered, deeper, teleport, windows };
}

/**
 * #176 원 증상(전 세트피스 일반형): **taker 가 공을 차기 전에 상대에게 뺏긴다**.
 * 골킥이면 "박스 안 키퍼에게서 강탈", 프리킥/스로인이면 "스팟 위 taker 를 태클로 강탈".
 * 공을 찬 뒤(=인플레이)의 경합은 정상 축구이므로 창 밖이다.
 */
function scanPrePlaySteals(log: MatchLog): string[] {
  const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
  const out: string[] = [];
  for (const e of log.events) {
    const kind = restartKind(e);
    if (!kind || !e.team) continue;
    const s0 = byTick.get(e.tick);
    if (!s0) continue;
    const spot = { x: s0.ball.x, y: s0.ball.y };
    const oppPrefix = e.team === "home" ? "A" : "H";
    for (let t = e.tick + 1; t <= e.tick + MAX_WINDOW; t++) {
      const s = byTick.get(t);
      if (!s) break;
      // 소유가 비었거나(찼다) 공이 스팟을 떠났으면(드리블/비행) 인플레이 → 검사 종료.
      if (s.ballOwner == null || Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) > 0.3) break;
      // 새 재시작이 선언됐으면(같은 스팟 재선언 포함) 그건 강탈이 아니라 정당한 소유 이전이다.
      if (log.events.some((w) => w.tick === t && restartKind(w) != null)) break;
      if (s.ballOwner.startsWith(oppPrefix)) {
        out.push(`${kind} t${t} ${s.ballOwner} 이 차기 전 taker 에게서 강탈(스팟 ${spot.x.toFixed(1)},${spot.y.toFixed(1)})`);
        break;
      }
    }
  }
  return out;
}

interface Case {
  name: string;
  log: MatchLog;
  config: EngineConfig;
}

/** 리얼 6시드 + 쇼케이스 데모(원 리포트 재현 환경). */
/**
 * **알려진 반례 시드** — 픽스 전에 실제로 강탈이 관측된 시드는 반드시 케이스에 포함한다.
 *
 * 이 버그의 회귀 계약은 오래 `deadball-walk` 의 **단일 데모 시드**에 의존했는데, 엔진 튜닝으로
 * 타임라인이 밀리면 **"그 시드에 사례가 없다"** 는 이유만으로 초록이 되어 회귀를 놓친다
 * (구 반례 t2051/t2064 가 실제로 그렇게 소멸했다). 규칙이 구현된 지금의 올바른 계약은
 * "특정 시드에 사례가 없다" 가 아니라 **"어떤 시드에서도 규칙 거리 위반 0"** 이다 — 반례 시드는
 * 다수 시드 전수 스캔에 흡수시켜 시드 의존성을 제거한다.
 */
const COUNTEREXAMPLE_SEEDS = [
  "4815162345", // #182 가 deadball-walk 드리프트 계약에 전용으로 붙인 시드.
];

function buildCases(): Case[] {
  const select = makeSelectData();
  const seeds = [...REALISM_SEEDS];
  for (const s of COUNTEREXAMPLE_SEEDS) if (!seeds.includes(s)) seeds.push(s);
  const cases: Case[] = seeds.map((seed) => ({
    name: `real:${seed}`,
    log: runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, defaultEngineConfig),
    config: defaultEngineConfig,
  }));
  cases.push({
    name: "showcase",
    log: runMatch(demoSeed, demoHome, demoAway, demoSelect, showcaseConfig as EngineConfig),
    config: showcaseConfig as EngineConfig,
  });
  return cases;
}

const cases = buildCases();

function collect<T>(pick: (c: Case) => T[]): string[] {
  const out: string[] = [];
  for (const c of cases) for (const v of pick(c)) out.push(`[${c.name}] ${JSON.stringify(v)}`);
  return out;
}

describe("데드볼 접근 금지 — 실제 축구 규칙 (#176)", () => {
  const scans = cases.map((c) => ({ c, s: scanLaws(c.log, c.config, c.name) }));

  it("스캔 표본이 충분하다(계약이 빈 집합을 통과하지 않게)", () => {
    const windows = scans.reduce((n, x) => n + x.s.windows, 0);
    expect(windows).toBeGreaterThan(200);
  });

  it("A) 재시작 실행 틱에 금지구역 안 상대가 없다", () => {
    // ⚠️ #378(재개 게이트)에서 이 계약을 **의식/빠른 재개로 쪼갤 뻔했다**(Law 13 은 빠르게 찬
    // 킥을 9.15m 안 상대가 가로채도 속행시킨다). 그러지 않았다 — `quickBaseTicks` 를 2 → 5 로
    // 잡으니 침범이 **전수 0** 이 됐기 때문이다(실측: quick 2 → 벽FK 1/90·빠른FK 1/7 ·
    // quick 5 → 0/94 · 0/15). 계수 하나로 규칙이 성립하면 계약을 약하게 만들 이유가 없다.
    const v = collect((c) => scans.find((x) => x.c === c)!.s.atRestart);
    expect(v.slice(0, 20), `${v.length}건\n${v.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("B) 정지 중 밖에 있던 상대가 금지구역으로 들어오지 않는다(일방통행 벽)", () => {
    const v = collect((c) => scans.find((x) => x.c === c)!.s.entered);
    expect(v.slice(0, 20), `${v.length}건\n${v.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("C) 금지구역 안 상대는 나가는 방향으로만 움직인다", () => {
    const v = collect((c) => scans.find((x) => x.c === c)!.s.deeper);
    expect(v.slice(0, 20), `${v.length}건\n${v.slice(0, 20).join("\n")}`).toEqual([]);
  });

  /**
   * ⚠️ D 의 변이체 킬은 **config 노브로는 안 된다** — 픽스가 세 겹이라 하나만 꺼도 증상이 안 나온다:
   * ①정지 중 규칙기반 정적 배치(상대가 스팟으로 수렴 자체를 안 함) ②거리 금지구역 ③안 찬
   * 세트피스는 글루·태클 없음(`match.ts` 볼 경합 분기). 거리 노브만 0 으로 두면(A/B/C 는 각각
   * 849/489/743 건 실패) D 는 ①③ 때문에 0 건이라 통과해버린다 — 즉 config 뮤턴트로 D 를 검증했다고
   * 말하면 안 된다.
   * **D 의 올바른 기준선 = 픽스 전 트리**. origin/main(픽스 전)을 별도 워크트리로 체크아웃해 같은
   * 스캔을 돌리면 **20시드 24건 · 40시드 49건 · 80시드 119건**이 잡힌다 = 이 계약은 원 버그를
   * 확실히 잡는다. (세 겹 중 어느 하나라도 되돌리면 다시 잡힌다는 뜻이기도 하다.)
   */
  it("D) taker 가 공을 차기 전에 상대에게 뺏기지 않는다(#176 원 증상)", () => {
    const v = collect((c) => scanPrePlaySteals(c.log));
    expect(v.slice(0, 20), `${v.length}건\n${v.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("E) 접근 금지를 걷기 속도로 달성한다(순간이동 없음, #59 철학)", () => {
    const v = collect((c) => scans.find((x) => x.c === c)!.s.teleport);
    expect(v.slice(0, 20), `${v.length}건\n${v.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("config 노브가 IFAB 규칙 거리와 어긋나지 않는다", () => {
    const d = defaultEngineConfig.rules.deadBall;
    expect(d.opponentDistanceM).toBeGreaterThanOrEqual(LAW.distanceM);
    expect(d.throwInDistanceM).toBeGreaterThanOrEqual(LAW.throwInDistanceM);
    expect(d.boxClear).toBe(true);
  });
});
