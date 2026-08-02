/**
 * #403 W1b — 평점 분포 실측 하네스 (포지션 그룹별).
 *
 * ## 무엇을 하나
 * **리얼 config**(`defaultEngineConfig`)로 N개 시드의 경기를 돌려, `computePlayerStats` 로
 * 선수별 기록을 뽑고, 포지션 그룹(GK/DF/MF/FW)별 **평점 분포**를 표로 낸다.
 * hero 가 `RATING_WEIGHTS` 를 조정한 뒤 다시 돌려 "분포가 어느 방향으로 움직였나"를 본다.
 *
 * ## 사용법
 * ```bash
 * # 기본(40시드, 현재 RATING_WEIGHTS) — 시뮬 결과는 캐시된다
 * npx tsx apps/web/scripts/rating-distribution.ts
 *
 * # 시드 수 지정 / 시드셋 분할(안정성 확인 — A/B 가 같은 답을 내야 표본이 충분한 것)
 * npx tsx apps/web/scripts/rating-distribution.ts --seeds 40
 * npx tsx apps/web/scripts/rating-distribution.ts --seeds 40 --split
 *
 * # 계수를 바꿔서 보기(소스를 안 고치고) — RATING_WEIGHTS 와 같은 형상의 부분 JSON
 * npx tsx apps/web/scripts/rating-distribution.ts --weights /tmp/cand.json
 * #   예: {"attack":{"goal":1.2},"defence":{"tackle":0.05}}
 *
 * # 두 계수표를 같은 시드셋에서 나란히(= before/after 표)
 * npx tsx apps/web/scripts/rating-distribution.ts --compare /tmp/before.json,/tmp/after.json
 *
 * # 원자료(그룹별 평균 기록량) — 계수를 "엔진 볼륨"에 맞춰 사이징할 때
 * npx tsx apps/web/scripts/rating-distribution.ts --volumes
 *
 * # JSON 으로(다른 도구에 물릴 때)
 * npx tsx apps/web/scripts/rating-distribution.ts --json
 * ```
 *
 * ## 설계 규율 (어기면 측정이 거짓말을 한다)
 * 1. **리얼 config 로만 잰다.** 쇼케이스(`generate-demo.ts` 의 `showcaseConfig`)는 골이 과다하도록
 *    일부러 튜닝된 관전용이라 FW 가 구조적으로 부풀려진다 — 루트 CLAUDE.md §2-6.
 * 2. **다시드 필수.** 엔진은 카오스적이라 한 경기로는 아무것도 못 말한다(memory
 *    `balance-measure-multiseed`). `--split` 이 시드셋을 홀/짝으로 갈라 같은 계수로 재서,
 *    그룹 중앙값이 시드셋을 바꿔도 안 흔들리는지 **실측으로** 보여 준다.
 * 3. **로그 생성은 엔진의 기존 경로를 그대로 쓴다.** `runMatch` + `makeSelectData` +
 *    `makeTacticalInput` — `packages/engine/src/realism/harness.ts` 의 다시드 집계와 같은 경로다.
 *    TS 로 재구현하면 검증이 구현과 같은 실수를 공유한다(`tools/league-difficulty-sweep.ts` 선례).
 * 4. **포지션은 엔진 픽스처에서 읽는다.** 역할표를 여기에 다시 적지 않는다 —
 *    `SelectData.players[].position` 이 이미 "GK"/"DF"/"MF"/"FW" 다.
 * 5. **평점은 `computeRating` 을 부른다.** 여기서 산식을 다시 쓰지 않는다. 계수 스윕은
 *    `ratingWithWeights`(같은 산식, 표만 주입)로 한다.
 *
 * ⚠️ 엔진은 **읽기만** 한다(무접촉).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMatch } from "../../../packages/engine/src/match";
import { defaultEngineConfig } from "../../../packages/engine/src/config";
import { makeSelectData, makeTacticalInput } from "../../../packages/engine/src/fixtures";
import { REALISM_SEEDS } from "../../../packages/engine/src/realism/harness";
import {
  computePlayerStats,
  ratingWithWeights,
  playerKey,
  RATING_WEIGHTS,
  type PlayerStatLine,
  type PlayerPosition,
  type PlayerStatsResult,
  type RatingWeights,
  type StatMatchLog,
  type TeamSide,
} from "../src/match/player-stats";

// ── 시드 ─────────────────────────────────────────────────────────────────

/**
 * 시드는 엔진의 고정 시드(`REALISM_SEEDS`, 20개)를 **그대로 재사용**하고, 더 필요하면
 * 같은 파생 규칙(`7`·`13` 접두 = `GUARD_SEEDS` 방식)으로 늘린다. 여기서 새 시드를 지어내면
 * 엔진 밸런스 측정과 다른 표본을 보게 된다.
 */
