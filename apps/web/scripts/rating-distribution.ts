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
 * # ⚠️ 실덱(라이브 입력 10조합 × 덱당 N시드) — 픽스처와 **반드시 같이** 본다
 * node tools/run-gate.mjs --label ratedist -- \
 *   npx tsx apps/web/scripts/rating-distribution.ts --real-decks --seeds 5
 *
 * # 캐시를 무시하고 다시 시뮬 (⚠️ 픽스처 모드 전용 — 실덱 경로는 캐시 자체가 없다)
 * npx tsx apps/web/scripts/rating-distribution.ts --fresh
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
 * 2-b. ⚠️ **기본(픽스처) 모드의 "N시드"는 한 매치업의 RNG N회다.** `makeTacticalInput` 은
 *    시드마다 `seed` 필드만 다르고 포메이션·전술·능력치가 전부 같다 → 입력 분포가 고정이라
 *    **덱마다 달라지는 결함을 원리적으로 못 잡는다**(#374 가 엔진에서 겪은 그것).
 *    그래서 계수를 바꾸면 **`--real-decks` 도 같이** 본다. 실제로 두 모드는 그룹 **순서가
 *    다르다**(픽스처는 MF 최고·FW 최저, 실덱은 FW 최고·MF 최저) — 한쪽만 보면 오독한다.
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
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SelectData, TacticalInput } from "@hmb/shared";
import { runMatch } from "../../../packages/engine/src/match";
import { defaultEngineConfig } from "../../../packages/engine/src/config";
import { makeSelectData, makeTacticalInput } from "../../../packages/engine/src/fixtures";
import { REALISM_SEEDS } from "../../../packages/engine/src/realism/harness";
import { loadAllRealDeckCases } from "../../../packages/engine/src/realism/real-decks";
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
  return sampleMatch(seed, makeSelectData(), makeTacticalInput("H", seed), makeTacticalInput("A", seed));
}

/** 임의 입력 3종세트로 한 경기를 돌려 표본을 뽑는다(픽스처·실덱 공용 경로). */
export function sampleMatch(
  seed: string,
  select: SelectData,
  home: TacticalInput,
  away: TacticalInput,
): { samples: PlayerSample[]; motmKey: string | null } {
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
  /** 이 표본을 만든 코드의 지문. 안 맞으면 캐시를 버린다(아래 참조). */
  fingerprint?: string;
}

export const ENGINE_SRC_DIR = fileURLToPath(new URL("../../../packages/engine/src", import.meta.url));

/**
 * 지문에 들어가는 파일 목록(정렬 고정). 테스트가 "무엇을 세는지"를 직접 본다.
 *
 * 대상 = `packages/engine/src/**` 의 `.ts`(**테스트 제외** — 표본에 영향이 없고, 넣으면 엔진
 * 테스트를 고칠 때마다 헛되이 재시뮬한다) + `.json`(실덱 입력이 여기 있다).
 */
