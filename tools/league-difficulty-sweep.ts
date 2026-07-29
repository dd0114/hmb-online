/**
 * #252 리그 난이도 검증 하네스 — **디비전별 실측 승률**.
 *
 * 왜 여기 있나: `docs/plan-v5/opponent-balance.md` §6.2 의 "처음 5시즌 무난" 판정이 이 측정에
 * 걸려 있다. 세션 스크래치패드에만 두면 다음 사람이 재현도 회귀검증도 못 한다.
 *
 * 설계 원칙 두 가지:
 *  1. **상대 로스터를 여기서 만들지 않는다.** 서버(`LeagueService.sampleRoster`)가 만든 것을 덤프해
 *     읽는다 — TS 로 재구현하면 검증이 아니라 재발명이고, 구현과 검증이 같은 실수를 공유한다.
 *  2. **다시드 필수.** 엔진은 입력 미세변화에 카오스적이라 번들당 시드 1개면 비단조 잡음이 난다
 *     (실측: k 0.95→0.90 에서 승률 61%→39% 역전). 포인트당 최소 500경기를 권장한다.
 *
 * 입력 만들기:
 *   1) 로스터 덤프(서버 경로):
 *      cd server-java && HMB_DUMP_DIVISION_ROSTERS=<out>/divisions.json \
 *        ./gradlew test --rerun-tasks --tests "online.hmb.LeagueDivisionRosterDumpTest"
 *   2) 유저측 재현 번들: 라이브 `match_halves` 를 아래 형태로 뽑아 replay.json 으로.
 *      SELECT m.id, m.mode, m.bot_id, b.name AS bot_name,
 *             h1.select_data_json s1, h1.home_input_json hi1, h1.away_input_json ai1, h1.half_seed sd1,
 *             h2.home_input_json hi2, h2.away_input_json ai2
 *      FROM matches m JOIN bots b ON b.id=m.bot_id
 *      JOIN match_halves h1 ON h1.match_id=m.id AND h1.half=1
 *      JOIN match_halves h2 ON h2.match_id=m.id AND h2.half=2
 *      WHERE m.state='FINISHED';
 *
 * 실행: npx tsx tools/league-difficulty-sweep.ts <dataDir> <level|all> [seeds=16]
 * 출력: 디비전별 JSON 한 줄(승률·무·득실·승점/경기).
 *
 * ⚠️ 엔진은 **읽기만** 한다(무접촉 계약).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runFirstHalf, resumeSecondHalf } from "../packages/engine/src/match";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const dataDir = process.argv[2];
if (!dataDir) {
  throw new Error("usage: tsx tools/league-difficulty-sweep.ts <dataDir> <level|all> [seeds]");
}
const levelArg = process.argv[3] ?? "all";
const SEEDS = Number(process.argv[4] ?? 16);

type Bundle = {
  mode: string; bot_name: string;
  s1: string; hi1: string; ai1: string; sd1: string; hi2: string; ai2: string;
};
const bundles: Bundle[] = JSON.parse(readFileSync(join(dataDir, "replay.json"), "utf8"));
const divisions: {
  level: number; strengthMul: number; teams: { xi: string[]; power: number }[];
}[] = JSON.parse(readFileSync(join(dataDir, "divisions.json"), "utf8"));

const CAT: Record<string, { name: string; position: string; grade: string; attributes: Record<string, number> }> =
  Object.fromEntries(
    JSON.parse(readFileSync(join(REPO, "data/players/players.v2.3.json"), "utf8"))
      .map((p: any) => [p.id, p]),
  );

/** 기준 코호트 = 스타터팩 + 최상위 1장(현행 신규 유저). 여기가 "시즌 1 무난"의 판정 대상이다. */
function userSideOf(r: Bundle) {
  const s1 = JSON.parse(r.s1);
  const botSide: "home" | "away" = s1.away?.name === r.bot_name ? "away" : "home";
  return { s1, botSide, userSide: (botSide === "away" ? "home" : "away") as "home" | "away" };
}
function isStarterTopCohort(r: Bundle): boolean {
  const { s1, userSide } = userSideOf(r);
  const mix: Record<string, number> = {};
  for (const p of s1[userSide].players) {
    const g = CAT[p.playerId]?.grade;
    if (g) mix[g] = (mix[g] ?? 0) + 1;
  }
  return (mix.LEGEND ?? 0) === 1 && (mix.DIA ?? 0) === 0 && (mix.GOLD ?? 0) === 0;
}
const cohort = bundles.filter(isStarterTopCohort);
if (!cohort.length) throw new Error("스타터팩+최상위 코호트 번들이 없다 — replay.json 을 확인해라");