export function seedsFor(n: number): string[] {
  const out: string[] = [];
  const prefixes = ["", "7", "13", "29", "31"];
  for (const p of prefixes) {
    for (const s of REALISM_SEEDS) {
      if (out.length >= n) return out;
      out.push(`${p}${s}`);
    }
  }
  return out;
}

// ── 표본 ─────────────────────────────────────────────────────────────────

export type PositionGroup = PlayerPosition;

export interface PlayerSample {
  seed: string;
  key: string;
  team: TeamSide;
  playerId: string;
  group: PositionGroup;
  line: PlayerStatLine;
}

/** 한 시드의 경기를 리얼 config 로 돌려 선수별 기록을 뽑는다. */
export function sampleSeed(seed: string): { samples: PlayerSample[]; motmKey: string | null } {
  const select = makeSelectData();
  const home = makeTacticalInput("H", seed);
  const away = makeTacticalInput("A", seed);
  const log = runMatch(seed, home, away, select, defaultEngineConfig);

  // 포지션·GK 키는 **엔진 픽스처의 SelectData 에서 읽는다**(역할표 재작성 금지).
  const positions: Record<string, PlayerPosition> = {};
  const gkKeys = new Set<string>();
  for (const side of ["home", "away"] as const) {
    for (const p of select[side].players) {
      const k = playerKey(side, p.playerId);
      const pos = p.position as PlayerPosition;
      positions[k] = pos;
      if (pos === "GK") gkKeys.add(k);
    }
  }

  const res: PlayerStatsResult = computePlayerStats(log as unknown as StatMatchLog, {
    positions,
    gkKeys,
  });

  const samples: PlayerSample[] = res.players
    .filter((p) => p.ticksPlayed > 0)
    .map((line) => ({
      seed,
      key: line.key,
      team: line.team,
      playerId: line.playerId,
      group: positions[line.key] ?? "MF",
      line,
    }));

  return { samples, motmKey: res.motm?.key ?? null };
}

export interface SampleSet {
  seeds: string[];
  samples: PlayerSample[];
  /** 시드별 MOTM 키 — MOTM 점유율은 **계수에 따라 달라지므로** 재계산한다(캐시엔 참고용). */
  motmBySeed: Record<string, string | null>;
}

/** 다시드 표본. `cachePath` 를 주면 시뮬 결과를 재사용한다(계수 스윕이 즉시 끝난다). */
export function buildSamples(seeds: string[], cachePath?: string): SampleSet {
  if (cachePath && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as SampleSet;
    if (cached.seeds.length === seeds.length && cached.seeds.every((s, i) => s === seeds[i])) {
      return cached;
    }
  }
  const samples: PlayerSample[] = [];
  const motmBySeed: Record<string, string | null> = {};
  for (const seed of seeds) {
    const r = sampleSeed(seed);
    samples.push(...r.samples);
    motmBySeed[seed] = r.motmKey;
  }
  const set: SampleSet = { seeds, samples, motmBySeed };
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(set));
  }
  return set;
}

// ── 집계 ─────────────────────────────────────────────────────────────────

export interface GroupDist {
  group: PositionGroup;
  n: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  mean: number;
  /** 상한(`weights.max`)에 붙은 비율(%). */
  saturatedPct: number;
  /** 하한(`weights.min`)에 붙은 비율(%). */
  floorPct: number;
  /** 기본점 미만 비율(%). */
  belowBasePct: number;
  /** 이 그룹이 MOTM 을 가져간 비율(%). */
  motmSharePct: number;
}

const GROUP_ORDER: PositionGroup[] = ["GK", "DF", "MF", "FW"];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * 주어진 계수표로 표본 전체를 재채점하고 그룹별 분포를 낸다.
 *
 * ⚠️ MOTM 은 **여기서 다시 뽑는다** — 계수가 바뀌면 MOTM 도 바뀌기 때문이다.
 * 선정 규칙은 `pickMotm` 과 같은 축(최고 평점, 동점이면 골→어시→키)이되, 여기서는
 * 점유율만 보므로 시드별 최고 평점 1명이면 충분하다.
 */
