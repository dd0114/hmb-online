import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig, type EngineConfig } from "./config";
import { makeTacticalInput, makeSelectData } from "./fixtures";
import type { MatchLog, TacticalInput, TeamSide } from "@hmb/shared";

/**
 * 코너 rest defence 계약 (#182, E2E-TDD).
 *
 * hero 제보: "코너킥 때 모든 선수가 다 전진하는 게 어색하다 — 공격팀 수비수는 좀 덜 와야".
 * 실측(40시드·코너 406개): 잔류 0.00명 / 최후미도 상대골 19m 앞 = 100% 재현.
 *
 * 확정 구조(hero): **누가 남는지는 config 상수가 아니라 팀 전략 + 선수 성향으로 정해진다.**
 *  (1) 팀 축   — 수비 기조(defensiveLineHeight)·템포가 낮을수록 많이 남긴다(팀마다 기본값이 다름).
 *  (2) 선수 축 — 프롬프트가 만든 behavior 가 슬롯 깊이를 **뒤집을 수 있다**(원래 남을 CB 가
 *                올라가고, 원래 올라갈 공격수가 남는다).
 *  (3) 롤백    — corner.enabled=false 는 레거시(전원 전진)와 bit-identical.
 *
 * 이 파일은 위 3가지를 계약으로 박는다. 튜닝값(인원 매핑·오버라이드 가중치)은 전부 config.
 */

const W = defaultEngineConfig.pitch.width;
const H = defaultEngineConfig.pitch.height;
const BOX_DEPTH = 16.5;
const BOX_HALFW = 20.16;
const SEEDS = ["4815162342", "9999999999", "1234567890", "2718281828", "1414213562"];

const prog = (side: TeamSide, x: number) => (side === "home" ? x / W : 1 - x / W);

/** 코너 딜리버리 직전(공이 아직 코너 아크에 있는 마지막) 틱들의 배치. */
function cornerFrames(log: MatchLog) {
  const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
  const out: { side: TeamSide; stayBack: string[]; inBox: string[]; defHigh: string[] }[] = [];
  for (const e of log.events) {
    if (!(e.type === "kickoff" && e.detail === "corner") || !e.team) continue;
    const side = e.team;
    const gx = side === "home" ? W : 0;
    const first = byTick.get(e.tick);
    if (!first) continue;
    const cornerY = first.ball.y;
    let last = -1;
    for (let t = e.tick; t <= e.tick + 40; t++) {
      const s = byTick.get(t);
      if (!s) break;
      if (Math.hypot(s.ball.x - gx, s.ball.y - cornerY) <= 2.5) last = t;
      else if (last >= 0) break;
    }
    const s = byTick.get(last);
    if (!s) continue;
    const stayBack: string[] = [];
    const inBox: string[] = [];
    const defHigh: string[] = [];
    for (const p of s.players) {
      if (p.playerId === "H0" || p.playerId === "A0") continue;
      const ap = prog(p.team, p.pos.x);
      if (p.team === side) {
        // 잔류 = 자기 진영 절반 부근 이하(하프라인 ±6m 창 포함).
        if (ap <= 0.56) stayBack.push(p.playerId);
        if (ap >= 1 - BOX_DEPTH / W && Math.abs(p.pos.y - H / 2) <= BOX_HALFW) inBox.push(p.playerId);
      } else if (ap >= 0.44) defHigh.push(p.playerId);
    }
    out.push({ side, stayBack, inBox, defHigh });
  }
  return out;
}

function framesFor(cfg: EngineConfig, home: TacticalInput, away: TacticalInput, seeds = SEEDS) {
  const select = makeSelectData();
  const all: ReturnType<typeof cornerFrames> = [];
  for (const seed of seeds) {
    all.push(...cornerFrames(runMatch(seed, { ...home, seed }, { ...away, seed }, select, cfg)));
  }
  return all;
}

const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);

/** 팀 전략을 바꾼 TacticalInput. */
function withTeam(t: TacticalInput, patch: Partial<TacticalInput["team"]>): TacticalInput {
  return { ...t, team: { ...t.team, ...patch } };
}
/** 특정 선수의 코너 가담 성향(프롬프트 산출 behavior)을 바꾼 TacticalInput. */
function withPlayer(t: TacticalInput, playerId: string, patch: Partial<TacticalInput["players"][0]["behavior"]>): TacticalInput {
  return {
    ...t,
    players: t.players.map((p) => (p.playerId === playerId ? { ...p, behavior: { ...p.behavior, ...patch } } : p)),
  };
}

