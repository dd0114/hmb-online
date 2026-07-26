/**
 * balance-sweep — 엔진 config 노브를 격자로 훑어 **밸런스 재보정 지점을 한 번에 고르는** 도구.
 *
 * ## 왜 있나
 * 엔진 동작이 바뀌면(#176 데드볼 개편, #182 세트피스 등) 밸런스가 밀리고, §2-4 원칙상 코드가 아니라
 * **config 로만** 되돌린다. 그때마다 세션이 임시 테스트를 만들어 스윕하고 지우기를 반복했다.
 * 그 과정에서 반복해서 걸린 함정 두 개를 도구로 굳혀 둔다:
 *
 *  1. **20시드는 검정력이 부족하다.** 팀당 슛은 팀-경기 SD ≈ 5 라 20시드(팀-경기 40)의 표준오차가
 *     0.8, 골은 0.15 다. 밴드 폭이 그보다 좁은 지표(골 1.4–1.65)는 20시드 한 판으로 판단하면
 *     노이즈를 튜닝하게 된다(실측: 같은 트리가 20시드 골 1.20 ↔ 60시드 1.55).
 *     → **게이트(20시드)와 모집단(60시드)을 항상 같이** 찍는다.
 *  2. **기준선은 내 출력이 아니라 픽스 전 트리다.** "전보다 나아졌나"는 origin/main 을 별도
 *     워크트리로 체크아웃해 같은 명령을 돌려 비교한다(`--label` 로 표에 이름을 남긴다).
 *
 * 밴드는 `packages/engine/src/realism/bench.ts` 단일 출처를 그대로 쓴다(gap-report 와 같은 표).
 *
 * ## 사용법
 *   npx tsx tools/balance-sweep.mjs                                   # 현재 config 그대로 1점
 *   npx tsx tools/balance-sweep.mjs --set decisionWeights.shoot=0.27,0.30
 *   npx tsx tools/balance-sweep.mjs --set decisionWeights.shoot=0.26,0.27 --set rules.foul.base=0.017,0.019
 *   npx tsx tools/balance-sweep.mjs --seeds 20 --set contest.xgBase=0.185,0.195   # 빠른 1차 탐색
 *   npx tsx tools/balance-sweep.mjs --label main-baseline                          # 기준선 라벨
 *
 * 옵션
 *   --set <점표기경로>=<값1,값2,…>   스윕할 노브(여러 번 지정 가능 → 데카르트 곱)
 *   --seeds 20,60                     찍을 표본(기본 20,60). 20=게이트 시드, 60=확장 시드
 *   --metrics shots,goals,…           출력 지표(기본 아래 CORE)
 *   --label <문자열>                   표 앞에 붙일 라벨(기준선 비교용)
 *
 * ## 실행시간
 * 1점당 20시드 ≈ 3.5초 · 60시드 ≈ 9.5초. 격자 6점 × (20+60) ≈ 80초. 실측(tsx 기동 ~1초 별도).
 * 격자를 넓게 잡기 전에 `--seeds 20` 으로 훑고, 최종 후보만 60시드로 확정하는 순서를 권장한다.
 */
import { aggregateRealism, REALISM_SEEDS } from "../packages/engine/src/realism/harness.ts";
import { defaultEngineConfig } from "../packages/engine/src/config.ts";
import { BENCH, inBench } from "../packages/engine/src/realism/bench.ts";

const argv = process.argv.slice(2);
const takeAll = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1] != null) out.push(argv[++i]);
  return out;
};
const takeOne = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};

/** 기본 출력 지표 — 밸런스 판단에 실제로 쓰는 것들. */
const CORE = ["shots", "goals", "onTarget", "shotConvPct", "xgPerShot", "fouls", "corners", "throwIns", "passSuccessPct", "avgWidthM", "avgDistanceKm"];
const METRICS = takeOne("metrics", CORE.join(",")).split(",");
const SEED_COUNTS = takeOne("seeds", "20,60").split(",").map(Number);
const LABEL = takeOne("label", "");

/** 확장 시드 = REALISM_SEEDS(게이트 20개) + 결정론 등차. 다른 도구/계약과 같은 규칙을 쓴다. */
function seedsOf(n) {
  const s = [...REALISM_SEEDS];
  for (let i = 0; s.length < n; i++) s.push(String(1000000007 + i * 7919));
  return s.slice(0, n);
}

/** "a.b.c=1,2" → {path:["a","b","c"], values:[1,2]} */
const knobs = takeAll("set").map((spec) => {
  const eq = spec.indexOf("=");
  if (eq < 0) throw new Error(`--set 형식은 경로=값1,값2 다: ${spec}`);
  return { path: spec.slice(0, eq).split("."), values: spec.slice(eq + 1).split(",").map(Number) };
});

function withKnob(cfg, path, value) {
  if (path.length === 1) return { ...cfg, [path[0]]: value };
  const [head, ...rest] = path;
  if (cfg[head] == null) throw new Error(`config 에 없는 경로: ${head}`);
  return { ...cfg, [head]: withKnob(cfg[head], rest, value) };
}

/** 노브 격자의 데카르트 곱. 노브가 없으면 현재 config 1점. */
function grid() {
  let points = [{ cfg: defaultEngineConfig, tag: [] }];
  for (const k of knobs) {
    const next = [];
    for (const p of points) {
      for (const v of k.values) {
        next.push({ cfg: withKnob(p.cfg, k.path, v), tag: [...p.tag, `${k.path.join(".")}=${v}`] });
      }
    }
    points = next;
  }
  return points;
}

const benchOf = (key) => BENCH.find((b) => b.key === key);
const points = grid();

console.log(
  `=== balance-sweep (${defaultEngineConfig.version})${LABEL ? ` — ${LABEL}` : ""} — ` +
    `${points.length}점 × 시드[${SEED_COUNTS.join(",")}] ===`,
);
console.log(`밴드 출처: packages/engine/src/realism/bench.ts (gap-report 와 동일). ! = 밴드 이탈\n`);

for (const p of points) {
  const head = p.tag.length ? p.tag.join(" ") : "(현재 config)";
  for (const n of SEED_COUNTS) {
    const a = aggregateRealism(p.cfg, seedsOf(n));
    const cells = METRICS.map((key) => {
      const v = a.mean[key];
      if (v == null) return `${key}=?`;
      const b = benchOf(key);
      const flag = b ? (inBench(v, b) ? " " : "!") : " ";
      const se = a.sd[key] != null ? a.sd[key] / Math.sqrt(a.teamMatches) : null;
      return `${key} ${v.toFixed(2)}${flag}${se != null ? `(se${se.toFixed(2)})` : ""}`;
    });
    console.log(`${head} [${String(n).padStart(2)}시드] ${cells.join(" · ")}`);
  }
}

console.log(
  `\n판단 요령: **20시드와 60시드가 같은 방향**일 때만 그 노브 효과를 신뢰한다.` +
    `\n엇갈리면(예: 20시드만 이탈) 노이즈일 가능성이 크니 표본을 늘려 확인하고, 노이즈를 쫓아 튜닝하지 않는다.` +
    `\n"전보다 나아졌나"는 origin/main 워크트리에서 --label main-baseline 으로 같은 명령을 돌려 비교한다.`,
);