export function summarize(set: SampleSet, weights: RatingWeights): GroupDist[] {
  const scored = set.samples.map((s) => ({
    ...s,
    rating: ratingWithWeights(s.line, s.group, weights),
  }));

  // 시드별 MOTM (계수 의존) → 그룹 점유 카운트
  const motmCount: Record<string, number> = {};
  let motmTotal = 0;
  for (const seed of set.seeds) {
    const rows = scored.filter((s) => s.seed === seed);
    if (rows.length === 0) continue;
    let best = rows[0]!;
    for (const r of rows) {
      if (r.rating > best.rating) best = r;
      else if (r.rating === best.rating) {
        if (r.line.goals > best.line.goals) best = r;
        else if (r.line.goals === best.line.goals && r.line.assists > best.line.assists) best = r;
        else if (
          r.line.goals === best.line.goals &&
          r.line.assists === best.line.assists &&
          r.key < best.key
        )
          best = r;
      }
    }
    motmCount[best.group] = (motmCount[best.group] ?? 0) + 1;
    motmTotal += 1;
  }

  return GROUP_ORDER.map((group) => {
    const vals = scored.filter((s) => s.group === group).map((s) => s.rating).sort((a, b) => a - b);
    const n = vals.length;
    const sat = vals.filter((v) => v >= weights.max).length;
    const flr = vals.filter((v) => v <= weights.min).length;
    const below = vals.filter((v) => v < weights.base).length;
    return {
      group,
      n,
      median: r2(quantile(vals, 0.5)),
      p25: r2(quantile(vals, 0.25)),
      p75: r2(quantile(vals, 0.75)),
      min: r2(vals[0] ?? 0),
      max: r2(vals[n - 1] ?? 0),
      mean: r2(vals.reduce((a, b) => a + b, 0) / (n || 1)),
      saturatedPct: r2((sat / (n || 1)) * 100),
      floorPct: r2((flr / (n || 1)) * 100),
      belowBasePct: r2((below / (n || 1)) * 100),
      motmSharePct: r2(((motmCount[group] ?? 0) / (motmTotal || 1)) * 100),
    };
  });
}

/** 그룹 중앙값의 최대−최소(= "한쪽만 꺼졌나"의 한 줄 요약). */
export function medianSpread(dist: GroupDist[]): number {
  const m = dist.map((d) => d.median);
  return r2(Math.max(...m) - Math.min(...m));
}

// ── 원자료(계수 사이징용) ────────────────────────────────────────────────

const VOLUME_KEYS = [
  "goals", "assists", "keyPasses", "shots", "shotsOnTarget",
  "passesAttempted", "passesCompleted", "longPassesCompleted",
  "carries", "carryProgressM",
  "tackles", "interceptions", "clearances",
  "dispossessed", "fouls", "yellowCards",
  "saves", "goalsConceded",
] as const;

export type VolumeKey = (typeof VOLUME_KEYS)[number];

/** 그룹별 **평균 기록량**. 실축 계수를 그대로 걸면 여기서 어긋난다 — 사이징의 근거. */
export function volumes(set: SampleSet): Record<PositionGroup, Record<VolumeKey, number>> {
  const out = {} as Record<PositionGroup, Record<VolumeKey, number>>;
  for (const group of GROUP_ORDER) {
    const rows = set.samples.filter((s) => s.group === group);
    const rec = {} as Record<VolumeKey, number>;
    for (const k of VOLUME_KEYS) {
      rec[k] = r2(rows.reduce((a, s) => a + (s.line[k] as number), 0) / (rows.length || 1));
    }
    out[group] = rec;
  }
  return out;
}

// ── 계수표 병합 ──────────────────────────────────────────────────────────

type Deep = Record<string, unknown>;

/** `RATING_WEIGHTS` 형상의 **부분** JSON 을 깊게 덮어쓴다(hero 가 한두 값만 건드릴 수 있게). */
export function mergeWeights(base: RatingWeights, override: unknown): RatingWeights {
  const clone = JSON.parse(JSON.stringify(base)) as Deep;
  const walk = (dst: Deep, src: Deep): void => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object" && !Array.isArray(v) && typeof dst[k] === "object") {
        walk(dst[k] as Deep, v as Deep);
      } else {
        dst[k] = v;
      }
    }
  };
  if (override && typeof override === "object") walk(clone, override as Deep);
  return clone as unknown as RatingWeights;
}

