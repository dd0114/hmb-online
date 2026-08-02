/**
 * #377 트랙 D — **hero 관전 리뷰 팩 생성기** (M3-C · M3-B · S3-A · S3-B 4개 웨이브 통합 1회 리뷰).
 *
 * 실행: `npx tsx evidence/377/gen-review-4w.ts`        (전량 = 시드 스캔 + 베이크 + 장면표)
 *      `SCAN_ONLY=1 npx tsx evidence/377/gen-review-4w.ts`  (스캔 표만)
 * 산출: evidence/377/review-4w-{on,off}.json — **같은 시드**, on = 출하 config, off = 4개 전부 롤백.
 *      (표·장면 목록은 stdout — evidence/377/REVIEW-4W.md 의 수치가 이 출력이다)
 *
 * ## ⚠️ off 는 **틱 정렬 비교가 아니다**
 * 롤백 팔은 첫 분기 이후 전개가 통째로 갈린다(같은 시드여도 같은 장면이 같은 틱에 오지 않는다).
 * 그래서 **장면 목록은 on 로그 기준으로만** 낸다. off 는 "전반적 인상"(수비가 얼마나 뭉치나 ·
 * 스루패스가 아예 안 나오나) 비교용이고, 특정 틱을 짝지어 보면 안 된다.
 *
 * ## 측정은 계약과 **같은 함수**로 한다
 * 새 탐지기를 짜지 않는다 — `realism/{through,lane,press,defshape}.ts` 의 관측자·측정 함수를
 * 그대로 쓴다. 증거와 계약이 다른 함수를 쓰면 "증거는 좋은데 계약은 통과"가 성립한다
 * (`loft.ts` 선례). 진단이 더하는 것은 **로그 스냅샷에서 읽는 좌표**뿐이고, 엔진 동작·관측자
 * 필드는 한 줄도 건드리지 않는다(골든이 움직이면 실패다).
 *
 * ## 시드는 체리피킹이 아니라 **선언된 기준**으로 고른다
 * 후보 집합 = `SEEDS`(고정). 각 시드에서 기제별 "볼 만한 장면" 수를 아래 **품질 하한**으로 세고,
 * **5개 카운터의 최소값이 가장 큰 시드**를 고른다(동률이면 시드 번호가 작은 쪽). 스캔 표 전량이
 * 문서에 실리므로 고른 이유가 표에서 읽힌다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../../packages/engine/src/match.ts";
import { defaultEngineConfig, type EngineConfig } from "../../packages/engine/src/config.ts";
import { makeTacticalInput, makeSelectData } from "../../packages/engine/src/fixtures.ts";
import { measureThrough, type AimScene } from "../../packages/engine/src/realism/through.ts";
import { measureLaneSplit, type LaneScene } from "../../packages/engine/src/realism/lane.ts";
import { runWithPressUnit } from "../../packages/engine/src/realism/press.ts";
import { runWithDefShape } from "../../packages/engine/src/realism/defshape.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = defaultEngineConfig;
const scale = cfg.fixedScale;

/** 후보 시드 집합 — **고정 선언**. 스캔은 이 전량을 돈다. */
const SEEDS = Array.from({ length: Number(process.env.SEED_N ?? 24) }, (_, i) => String(i + 1));

/** 4개 웨이브를 전부 롤백한 팔(= 0.35.0 상당 동작). 지시·시드는 그대로. */
const OFF: EngineConfig = {
  ...cfg,
  chain: { ...cfg.chain, throughPass: { ...cfg.chain.throughPass, enabled: false } },
  vision: { ...cfg.vision, laneRead: { ...cfg.vision.laneRead, enabled: false } },
  press: { ...cfg.press, unit: { ...cfg.press.unit, enabled: false } },
  movement: {
    ...cfg.movement,
    defLine: { ...cfg.movement.defLine, enabled: false },
    restDefence: { ...cfg.movement.restDefence, enabled: false },
  },
};