export function engineSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if ((p.endsWith(".ts") && !p.endsWith(".test.ts")) || p.endsWith(".json")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** 경로 + 내용을 같이 해시한다 — 그래야 **파일이 사라지거나 이름이 바뀌는 것**도 잡힌다. */
export function hashSources(root: string): string {
  const h = createHash("sha256");
  for (const f of engineSourceFiles(root)) {
    h.update(f.slice(root.length));
    h.update(createHash("sha256").update(readFileSync(f)).digest());
  }
  return h.digest("hex");
}

/**
 * 엔진 **소스** 해시 — `config.version` 이 못 덮는 축을 덮는다.
 *
 * ⚠️ **`config.version` 은 "엔진이 바뀌었다"의 신호가 아니다.** 튜닝 웨이브에서는 코드를 고치고도
 * 버전을 안 올리는 것이 흔하고(범프는 "재현 계약이 바뀔 때"다 — 루트 CLAUDE.md §6), 그 상태에서
 * 지문이 그대로면 하네스가 **낡은 표본을 조용히 재사용**한다 = m6 이 막겠다던 사고가 이 축에만
 * 남아 있었다(#403 통합 검증 minor-5). 비용은 1회 수십 ms 라 캐시를 한 번 잘못 쓰는 것보다 싸다.
 */
let engineSrcHashMemo: string | null = null;
function engineSourceHash(): string {
  engineSrcHashMemo ??= hashSources(ENGINE_SRC_DIR);
  return engineSrcHashMemo;
}

/**
 * 캐시 무효화 키 — **표본을 만든 것이 바뀌면 캐시를 버린다.**
 *
 * ⚠️ 종전에는 **시드 목록만** 대조했다. 계수 스윕은 사후 채점이라 안전했지만,
 * **엔진이나 `computePlayerStats` 가 바뀌면 낡은 표본을 조용히 돌려준다** — 그러면 hero 가
 * 조용히 틀린 근거로 밸런스를 잡는다. 이 에픽에서 죽은 하네스로 **네 번** 사고가 났다.
 *
 * 지문 = 엔진 `config.version` + **엔진 소스 해시**(버전을 안 올린 엔진 수정, minor-5) +
 * 집계 모듈(`player-stats.ts`) 소스 해시 + 모드/시드.
 * (평점 계수는 **일부러 안 넣는다** — 표본은 계수와 무관하고, 넣으면 스윕마다 재시뮬한다.)
 */
export function fingerprintOf(mode: string, seeds: string[], engineHash: string = engineSourceHash()): string {
  const srcPath = fileURLToPath(new URL("../src/match/player-stats.ts", import.meta.url));
  const src = readFileSync(srcPath, "utf8");
  return createHash("sha256")
    .update(`${defaultEngineConfig.version}\n`)
    .update(`engine=${engineHash}\n`)
    .update(`mode=${mode}\n`)
    .update(`seeds=${seeds.join(",")}\n`)
    .update(createHash("sha256").update(src).digest("hex"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * 다시드 표본. `cachePath` 를 주면 시뮬 결과를 재사용한다(계수 스윕이 즉시 끝난다).
 * `fresh` 면 캐시를 읽지 않고 다시 돌린다.
 */
export function buildSamples(
  seeds: string[],
  cachePath?: string,
  opts: { fresh?: boolean; mode?: string } = {},
): SampleSet {
  const mode = opts.mode ?? "fixture";
  const fp = fingerprintOf(mode, seeds);
  if (cachePath && !opts.fresh && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as SampleSet;
    if (cached.fingerprint === fp) return cached;
    // 지문 불일치 = 엔진·집계 모듈·시드셋 중 뭔가 바뀌었다. **조용히 쓰지 않는다.**
    process.stderr.write(`캐시 무효(지문 불일치) — 다시 시뮬한다: ${cachePath}\n`);
  }
  const samples: PlayerSample[] = [];
  const motmBySeed: Record<string, string | null> = {};
  for (const seed of seeds) {
    const r = sampleSeed(seed);
    samples.push(...r.samples);
    motmBySeed[seed] = r.motmKey;
  }
  const set: SampleSet = { seeds, samples, motmBySeed, fingerprint: fp };
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(set));
  }
  return set;
}

// ── 실덱 모드 (m4) ───────────────────────────────────────────────────────

/**
 * **실덱 표본** — `packages/engine/src/realism/real-decks/` 의 라이브 입력 조합으로 잰다.
 *
 * ⚠️ **왜 픽스처만으로는 부족한가**: `makeTacticalInput` 은 시드마다 `seed` 필드만 다르고
 * 포메이션·전술·능력치가 **완전히 동일**하다. 즉 "100시드"는 **한 매치업의 RNG 100회**이고,
 * 덱마다 달라지는 결함을 원리적으로 못 잡는다(#374 가 엔진 쪽에서 세운 바로 그 교훈).
 * 실덱은 4-4-2·5-3-2·로우블록 등 **입력 분포 자체**가 다르다.
 *
 * 판정 규율도 다르다 — **평균이 아니라 최악 덱**을 본다(`--real-decks` 출력의 덱별 spread).
 *
 * ⚠️ **이 경로는 캐시를 쓰지 않는다 — 그래서 `--cache`·`--fresh` 는 실덱 모드에서 무동작이다**
 * (#403 통합 검증 minor-5 부수). 캐시가 없으니 낡은 표본을 돌려줄 일도 없고, 대신 매번 재시뮬한다
 * (덱 10 × 시드 N). 지문은 **일관성을 위해** 같은 규칙으로 붙여 둔다 — 결과 JSON 을 다른 도구가
 * 물었을 때 "무엇으로 만든 표본인가"가 픽스처 모드와 같은 축으로 읽히게.
 * 캐시를 붙이고 싶다면 `buildSamples` 와 **같은 `fingerprintOf`** 를 쓰고, 실덱 입력(JSON)이
 * 엔진 소스 해시에 이미 들어 있다는 점을 확인해라(`engineSourceHash` 는 `.json` 도 센다).
 */
export function buildRealDeckSamples(seedsPerDeck: number): SampleSet {
  const cases = loadAllRealDeckCases();
  const samples: PlayerSample[] = [];
  const motmBySeed: Record<string, string | null> = {};
  const seeds: string[] = [];
  for (const c of cases) {
    for (let i = 0; i < seedsPerDeck; i++) {
      // 덱의 실제 시드에서 결정론적으로 파생(시드를 지어내지 않는다).
      const seed = i === 0 ? c.seed : `${i}${c.seed}`;
      const key = `${c.id}#${seed}`;
      const r = sampleMatch(seed, c.selectData, c.homeInput, c.awayInput);
      // 표본의 seed 필드를 덱별로 유일하게 — MOTM 집계가 덱을 섞지 않게.
      for (const s of r.samples) samples.push({ ...s, seed: key });
      motmBySeed[key] = r.motmKey;
      seeds.push(key);
    }
  }
  return { seeds, samples, motmBySeed, fingerprint: fingerprintOf("real-decks", seeds) };
}

/** 덱 id 별로 표본을 가른다(최악 덱을 보기 위해). */
export function byDeck(set: SampleSet): Map<string, SampleSet> {
  const out = new Map<string, SampleSet>();
  for (const s of set.samples) {
    const deck = s.seed.split("#")[0]!;
    let cur = out.get(deck);
    if (!cur) {
      cur = { seeds: [], samples: [], motmBySeed: set.motmBySeed };
      out.set(deck, cur);
    }
    cur.samples.push(s);
    if (!cur.seeds.includes(s.seed)) cur.seeds.push(s.seed);
  }
  return out;
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
  realDecks: boolean;
  fresh: boolean;
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
    realDecks: false,
    fresh: false,
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
    else if (t === "--real-decks") a.realDecks = true;
    else if (t === "--fresh") a.fresh = true;
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
  const t0 = Date.now();
  // 실덱 모드는 시드가 덱에서 나오므로 `--seeds` 는 **덱당 시드 수**로 읽는다(기본 5).
  const perDeck = argv.includes("--seeds") ? a.seeds : 5;
  // 무동작 플래그를 조용히 삼키지 않는다 — 실덱 경로엔 캐시가 없다(`buildRealDeckSamples` 주석).
  if (a.realDecks && (a.fresh || argv.includes("--cache"))) {
    process.stderr.write("⚠️ 실덱 모드는 캐시를 쓰지 않는다 — `--cache`/`--fresh` 는 무동작이다.\n");
  }
  const set = a.realDecks
    ? buildRealDeckSamples(perDeck)
    : buildSamples(seedsFor(a.seeds), a.cache, { fresh: a.fresh });
  const seeds = set.seeds;
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
  out.push(
    `${a.realDecks ? "실덱" : "픽스처"} · 경기 ${seeds.length}개 · 선수-경기 표본 ${set.samples.length}개 · 시뮬 ${(simMs / 1000).toFixed(1)}s`,
  );
  // `defaultEngineConfig.version` 은 이미 `engine@x.y.z` 형태다 — 접두를 또 붙이지 않는다.
  out.push(`config = defaultEngineConfig(리얼, ${defaultEngineConfig.version}) · 계수 = ${a.weights ?? "현재 RATING_WEIGHTS"}`);
  out.push("");
  out.push(renderTable(dist, a.realDecks ? "포지션 그룹별 평점 분포 (실덱 pooled)" : "포지션 그룹별 평점 분포"));
  if (a.realDecks) {
    // ⚠️ 판정은 평균이 아니라 **최악 덱**이다(#374 규율). 덱별 spread 를 같이 낸다.
    out.push("");
    out.push("### 덱별 그룹 중앙값 spread (최악 덱이 판정 기준)");
    out.push("| 덱 | n | GK | DF | MF | FW | spread |");
    out.push("|----|---|----|----|----|----|--------|");
    const rows = [...byDeck(set).entries()]
      .map(([deck, sub]) => {
        const d = summarize(sub, w);
        const m = (g: PositionGroup): string => {
          const row = d.find((x) => x.group === g)!;
          return row.n > 0 ? row.median.toFixed(2) : "—";
        };
        return { deck, n: sub.samples.length, gk: m("GK"), df: m("DF"), mf: m("MF"), fw: m("FW"), sp: medianSpread(d) };
      })
      .sort((x, y) => y.sp - x.sp);
    for (const r of rows) {
      out.push(`| ${r.deck} | ${r.n} | ${r.gk} | ${r.df} | ${r.mf} | ${r.fw} | **${r.sp.toFixed(2)}** |`);
    }
  }
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