// ── 표 렌더 ──────────────────────────────────────────────────────────────

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function padL(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

export function renderTable(dist: GroupDist[], title: string): string {
  const head = ["그룹", "n", "중앙값", "p25", "p75", "최대", "최소", "포화%", "바닥%", "기본점미만%", "MOTM%"];
  const widths = [4, 5, 7, 6, 6, 6, 6, 6, 6, 11, 7];
  const rows = dist.map((d) => [
    d.group,
    String(d.n),
    d.median.toFixed(2),
    d.p25.toFixed(2),
    d.p75.toFixed(2),
    d.max.toFixed(2),
    d.min.toFixed(2),
    d.saturatedPct.toFixed(1),
    d.floorPct.toFixed(1),
    d.belowBasePct.toFixed(1),
    d.motmSharePct.toFixed(1),
  ]);
  const line = (cells: string[]): string =>
    "| " + cells.map((c, i) => (i === 0 ? pad(c, widths[i]!) : padL(c, widths[i]!))).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  return [
    `### ${title}`,
    line(head),
    sep,
    ...rows.map(line),
    "",
    `그룹 중앙값 최대−최소 = **${medianSpread(dist).toFixed(2)}**`,
  ].join("\n");
}

export function renderVolumes(v: Record<PositionGroup, Record<VolumeKey, number>>): string {
  const head = ["지표", ...GROUP_ORDER];
  const rows = VOLUME_KEYS.map((k) => [k, ...GROUP_ORDER.map((g) => v[g][k].toFixed(2))]);
  const w = [22, 9, 9, 9, 9];
  const line = (cells: string[]): string =>
    "| " + cells.map((c, i) => (i === 0 ? pad(c, w[i]!) : padL(c, w[i]!))).join(" | ") + " |";
  return [
    "### 그룹별 평균 기록량(경기당 1인) — 계수 사이징의 근거",
    line(head),
    "|" + w.map((x) => "-".repeat(x + 2)).join("|") + "|",
    ...rows.map(line),
  ].join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────

interface Args {
  seeds: number;
  split: boolean;
  json: boolean;
  volumes: boolean;
  weights?: string;
  compare?: string[];
  cache: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    seeds: 40,
    split: false,
    json: false,
    volumes: false,
    // ⚠️ 기본 캐시는 **git 이 무시하는 곳**에 둔다 — `.cache/` 는 `.gitignore` 에 없어서
    //    거기에 쓰면 하네스를 한 번 돌릴 때마다 작업 트리가 더러워진다.
    cache: "node_modules/.cache/hmb-rating-samples.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--seeds") a.seeds = Number(argv[++i]);
    else if (t === "--split") a.split = true;
    else if (t === "--json") a.json = true;
    else if (t === "--volumes") a.volumes = true;
    else if (t === "--weights") a.weights = argv[++i];
    else if (t === "--compare") a.compare = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (t === "--cache") a.cache = argv[++i]!;
  }
  return a;
}

function loadWeights(path: string | undefined): RatingWeights {
  if (!path) return RATING_WEIGHTS as unknown as RatingWeights;
  return mergeWeights(
    RATING_WEIGHTS as unknown as RatingWeights,
    JSON.parse(readFileSync(path, "utf8")),
  );
}

function subset(set: SampleSet, keep: (i: number) => boolean): SampleSet {
  const seeds = set.seeds.filter((_, i) => keep(i));
  const ss = new Set(seeds);
  return {
    seeds,
    samples: set.samples.filter((s) => ss.has(s.seed)),
    motmBySeed: set.motmBySeed,
  };
}

export function main(argv: string[]): void {
  const a = parseArgs(argv);
  const seeds = seedsFor(a.seeds);
  const t0 = Date.now();
  const set = buildSamples(seeds, a.cache);
  const simMs = Date.now() - t0;

  if (a.compare) {
    const out: string[] = [];
    for (const p of a.compare) {
      const w = loadWeights(p === "-" ? undefined : p);
      out.push(renderTable(summarize(set, w), p === "-" ? "현재 RATING_WEIGHTS" : p));
      out.push("");
    }
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  const w = loadWeights(a.weights);
  const dist = summarize(set, w);

  if (a.json) {
    process.stdout.write(
      JSON.stringify({ seeds: seeds.length, dist, spread: medianSpread(dist) }, null, 2) + "\n",
    );
    return;
  }

  const out: string[] = [];
  out.push(`시드 ${seeds.length}개 · 선수-경기 표본 ${set.samples.length}개 · 시뮬 ${(simMs / 1000).toFixed(1)}s`);
  out.push(`config = defaultEngineConfig(리얼) · 계수 = ${a.weights ?? "현재 RATING_WEIGHTS"}`);
  out.push("");
  out.push(renderTable(dist, "포지션 그룹별 평점 분포"));
  if (a.split) {
    out.push("");
    out.push("— 표본 충분성 확인: 같은 계수로 시드셋을 홀/짝으로 갈라 재측정 —");
    out.push("");
    out.push(renderTable(summarize(subset(set, (i) => i % 2 === 0), w), "시드셋 A (짝수 인덱스)"));
    out.push("");
    out.push(renderTable(summarize(subset(set, (i) => i % 2 === 1), w), "시드셋 B (홀수 인덱스)"));
  }
  if (a.volumes) {
    out.push("");
    out.push(renderVolumes(volumes(set)));
  }
  process.stdout.write(out.join("\n") + "\n");
}

// tsx/node 로 직접 실행했을 때만 CLI 로 동작(테스트가 import 할 때는 아니다).
if (process.argv[1] && process.argv[1].endsWith("rating-distribution.ts")) {
  main(process.argv.slice(2));
}