/** `gen-m3a.ts` 의 관용구 그대로 — 표기 시계는 `displayMinutes` 스케일. */
const disp = (tick: number): string => {
  const s = (cfg.displayMinutes ?? cfg.matchMinutes) / cfg.matchMinutes;
  const sec = Math.round(((tick * cfg.msPerTick) / 1000) * s);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// 품질 하한 (선언 — 스캔·장면 선정이 같은 값을 쓴다)
// ─────────────────────────────────────────────────────────────────────────────
/** M3-C: 리드 ≥ 15m 이고 조준점이 상대 오프사이드 라인 뒤. (= 눈에 "빈 공간으로 갔다"가 보이는 대역) */
const THROUGH_MIN_LEAD_M = 15;
/** M3-B: 그 수비수가 레인을 **읽었고**, 그 틱에 레인 쪽으로 1.5m 이상 좁혔고, 선점량이 실제로 걸렸다. */
const LANE_MIN_CLOSED_M = 1.5;
/**
 * S3-A: 공이 우리 골 40m 안(위험 구역)에서 배정 총원 ≥ 3 이고 커버가 ≥ 1 명.
 *
 * ⚠️ **역할 라벨이 전원 붙은 틱만** 센다(`members.length >= count`). 관측자는 *실제로 그 일을 한*
 * 선수만 흘리므로(압박 담당으로 뽑혔다 개인 문턱에서 물러난 선수는 안 흘린다 · 정지 중에는
 * `decideOffBall` 이 안 돈다) 라벨이 비는 틱이 있다. 그런 틱은 **"누구를 보라"를 못 쓴다** —
 * 관전 요건이지 측정 주장이 아니다(빠진 틱은 아래 "원표본" 수에 그대로 남아 있다).
 */
const PRESS_MIN_COUNT = 3;
const PRESS_DANGER_M = 40;
/** S3-B(라인): 보정이 걸렸고 멤버 ≥ 3 명이며 목표 산포를 3m 이상 좁혔다. */
const LINE_MIN_MEMBERS = 3;
const LINE_MIN_TIGHTEN_M = 3;
/** S3-B(레스트): 잔류 상한이 **실제로 문** 틱(= CB 가 더 올라가려던 것을 멈췄다). */
const REST_MIN_CAPPED = 1;
/** 에피소드 분리(틱) — 연속 틱의 같은 장면을 한 건으로 접는다. */
const EPISODE_GAP = 15;

interface Ep {
  tick: number;
  side: string;
  /** 그 에피소드의 주인공(장면 선정에서 원표본을 되찾는 키). */
  who: string;
}

/**
 * 장면은 **경기 전체에 고르게** 뽑는다 — 앞쪽 n건을 그냥 쓰면 전부 킥오프 직후에 몰린다
 * (실측: 접기 전 첫 3건이 0:06 / 1:18 / 1:30). 순서는 시계 순 그대로 두고 분위수로 고른다.
 */
function pickSpread<T>(a: T[], n: number): T[] {
  if (a.length <= n) return a;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(a[Math.min(a.length - 1, Math.floor(((i + 0.5) / n) * a.length))]!);
  return out;
}

/** 연속 표본 접기 — 팀별로 마지막 채택 틱에서 `EPISODE_GAP` 틱 이상 떨어진 것만 남긴다. */
function fold(rows: Ep[]): Ep[] {
  const last = new Map<string, number>();
  const out: Ep[] = [];
  for (const r of [...rows].sort((a, b) => a.tick - b.tick)) {
    const l = last.get(r.side) ?? -1e9;
    if (r.tick - l < EPISODE_GAP) continue;
    last.set(r.side, r.tick);
    out.push(r);
  }
  return out;
}

interface Scan {
  seed: string;
  through: Ep[];
  lane: Ep[];
  press: Ep[];
  line: Ep[];
  rest: Ep[];
  /** 장면 원본(문서용 상세). */
  throughRaw: AimScene[];
  laneRaw: LaneScene[];
  pressRaw: { tick: number; side: string; count: number; cover: number; dangerM: number; members: { id: string; role: string; laneToId: string | null }[] }[];
  /** 위 하한은 통과했지만 역할 라벨이 다 안 붙어 "누구를 보라"를 못 쓰는 틱 수. */
  pressUnlabelled: number;
  lineRaw: { tick: number; side: string; members: number; beforeM: number; afterM: number; ids: string[]; posProgM: number[] }[];
  restRaw: { tick: number; side: string; want: number; assigned: number; capped: number; ids: string[]; overshootM: number[] }[];
}

function scanSeed(seed: string, conf: EngineConfig = cfg): Scan {
  const cfg = conf; // 스캔은 출하 config, off 팔 대조는 롤백 config 로 **같은 함수**를 돈다.
  // ① M3-C — 계약과 같은 함수(`measureThrough`)가 낸 `through` 팔 장면.
  const th = measureThrough(cfg, [seed]);
  const throughRaw = th.scenes.filter((s) => s.leadM >= THROUGH_MIN_LEAD_M && s.behindLine);

  // ② M3-B — 계약과 같은 함수(`measureLaneSplit`)의 READ 팔.
  const ls = measureLaneSplit(cfg, [seed]);
  const laneRaw = ls.read.scenes.filter((s) => s.closed >= LANE_MIN_CLOSED_M && s.stepM > 0);

  // ③ S3-A — 엔진 관측자 라벨 그대로(`runWithPressUnit`). 좌표 되추론 금지(#378 선례).
  const pu = runWithPressUnit(cfg, seed).samples;
  const memberByKey = new Map<string, { id: string; role: string; laneToId: string | null }[]>();
  for (const s of pu) {
    if (s.kind !== "member") continue;
    const k = `${s.tick}:${s.side}`;
    const a = memberByKey.get(k) ?? [];
    a.push({ id: s.playerId, role: s.role, laneToId: s.laneToId });
    memberByKey.set(k, a);
  }
  const pressAll = pu
    .filter(
      (s) =>
        s.kind === "unit" &&
        s.count >= PRESS_MIN_COUNT &&
        s.coverCount >= 1 &&
        s.dangerFx / scale < PRESS_DANGER_M,
    )
    .map((s) => {
      const u = s as Extract<typeof s, { kind: "unit" }>;
      return {
        tick: u.tick,
        side: u.side,
        count: u.count,
        cover: u.coverCount,
        dangerM: u.dangerFx / scale,
        members: memberByKey.get(`${u.tick}:${u.side}`) ?? [],
      };
    });
  /** 라벨이 전원 붙은 틱만(관전 요건 — 위 주석). 빠진 수는 `pressUnlabelled` 로 남긴다. */
  const pressRaw = pressAll.filter((s) => s.members.length >= s.count);
  const pressUnlabelled = pressAll.length - pressRaw.length;

  // ④ S3-B — 같은 처방(배정한 쪽이 라벨을 단다), `runWithDefShape`.
  const ds = runWithDefShape(cfg, seed).samples;
  const lineMem = new Map<string, { id: string; pos: number }[]>();
  const restMem = new Map<string, { id: string; over: number }[]>();
  for (const s of ds) {
    if (s.kind === "lineMember") {
      const k = `${s.tick}:${s.side}`;
      const a = lineMem.get(k) ?? [];
      a.push({ id: s.playerId, pos: s.posProgFx / scale });
      lineMem.set(k, a);
    } else if (s.kind === "restMember" && s.capped) {
      const k = `${s.tick}:${s.side}`;
      const a = restMem.get(k) ?? [];
      a.push({ id: s.playerId, over: (s.beforeProgFx - s.afterProgFx) / scale });
      restMem.set(k, a);
    }
  }
  const lineRaw = ds
    .filter(
      (s) =>
        s.kind === "line" &&
        s.applied &&
        s.members >= LINE_MIN_MEMBERS &&
        (s.beforeSpreadFx - s.afterSpreadFx) / scale >= LINE_MIN_TIGHTEN_M,
    )
    .map((s) => {
      const l = s as Extract<typeof s, { kind: "line" }>;
      const m = lineMem.get(`${l.tick}:${l.side}`) ?? [];
      return {
        tick: l.tick,
        side: l.side,
        members: l.members,
        beforeM: l.beforeSpreadFx / scale,
        afterM: l.afterSpreadFx / scale,
        ids: m.map((x) => x.id),
        posProgM: m.map((x) => x.pos),
      };
    });
  const restRaw = ds
    .filter((s) => s.kind === "rest" && s.capped >= REST_MIN_CAPPED)
    .map((s) => {
      const r = s as Extract<typeof s, { kind: "rest" }>;
      const m = restMem.get(`${r.tick}:${r.side}`) ?? [];
      return {
        tick: r.tick,
        side: r.side,
        want: r.want,
        assigned: r.assigned,
        capped: r.capped,
        ids: m.map((x) => x.id),
        overshootM: m.map((x) => x.over),
      };
    });

  return {
    seed,
    throughRaw,
    laneRaw,
    pressRaw,
    lineRaw,
    restRaw,
    pressUnlabelled,
    through: fold(throughRaw.map((s) => ({ tick: s.tick, side: s.side, who: s.passerId }))),
    lane: fold(laneRaw.map((s) => ({ tick: s.tick, side: s.side, who: s.playerId }))),
    press: fold(pressRaw.map((s) => ({ tick: s.tick, side: s.side, who: "" }))),
    line: fold(lineRaw.map((s) => ({ tick: s.tick, side: s.side, who: "" }))),
    rest: fold(restRaw.map((s) => ({ tick: s.tick, side: s.side, who: "" }))),
  };
}

const counts = (s: Scan): number[] => [s.through.length, s.lane.length, s.press.length, s.line.length, s.rest.length];

console.log(`# #377 트랙 D 통합 관전 리뷰 팩 — ${cfg.version}`);
console.log(`\n## 시드 스캔 (후보 집합 = "${SEEDS[0]}".."${SEEDS[SEEDS.length - 1]}" · 전량)`);
console.log(
  `품질 하한: 스루패스 리드≥${THROUGH_MIN_LEAD_M}m·라인 뒤 / 레인 읽음+좁힘≥${LANE_MIN_CLOSED_M}m / ` +
    `압박 총원≥${PRESS_MIN_COUNT}·커버≥1·위험거리<${PRESS_DANGER_M}m / 라인 멤버≥${LINE_MIN_MEMBERS}·산포−≥${LINE_MIN_TIGHTEN_M}m / ` +
    `레스트 상한 문 틱. 연속 ${EPISODE_GAP}틱 이내는 1건으로 접는다.`,
);
console.log(`\n| seed | M3-C 스루 | M3-B 레인 | S3-A 압박 | S3-B 라인 | S3-B 레스트 | min |`);
console.log(`|---|---|---|---|---|---|---|`);

const scans: Scan[] = [];
for (const seed of SEEDS) {
  const s = scanSeed(seed);
  scans.push(s);
  const c = counts(s);
  console.log(`| ${seed} | ${c[0]} | ${c[1]} | ${c[2]} | ${c[3]} | ${c[4]} | **${Math.min(...c)}** |`);
}

let best = scans[0]!;
for (const s of scans) {
  const a = Math.min(...counts(s));
  const b = Math.min(...counts(best));
  if (a > b || (a === b && Number(s.seed) < Number(best.seed))) best = s;
}
const SEED = best.seed;
console.log(`\n→ 선정 시드 = **${SEED}** (min ${Math.min(...counts(best))}, 동률이면 번호 작은 쪽)`);

if (process.env.SCAN_ONLY) process.exit(0);

// ─────────────────────────────────────────────────────────────────────────────
// 베이크 — 뷰어에 그대로 드롭할 로그 2개
// ─────────────────────────────────────────────────────────────────────────────
const bake = (config: EngineConfig, name: string): MatchLog => {
  const log = runMatch(SEED, makeTacticalInput("H", SEED), makeTacticalInput("A", SEED), makeSelectData(), config);
  writeFileSync(join(here, `review-4w-${name}.json`), JSON.stringify(log));
  return log;
};
const on = bake(cfg, "on");
const off = bake(OFF, "off");

console.log(`\n## 로그`);
console.log(`  review-4w-on.json   4개 전부 on(출하)  — score ${on.finalScore.home}:${on.finalScore.away} · 이벤트 ${on.events.length} · 틱 ${on.tickSnapshots.length}`);
console.log(`  review-4w-off.json  4개 전부 롤백      — score ${off.finalScore.home}:${off.finalScore.away} · 이벤트 ${off.events.length} · 틱 ${off.tickSnapshots.length}`);
console.log(`  ⚠️ 같은 시드지만 첫 분기 이후 전개가 갈린다 — **틱 정렬 비교 아님**. 장면 목록은 on 기준.`);

/** 로그 스냅샷에서 좌표를 읽는다(진단이 더하는 유일한 것). */
const snapAt = new Map(on.tickSnapshots.map((s) => [s.tick, s]));
const posOf = (tick: number, side: string, id: string): string => {
  const p = snapAt.get(tick)?.players.find((q) => q.team === side && q.playerId === id);
  return p ? `(${p.pos.x.toFixed(0)},${p.pos.y.toFixed(0)})` : "?";
};
/**
 * ⚠️ **관측자는 틱 시작에, 스냅샷은 틱 끝에** 찍힌다. 배정·읽기 판정이 본 공 위치는 그 틱 **직전**
 * 스냅샷의 공이다(실측: t334 배정 위험거리 35m 은 t333 공 (25.2,49.6) 의 값이고, t334 공은
 * (18.7,40.2) 로 이미 16m 를 날아가 있다 — 공이 한 틱에 그만큼 움직인다). 선수 좌표는 반대로
 * **그 틱 끝**을 쓴다(= 뷰어에서 그 시각에 보이는 위치이자 이동 후 거리 d1 을 잰 그 위치).
 */
const ballAtDecision = (tick: number): string => {
  const b = snapAt.get(tick - 1)?.ball;
  return b ? `(${b.x.toFixed(0)},${b.y.toFixed(0)})` : "?";
};

/** 장면 하나 = 표의 한 행. 통합 목록을 위해 전부 모은다. */
interface Row {
  tick: number;
  wave: string;
  line: string;
}
const rows: Row[] = [];

/** 접힌 에피소드에서 경기 전체에 고르게 n건 → 원표본을 되찾는 키(틱+팀+주인공). */
const keptKeys = (eps: Ep[], n: number): Set<string> =>
  new Set(pickSpread(eps, n).map((e) => `${e.tick}:${e.side}:${e.who}`));

console.log(`\n## 장면 — M3-C 스루패스 (리드 ≥${THROUGH_MIN_LEAD_M}m · 라인 뒤)`);
{
  const keep = keptKeys(best.through, 3);
  for (const s of best.throughRaw.filter((x) => keep.has(`${x.tick}:${x.side}:${x.passerId}`)).sort((a, b) => a.tick - b.tick)) {
    const t = `${disp(s.tick)} (t${s.tick}) ${s.side}`;
    const txt =
      `${t} — ${s.passerId} ${posOf(s.tick, s.side, s.passerId)} 가 ${s.receiverId} ${posOf(s.tick, s.side, s.receiverId)} 의 ` +
      `**앞 공간 (${s.x.toFixed(0)},${s.y.toFixed(0)})** 으로 찬다(리드 ${s.leadM.toFixed(1)}m · 패스 거리 ${s.distM.toFixed(1)}m · 오프사이드 라인 뒤).`;
    console.log(`  ${txt}`);
    rows.push({ tick: s.tick, wave: "M3-C 스루패스", line: txt });
  }
}

console.log(`\n## 장면 — M3-B 수비 레인 예측 (읽음 · 좁힘 ≥${LANE_MIN_CLOSED_M}m)`);
{
  const keep = keptKeys(best.lane, 3);
  for (const s of best.laneRaw.filter((x) => keep.has(`${x.tick}:${x.side}:${x.playerId}`)).sort((a, b) => a.tick - b.tick)) {
    const t = `${disp(s.tick)} (t${s.tick}) ${s.side}`;
    const txt =
      `${t} — ${s.playerId} ${posOf(s.tick, s.side, s.playerId)} 가 공 (${s.fromX.toFixed(0)},${s.fromY.toFixed(0)}) 과 ` +
      `상대 ${s.toId} (${s.toX.toFixed(0)},${s.toY.toFixed(0)}) 를 잇는 **길 위**로 ` +
      `${s.d0.toFixed(1)}m → ${s.d1.toFixed(1)}m (한 틱에 ${s.closed.toFixed(1)}m 좁힘 · 선점 ${s.stepM.toFixed(1)}m).`;
    console.log(`  ${txt}`);
    rows.push({ tick: s.tick, wave: "M3-B 레인 예측", line: txt });
  }
}

console.log(`\n## 장면 — S3-A 압박 유닛 (위험 구역 <${PRESS_DANGER_M}m · 총원 ≥${PRESS_MIN_COUNT} · 커버 ≥1)`);
{
  const keep = keptKeys(best.press, 3);
  for (const s of best.pressRaw.filter((x) => keep.has(`${x.tick}:${x.side}:`)).sort((a, b) => a.tick - b.tick)) {
    const roles = s.members
      .map((m) => `${m.id}${m.role === "cover" ? `=커버(${m.laneToId} 레인)` : m.role === "presser" ? "=압박" : "=지원"} ${posOf(s.tick, s.side, m.id)}`)
      .join(" · ");
    const txt =
      `${disp(s.tick)} (t${s.tick}) ${s.side} 수비 — 공 ${ballAtDecision(s.tick)} (배정 시점 위험거리 ${s.dangerM.toFixed(0)}m) 에 ` +
      `**${s.count}명이 함께** 반응(커버 ${s.cover}): ${roles}`;
    console.log(`  ${txt}`);
    rows.push({ tick: s.tick, wave: "S3-A 압박 유닛", line: txt });
  }
}

console.log(`\n## 장면 — S3-B 공유 수비 라인 (멤버 ≥${LINE_MIN_MEMBERS} · 산포 −≥${LINE_MIN_TIGHTEN_M}m)`);
{
  const keep = keptKeys(best.line, 2);
  for (const s of best.lineRaw.filter((x) => keep.has(`${x.tick}:${x.side}:`)).sort((a, b) => a.tick - b.tick)) {
    const who = s.ids.map((id) => `${id} ${posOf(s.tick, s.side, id)}`).join(" · ");
    const txt =
      `${disp(s.tick)} (t${s.tick}) ${s.side} 백라인 ${s.members}명 — 앞뒤로 벌어진 폭 ${s.beforeM.toFixed(1)}m → ` +
      `**${s.afterM.toFixed(1)}m**(앞선 선수가 기다려 한 줄이 된다): ${who}`;
    console.log(`  ${txt}`);
    rows.push({ tick: s.tick, wave: "S3-B 수비 라인", line: txt });
  }
}

console.log(`\n## 장면 — S3-B 레스트디펜스 (공격 중 잔류 상한이 문 틱)`);
{
  const keep = keptKeys(best.rest, 2);
  for (const s of best.restRaw.filter((x) => keep.has(`${x.tick}:${x.side}:`)).sort((a, b) => a.tick - b.tick)) {
    const who = s.ids.map((id, i) => `${id} ${posOf(s.tick, s.side, id)} (더 가려던 것 ${(s.overshootM[i] ?? 0).toFixed(1)}m 억제)`).join(" · ");
    const txt =
      `${disp(s.tick)} (t${s.tick}) ${s.side} 공격 중 — 뒤에 남기로 한 ${s.assigned}명 중 ${s.capped}명이 ` +
      `**하프라인 앞에서 멈춘다**: ${who}`;
    console.log(`  ${txt}`);
    rows.push({ tick: s.tick, wave: "S3-B 레스트디펜스", line: txt });
  }
}

console.log(`\n## 통합 목록 (시계 순 — 한 번 재생하며 순서대로)`);
for (const r of rows.sort((a, b) => a.tick - b.tick)) {
  console.log(`  ${disp(r.tick).padStart(5)}  t${String(r.tick).padStart(4)}  [${r.wave}]`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 빈도 — "많이 보일 것"으로 기대하고 보면 리뷰가 실패한다. 먼저 밝힌다.
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n## 이 경기(seed ${SEED})에서 각 기제가 실제로 몇 번 나오나`);
const c = counts(best);
console.log(`  M3-C 스루패스   품질 하한 통과 ${c[0]}건 (원표본 ${best.throughRaw.length})`);
// 눈금은 그대로 두고 config 만 롤백해 같은 시드를 다시 센다 — "전반적 인상" 대조(틱 정렬 아님).
const offScan = scanSeed(SEED, OFF);
const oc = counts(offScan);
console.log(`  M3-B 레인 예측  품질 하한 통과 ${c[1]}건 (원표본 ${best.laneRaw.length})`);
console.log(`  S3-A 압박 유닛  품질 하한 통과 ${c[2]}건 (원표본 ${best.pressRaw.length} 팀-틱 · 라벨 미완으로 뺀 틱 ${best.pressUnlabelled})`);
console.log(`  S3-B 수비 라인  품질 하한 통과 ${c[3]}건 (원표본 ${best.lineRaw.length} 팀-틱)`);
console.log(`  S3-B 레스트     품질 하한 통과 ${c[4]}건 (원표본 ${best.restRaw.length} 팀-틱)`);

console.log(`\n## 같은 시드 off 팔 — 같은 자[尺]로 세면 (전반적 인상 대조 · 틱 정렬 아님)`);
console.log(`  | 기제 | on | off |`);
console.log(`  |---|---|---|`);
const names = ["M3-C 스루패스", "M3-B 레인 예측", "S3-A 압박 유닛", "S3-B 수비 라인", "S3-B 레스트"];
for (let i = 0; i < names.length; i++) console.log(`  | ${names[i]} | ${c[i]} | ${oc[i]} |`);