const scale = (v: number, mul: number) => Math.max(1, Math.min(100, Math.round(v * mul)));

/** 봇 사이드를 디비전 XI 로 교체 + 배율 = MatchOrchestrator.buildSelectData 가 하는 일. */
function swapBot(botTeam: any, botInput: any, xi: string[], mul: number) {
  const players = botInput.players.map((pi: any, i: number) => ({ ...pi, playerId: xi[i % xi.length] }));
  const cards = players.map((pi: any) => {
    const c = CAT[pi.playerId];
    return {
      playerId: pi.playerId, name: c.name, position: c.position,
      attributes: Object.fromEntries(Object.entries(c.attributes).map(([k, v]) => [k, scale(v, mul)])),
    };
  });
  return { team: { ...botTeam, players: cards }, input: { ...botInput, players } };
}

function measure(level: number) {
  const div = divisions.find((d) => d.level === level);
  if (!div) throw new Error(`divisions.json 에 level ${level} 이 없다`);
  const out: { gf: number; ga: number; res: "W" | "D" | "L" }[] = [];
  let botPower = 0, n = 0;
  cohort.forEach((r, bi) => {
    const { s1, botSide, userSide } = userSideOf(r);
    const team = div.teams[bi % div.teams.length];
    const hi1 = JSON.parse(r.hi1), hi2 = JSON.parse(r.hi2);
    for (let s = 0; s < SEEDS; s++) {
      const a1 = swapBot(s1[botSide], JSON.parse(r.ai1), team.xi, div.strengthMul);
      const a2 = swapBot(s1[botSide], JSON.parse(r.ai2), team.xi, div.strengthMul);
      botPower += a1.team.players.reduce(
        (acc: number, p: any) => acc + Object.values(p.attributes).reduce((x: number, y: any) => x + y, 0), 0);
      n++;
      const carry = runFirstHalf(`${r.sd1}#d${level}#${s}`, hi1, a1.input, { ...s1, [botSide]: a1.team });
      const full = resumeSecondHalf(carry, hi2, a2.input);
      const gf = (full.finalScore as any)[userSide];
      const ga = (full.finalScore as any)[botSide];
      out.push({ gf, ga, res: gf > ga ? "W" : gf === ga ? "D" : "L" });
    }
  });
  const pct = (c: string) => (100 * out.filter((x) => x.res === c).length) / out.length;
  const avg = (f: (x: (typeof out)[number]) => number) => out.reduce((a, x) => a + f(x), 0) / out.length;
  const w = pct("W"), d = pct("D");

  // ⚠️ SE 는 **번들 클러스터** 기준으로 낸다. 208경기를 독립 시행으로 보면 3.4%p 가 나오지만
  // 실제는 13번들 × 16시드라 번들간 분산이 지배한다(실측 sd ~27%p → 평균의 SE ~7%p).
  // 독립 가정 SE 를 쓰면 없는 정밀도를 주장하게 된다.
  const perBundle: number[] = [];
  for (let b = 0; b < cohort.length; b++) {
    const slice = out.slice(b * SEEDS, (b + 1) * SEEDS);
    perBundle.push((100 * slice.filter((x) => x.res === "W").length) / slice.length);
  }
  const mean = perBundle.reduce((a, b) => a + b, 0) / perBundle.length;
  const sd = Math.sqrt(perBundle.reduce((a, b) => a + (b - mean) ** 2, 0) / (perBundle.length - 1));
  return {
    level, botXi: Math.round(botPower / n), bundles: cohort.length, seeds: SEEDS, matches: out.length,
    winPct: +w.toFixed(1), drawPct: +d.toFixed(1), lossPct: +(100 - w - d).toFixed(1),
    gf: +avg((x) => x.gf).toFixed(2), ga: +avg((x) => x.ga).toFixed(2),
    ppg: +((w * 3 + d) / 100).toFixed(2),
    winPctSeClustered: +(sd / Math.sqrt(perBundle.length)).toFixed(1),
  };
}

const levels = levelArg === "all" ? divisions.map((d) => d.level) : [Number(levelArg)];
for (const level of levels) {
  console.log(JSON.stringify(measure(level)));
}