const baseHome = makeTacticalInput("H", SEEDS[0]!);
const baseAway = makeTacticalInput("A", SEEDS[0]!);

describe("#182 (1) 뒤에 남는 선수가 존재한다", () => {
  it("기본 팀 기조에서 매 코너마다 잔류 수비수가 1명 이상 있다", () => {
    const f = framesFor(defaultEngineConfig, baseHome, baseAway);
    expect(f.length).toBeGreaterThan(10);
    const none = f.filter((x) => x.stayBack.length === 0);
    expect(none.length).toBe(0);
  });

  it("박스 인원이 실축 밴드(4~7명)로 내려온다 — 전원 전진(7.8명) 해소", () => {
    const f = framesFor(defaultEngineConfig, baseHome, baseAway);
    const m = avg(f.map((x) => x.inBox.length));
    expect(m).toBeGreaterThanOrEqual(4);
    expect(m).toBeLessThanOrEqual(7);
  });
});

describe("#182 (2) 팀 축 — 수비 기조가 낮을수록 많이 남긴다", () => {
  it("수비적 팀 > 기본 팀 > 공격적 팀 순으로 잔류 인원이 많다", () => {
    const defensive = withTeam(baseHome, { defensiveLineHeight: 0.15, tempo: 0.25 });
    const attacking = withTeam(baseHome, { defensiveLineHeight: 0.9, tempo: 0.85 });
    const stay = (t: TacticalInput) =>
      avg(framesFor(defaultEngineConfig, t, baseAway).filter((x) => x.side === "home").map((x) => x.stayBack.length));
    const d = stay(defensive);
    const n = stay(baseHome);
    const a = stay(attacking);
    expect(d).toBeGreaterThan(a); // 기조가 실제 레버여야 한다
    expect(d).toBeGreaterThanOrEqual(n);
    expect(n).toBeGreaterThanOrEqual(a);
    expect(a).toBeGreaterThanOrEqual(1); // 올인이어도 최소 1명은 남긴다
  });
});

describe("#182 (3) 선수 축 — 프롬프트가 슬롯 깊이를 뒤집는다", () => {
  it("원래 남을 CB(H2) 에게 '코너 때 올라가라' 성향을 주면 박스로 올라간다", () => {
    const before = framesFor(defaultEngineConfig, baseHome, baseAway).filter((x) => x.side === "home");
    const stayRateBefore = avg(before.map((x) => (x.stayBack.includes("H2") ? 1 : 0)));
    expect(stayRateBefore).toBeGreaterThan(0.8); // 기본값에선 CB 가 잔류 담당

    const pushed = withPlayer(baseHome, "H2", { forwardRunFreq: 1, supportDepth: 1 });
    const after = framesFor(defaultEngineConfig, pushed, baseAway).filter((x) => x.side === "home");
    const stayRateAfter = avg(after.map((x) => (x.stayBack.includes("H2") ? 1 : 0)));
    expect(stayRateAfter).toBeLessThan(0.2); // 오버라이드되어 올라간다
  });

  it("원래 올라갈 공격수(H9) 에게 '뒤를 봐라' 성향을 주면 잔류 쪽으로 내려온다", () => {
    const before = framesFor(defaultEngineConfig, baseHome, baseAway).filter((x) => x.side === "home");
    expect(avg(before.map((x) => (x.stayBack.includes("H9") ? 1 : 0)))).toBeLessThan(0.2);

    const held = withPlayer(baseHome, "H9", { forwardRunFreq: 0, supportDepth: 0 });
    const after = framesFor(defaultEngineConfig, held, baseAway).filter((x) => x.side === "home");
    expect(avg(after.map((x) => (x.stayBack.includes("H9") ? 1 : 0)))).toBeGreaterThan(0.5);
  });
});

describe("#182 (4) 롤백 스위치", () => {
  it("corner.enabled=false 는 레거시(전원 전진)로 돌아간다", () => {
    const legacy: EngineConfig = {
      ...defaultEngineConfig,
      setPiece: { ...defaultEngineConfig.setPiece, corner: { ...defaultEngineConfig.setPiece.corner, enabled: false } },
    };
    const f = framesFor(legacy, baseHome, baseAway);
    expect(avg(f.map((x) => x.stayBack.length))).toBe(0);
  });
});
