/**
 * #407 N2 진단 — **박스 인구(box population)**. 분석 전용, 프로덕션 무수정.
 *
 * `e407-diversity.ts` 는 결과(박스 안 **수신**)를 잰다. 이 프로브는 그 앞단, 즉
 * **"그 순간 박스 안에 누가 서 있었나"** 를 직접 센다 — N2 가 목표를 옮기는 것과 선수가
 * 실제로 도착하는 것은 다른 문제이고, 둘을 갈라 봐야 "왜 약한가"를 귀속할 수 있다.
 *
 * 집계 구간 = **공격팀이 공을 소유한 채 공이 파이널서드에 있는 틱**(= N2 게이트가 열린 틱).
 *  - `popST` / `popNonST` : 그 틱 상대 박스 안에 있는 공격팀 아웃필더 수(ST / 비ST)
 *  - `gateTicks`          : 게이트가 열린 틱 수(팀-경기당)
 *  - `nonStEverPct`       : 게이트 틱 중 비ST 가 박스에 **한 명이라도** 있던 비율
 *
 * 실행:
 *   HMB_SEEDS=20 HMB_COMBOS='[{"label":"x","ov":{}}]' \
 *     node tools/run-gate.mjs --label e407-boxpop -- npx tsx research/e407-probe/e407-boxpop.ts
 */
import type { MatchLog, TeamSide } from "@hmb/shared";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config";
import { applyConfigOverrides } from "../../packages/engine/src/realism/config-override";
import { REALISM_SEEDS, GUARD_SEEDS } from "../../packages/engine/src/realism/harness";
import { runMatch } from "../../packages/engine/src/match";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures";

const N = Number(process.env.HMB_SEEDS || 20);
const POOL = N > 20 ? GUARD_SEEDS : REALISM_SEEDS;
const SEEDS = POOL.slice(0, N);
const select = makeSelectData();
const ROLES = ["GK", "LB", "LCB", "RCB", "RB", "LCM", "CM", "RCM", "LW", "ST", "RW"];
const roleOf = (id: string): string => ROLES[Number(id.slice(1))] ?? "?";

interface Pop {
  gateTicks: number;
  popST: number;
  popNonST: number;
  nonStEverPct: number;
  byRole: Record<string, number>;
}

function run(ov: Record<string, unknown>): Pop {
  const cfg: EngineConfig = Object.keys(ov).length
    ? applyConfigOverrides(defaultEngineConfig, ov)
    : defaultEngineConfig;
  const W = cfg.pitch.width;
  const H = cfg.pitch.height;
  const boxDepth = cfg.rules.penalty.boxDepthM;
  const boxHalf = cfg.rules.penalty.boxHalfWidthM;
  const f3 = cfg.setPiece.finalThirdLine;
  let gateTicks = 0;
  let st = 0;
  let nonSt = 0;
  let nonStEver = 0;
  const byRole: Record<string, number> = {};
  let teamMatches = 0;

  for (const seed of SEEDS) {
    const log: MatchLog = runMatch(
      seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg,
    );
    teamMatches += 2;
    for (const sn of log.tickSnapshots) {
      const ownerId = sn.ballOwner;
      if (!ownerId) continue;
      const side: TeamSide = ownerId.startsWith("H") ? "home" : "away";
      const prog = (side === "home" ? sn.ball.x : W - sn.ball.x) / W;
      if (prog < f3) continue;
      gateTicks += 1;
      const gx = side === "home" ? W : 0;
      let nn = 0;
      for (const p of sn.players) {
        if (p.team !== side) continue;
        const r = roleOf(p.playerId);
        if (r === "GK") continue;
        if (Math.abs(p.pos.x - gx) > boxDepth || Math.abs(p.pos.y - H / 2) > boxHalf) continue;
        byRole[r] = (byRole[r] ?? 0) + 1;
        if (r === "ST") st += 1;
        else { nonSt += 1; nn += 1; }
      }
      if (nn > 0) nonStEver += 1;
    }
  }
  const g = gateTicks || 1;
  return {
    gateTicks: +(gateTicks / teamMatches).toFixed(1),
    popST: +(st / g).toFixed(3),
    popNonST: +(nonSt / g).toFixed(3),
    nonStEverPct: +((nonStEver / g) * 100).toFixed(1),
    // ⚠️ **역할별도 여기서 `g`(총 게이트틱)로 나눠 내보낸다** — 호출부에서 `gateTicks` 로 나누면
    // 안 된다. 그 필드는 이미 팀-경기당으로 접힌 값이라 한 번 더 나누면 단위가 섞여
    // "게이트틱당 ST 10.42" 같은 불가능한 수가 나오고 `popST + popNonST` 와도 안 맞는다
    // (#407 독립 검증 minor). 이제 `Σ byRole == popST + popNonST` 가 성립한다.
    byRole: Object.fromEntries(
      Object.entries(byRole).map(([r, n]) => [r, +(n / g).toFixed(3)]),
    ),
  };
}

const combos: { label: string; ov: Record<string, unknown> }[] = process.env.HMB_COMBOS
  ? JSON.parse(process.env.HMB_COMBOS)
  : [{ label: "shipping", ov: {} }];
console.log(`# e407 박스 인구 — 시드 ${SEEDS.length}, engine@${defaultEngineConfig.version}`);
console.log("조합".padEnd(30) + "게이트틱/tm".padStart(12) + "박스ST".padStart(9) + "박스비ST".padStart(10) + "비ST출현%".padStart(11) + "  역할별(게이트틱당)");
for (const c of combos) {
  const p = run(c.ov);
  const roles = Object.entries(p.byRole)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}:${n.toFixed(2)}`)
    .join(" ");
  console.log(
    c.label.padEnd(30) + String(p.gateTicks).padStart(12) + String(p.popST).padStart(9) +
    String(p.popNonST).padStart(10) + String(p.nonStEverPct).padStart(11) + "  " + roles,
  );
}
