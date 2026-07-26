/**
 * scan-fixture-seed — e2e `fixture-real.json` 시드 재선정 스캐너. (#186)
 *
 * ## 왜 있나
 * `gen-fixtures.test.ts` 는 real config 매치 하나를 e2e 픽스처로 굽는데, 그 로그엔 희귀 이벤트가
 * **전부** 들어 있어야 관련 스펙이 성립한다. 엔진 튜닝으로 매치 전개가 바뀔 때마다 시드를 다시
 * 골라야 하고(1000000000 → 04 → 13 → …), 그때마다 손으로 스캔하다 조건을 빠뜨려 왔다.
 *
 * 특히 **조건 ⑤(체인 스팬)** 가 빠져서 사고가 났다 — 조건 ①~④만 보고 고른 시드의 세이브→빗나감
 * 체인 스팬이 41틱이라, 그 구간을 실제 재생하는 `restarts.spec.ts` 가 타임아웃으로 삽질했다(#181).
 * 스팬이 짧은 시드를 고르면 같은 계약을 훨씬 싸게 검증한다. 그래서 이 스캐너는 **스팬까지 재고
 * 짧은 순으로 정렬**한다.
 *
 * ## 조건 5개
 *  ① offside 이벤트 존재
 *  ② card 이벤트 존재
 *  ③ penalty 이벤트 존재
 *  ④ #42 체인 존재: save → (라이브 이벤트 ≥1, 그 사이 재시작 없음) → shot(off_target), 45틱 이내
 *     ↳ 판정식은 `restarts.spec.ts` 와 **동일**하게 유지한다. 느슨하게 잡으면 스캔은 통과인데
 *       스펙이 깨진다(실제로 겪음).
 *  ⑤ ④ 체인의 스팬(save → off_target 틱 차)이 짧을 것 — 기본 상한 `--max-span`(20틱).
 *
 * ## 사용법
 *   npx tsx packages/engine/dev-viewer/e2e/scan-fixture-seed.mjs
 *   npx tsx packages/engine/dev-viewer/e2e/scan-fixture-seed.mjs --from 1000000000 --count 200 --max-span 15
 *   npx tsx packages/engine/dev-viewer/e2e/scan-fixture-seed.mjs --all      # 전 시드 조건 매트릭스
 *
 * 옵션: --from(시작 시드, 기본 1000000000) · --count(스캔 개수, 기본 120) · --max-span(기본 20)
 *       --limit(출력 후보 수, 기본 10) · --all(탈락 시드도 전부 출력)
 *
 * ## 실행시간
 * 시드 1개당 90분 매치 1회 ≈ 0.14초 → **120개 스캔 ≈ 17초**, 300개 ≈ 45초 (실측).
 * 결과를 `gen-fixtures.test.ts` 의 SEED 상수에 반영하고, 그 파일 주석의 이력·보유 시드도 갱신한다.
 */
import { runMatch } from "../../src/match.ts";
import { defaultEngineConfig } from "../../src/config.ts";
import { demoSelect, makeTacticalInput } from "../../src/fixtures.ts";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? Number(argv[i + 1]) : dflt;
};
const FROM = arg("from", 1000000000);
const COUNT = arg("count", 120);
const MAX_SPAN = arg("max-span", 20);
const LIMIT = arg("limit", 10);
const SHOW_ALL = argv.includes("--all");

/** restarts.spec.ts #42 와 **동일한** 패턴 정의. 최단 스팬 체인을 반환(없으면 null). */
function findChain(events) {
  const kind = (e) =>
    e.type === "kickoff" ? e.detail || "kickoff" : e.type === "shot" && e.detail ? `shot_${e.detail}` : e.type;
  const RESTART = new Set(["corner", "goal_kick", "throw_in", "free_kick", "kickoff"]);
  let best = null;
  for (let i = 0; i < events.length; i++) {
    if (kind(events[i]) !== "save") continue;
    for (let j = i + 1; j < events.length && events[j].tick <= events[i].tick + 45; j++) {
      const k = kind(events[j]);
      if (RESTART.has(k)) break; // 세이브 직후 곧장 재시작 = 체인 아님
      if (k === "shot_off_target" && j > i + 1) {
        const span = events[j].tick - events[i].tick;
        if (!best || span < best.span) best = { save: events[i].tick, off: events[j].tick, span };
        break;
      }
    }
  }
  return best;
}

const rows = [];
for (let i = 0; i < COUNT; i++) {
  const seed = String(FROM + i);
  const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), demoSelect, defaultEngineConfig);
  const has = (t) => log.events.some((e) => e.type === t);
  const chain = findChain(log.events);
  rows.push({
    seed,
    offside: has("offside"),
    card: has("card"),
    penalty: has("penalty"),
    chain: chain != null,
    span: chain ? chain.span : null,
    saveTick: chain ? chain.save : null,
  });
}

const mark = (b) => (b ? "O" : "·");
const ok = (r) => r.offside && r.card && r.penalty && r.chain && r.span <= MAX_SPAN;
const candidates = rows.filter(ok).sort((a, b) => a.span - b.span || Number(a.seed) - Number(b.seed));

const print = (list, title) => {
  console.log(`\n${title}`);
  console.log("  시드          off card pen chain  스팬  save틱");
  for (const r of list) {
    console.log(
      `  ${r.seed}   ${mark(r.offside)}   ${mark(r.card)}   ${mark(r.penalty)}   ${mark(r.chain)}   ` +
        `${r.span == null ? "  -" : String(r.span).padStart(3)}  ${r.saveTick == null ? "    -" : String(r.saveTick).padStart(5)}`,
    );
  }
};

console.log(
  `=== fixture-real 시드 스캔 (${defaultEngineConfig.version}) — ${FROM}부터 ${COUNT}개, 스팬 상한 ${MAX_SPAN}틱 ===`,
);
if (SHOW_ALL) print(rows, "[전체 매트릭스]");
print(candidates.slice(0, LIMIT), `[후보 ${candidates.length}개 — 스팬 짧은 순]`);

if (candidates.length === 0) {
  console.log(
    `\n❌ 조건 5개를 모두 만족하는 시드가 없다. --count 를 늘리거나(권장) --max-span 을 완화해라.` +
      `\n   완화 시 주의: 스팬이 길면 restarts.spec 이 그 구간을 재생하느라 e2e 가 느려지고 타임아웃 위험이 커진다(#181).`,
  );
  process.exitCode = 1;
} else {
  const best = candidates[0];
  console.log(
    `\n✅ 추천 시드 = ${best.seed} (스팬 ${best.span}틱, save@${best.saveTick})` +
      `\n   → gen-fixtures.test.ts 의 SEED 상수 + 주석 이력/보유 시드를 갱신하고 \`npx playwright test\` 로 확인.`,
  );
}
