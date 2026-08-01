/**
 * 실덱 판정 픽스처 추출기 — #374 / #377 M0-2
 *
 * ## 왜 있나
 * 엔진의 밸런스 판정이 전부 **픽스처 입력 하나**로만 이뤄져서, "덱마다 달라지는 결함"을
 * 원리적으로 못 잡았다. 60시드는 시드 분산만 넓히고 입력 분포는 고정이다. 그 구멍이
 * #370(라이브 슛 79% 붕괴)을 통과시켰다.
 *
 * ## 규율 (league-difficulty-sweep.ts 선례)
 * **서버가 만든 것을 덤프해서 읽는다. TS 로 재구현하지 않는다.** 재구현하면 검증이 구현과
 * 같은 실수를 공유한다. 그래서 이 스크립트는 라이브 DB **사본**에서 `match_halves` 의
 * `select_data_json` · `home_input_json` · `away_input_json` · `half_seed` 를 **그대로** 옮긴다.
 * 값을 만들지 않는다 — 고르고, 익명화하고, 붙여넣을 뿐이다.
 *
 * ## 사용
 *   docker cp hmb-java:/var/lib/hmb/hmb.db /tmp/hmb-copy.db     # 반드시 사본으로 (읽기 전용)
 *   node tools/extract-real-decks.mjs /tmp/hmb-copy.db
 *   node tools/extract-real-decks.mjs /tmp/hmb-copy.db --dry     # 선정 결과만 출력
 *
 * 산출: packages/engine/src/realism/real-decks/*.json  (커밋 대상 = 고정 픽스처)
 *
 * ## 익명화
 * 덱/팀 이름은 테스터가 직접 지은 것이라 **레이블로 치환**한다. 선수 이름·id·능력치는 게임
 * 카탈로그 콘텐츠(`data/players/*.json`)라 그대로 둔다 — 엔진이 실제로 읽는 값이고 개인정보가 아니다.
 * `meta` 는 `{generatedAt, promptHash}` 뿐이라 자유 텍스트가 없다(스키마로 확인).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../packages/engine/src/realism/real-decks");

/** #370 붕괴 케이스 — 필수 포함(#374 AC). */
const COLLAPSE_MATCH_ID = "01KYVBW70WZHVAKXGRYE037ZX5";
const TARGET_COUNT = 10; // 8~12 범위 안

const dbPath = process.argv[2];
const DRY = process.argv.includes("--dry");
if (!dbPath) {
  process.stderr.write("사용: node tools/extract-real-decks.mjs <hmb-copy.db> [--dry]\n");
  process.exit(2);
}

function query(sql) {
  // ⚠️ 반드시 사본에 대고 실행한다. -readonly 로 라이브 볼륨을 건드릴 여지를 없앤다.
  const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : [];
}

// ── 후보 수집 ────────────────────────────────────────────────────────────
// half=1 을 기본으로 하되(킥오프부터 = 재현 가능한 완전한 하프), 교체 반영 로스터를 한 케이스는
// 담기 위해 half=2 도 후보에 넣는다.
const rows = query(`
  SELECT h.match_id, h.half, h.half_seed, h.select_data_json, h.home_input_json, h.away_input_json,
         m.mode, m.engine_version, m.state, m.score_home, m.score_away, m.created_at,
         b.name AS bot_name
  FROM match_halves h
  JOIN matches m ON m.id = h.match_id
  LEFT JOIN bots b ON b.id = m.bot_id
  ORDER BY m.created_at DESC, h.half ASC
`);

const bucket = (v, edges) => edges.findIndex((e) => v <= e) === -1 ? edges.length : edges.findIndex((e) => v <= e);

function avgAttr(players) {
  let s = 0;
  let n = 0;
  for (const p of players) {
    for (const v of Object.values(p.attributes)) {
      s += v;
      n += 1;
    }
  }
  return n > 0 ? s / n : 0;
}

const candidates = rows.map((r) => {
  const sd = JSON.parse(r.select_data_json);
  const hi = JSON.parse(r.home_input_json);
  const ai = JSON.parse(r.away_input_json);
  const hs = avgAttr(sd.home.players);
  const as = avgAttr(sd.away.players);
  return {
    matchId: r.match_id,
    half: r.half,
    seed: r.half_seed,
    mode: r.mode,
    engineVersion: r.engine_version,
    state: r.state,
    score: { home: r.score_home, away: r.score_away },
    botName: r.bot_name,
    selectData: sd,
    homeInput: hi,
    awayInput: ai,
    // 다양성 축 — 이 값들의 조합을 최대한 덮는 것이 선정 목표다.
    axes: {
      hform: hi.team.formation,
      aform: ai.team.formation,
      hpress: bucket(hi.team.pressingScheme.intensity, [0.35, 0.55, 0.75]),
      apress: bucket(ai.team.pressingScheme.intensity, [0.35, 0.55, 0.75]),
      hline: bucket(hi.team.defensiveLineHeight, [0.35, 0.55, 0.7]),
      htempo: bucket(hi.team.tempo, [0.4, 0.55, 0.7]),
      hwidth: bucket(hi.team.width, [0.4, 0.6, 0.75]),
      htrap: String(hi.team.offsideTrap),
      mode: r.mode,
      strengthGap: bucket(hs - as, [-4, -1, 1, 4]),
      half: `h${r.half}`,
    },
  };
});

if (candidates.length === 0) {
  process.stderr.write("후보 0건 — DB 사본 경로/스키마 확인\n");
  process.exit(1);
}

// ── 선정: 붕괴 케이스 고정 + 축 커버리지 그리디 ───────────────────────────
const collapse = candidates.find((c) => c.matchId === COLLAPSE_MATCH_ID && c.half === 1);
if (!collapse) {
  process.stderr.write(`⚠️ 붕괴 케이스 ${COLLAPSE_MATCH_ID} 를 DB 에서 못 찾았다 — #374 AC 위반이라 중단한다\n`);
  process.exit(1);
}

const axisKeys = Object.keys(collapse.axes);
const covered = new Map(axisKeys.map((k) => [k, new Set()]));
const picked = [];

function take(c) {
  picked.push(c);
  for (const k of axisKeys) covered.get(k).add(c.axes[k]);
}
take(collapse);

while (picked.length < TARGET_COUNT) {
  let best = null;
  let bestGain = -1;
  for (const c of candidates) {
    if (picked.some((p) => p.matchId === c.matchId && p.half === c.half)) continue;
    // 같은 매치의 다른 하프는 입력이 거의 같다 — 마지막 1장에서만 허용한다.
    if (picked.length < TARGET_COUNT - 1 && picked.some((p) => p.matchId === c.matchId)) continue;
    let gain = 0;
    for (const k of axisKeys) if (!covered.get(k).has(c.axes[k])) gain += 1;
    // 동점이면 오래된 것부터(created_at DESC 정렬이므로 뒤쪽) — 결정론적 tie-break.
    if (gain > bestGain || (gain === bestGain && best && c.matchId < best.matchId)) {
      best = c;
      bestGain = gain;
    }
  }
  if (!best) break;
  take(best);
}

// ── 익명화 ───────────────────────────────────────────────────────────────
// 봇/리그 팀 이름은 게임 콘텐츠라 유지, 유저가 지은 덱 이름만 치환한다.
//
// ⚠️ 화이트리스트를 **DB 의 `bots` 테이블에서 뽑으면 안 된다** — 어웨이/리그 상대는 다른 유저의
// 덱을 봇 행으로 스냅샷하므로 그 테이블에는 유저 닉네임이 섞여 있다(실측: `별희`·`햄춘`·`축구왕여르`
// 가 bots 에 있다). 게임 콘텐츠의 SoT 는 **배포되는 데이터 파일**이다.
const botNames = new Set();
for (const f of ["bots.v2.json", "bots.v3.json", "league.v1.json", "league.v2.json"]) {
  const p = resolve(HERE, "../data/players", f);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) botNames.add(m[1]);
  const j = JSON.parse(text);
  for (const n of j.clubNames ?? []) botNames.add(typeof n === "string" ? n : n?.name);
}
let userTeamSeq = 0;
const teamAlias = new Map();
function aliasTeam(name) {
  if (botNames.has(name)) return name;
  if (!teamAlias.has(name)) {
    userTeamSeq += 1;
    teamAlias.set(name, `USER-DECK-${String.fromCharCode(64 + userTeamSeq)}`);
  }
  return teamAlias.get(name);
}

function pressLabel(v) {
  return v >= 0.75 ? "고압박" : v <= 0.35 ? "저압박" : "중압박";
}
function lineLabel(v) {
  return v >= 0.7 ? "하이라인" : v <= 0.35 ? "로우블록" : "중간라인";
}

const files = picked.map((c, i) => {
  const id =
    c.matchId === COLLAPSE_MATCH_ID ? "collapse-370" : `deck-${String(i).padStart(2, "0")}`;
  const sd = JSON.parse(JSON.stringify(c.selectData));
  sd.home.name = aliasTeam(sd.home.name);
  sd.away.name = aliasTeam(sd.away.name);
  const label =
    c.matchId === COLLAPSE_MATCH_ID
      ? `붕괴 케이스 #370 — ${c.homeInput.team.formation} ${pressLabel(c.homeInput.team.pressingScheme.intensity)} vs ${c.awayInput.team.formation}`
      : `${c.homeInput.team.formation} ${pressLabel(c.homeInput.team.pressingScheme.intensity)}·${lineLabel(c.homeInput.team.defensiveLineHeight)} vs ${c.awayInput.team.formation} (${c.mode}, ${c.half}H)`;
  return {
    schemaVersion: 1,
    producer: "extract-real-decks@1",
    id,
    label,
    note:
      c.matchId === COLLAPSE_MATCH_ID
        ? "라이브 0-0. shootXgThreshold 0.197 에서 슛이 90% 게이트아웃된 그 입력(#370). 최악 케이스 판정의 기준점."
        : `라이브 ${c.engineVersion} · ${c.mode} · ${c.half}H`,
    seed: c.seed,
    live: {
      matchId: c.matchId,
      half: c.half,
      mode: c.mode,
      engineVersion: c.engineVersion,
      state: c.state,
      score: c.score,
    },
    selectData: sd,
    homeInput: c.homeInput,
    awayInput: c.awayInput,
  };
});

// ── 출력 ─────────────────────────────────────────────────────────────────
const report = files.map((f, i) => ({
  id: f.id,
  match: `${picked[i].matchId}#${picked[i].half}`,
  hform: picked[i].axes.hform,
  aform: picked[i].axes.aform,
  press: picked[i].homeInput.team.pressingScheme.intensity,
  line: picked[i].homeInput.team.defensiveLineHeight,
  tempo: picked[i].homeInput.team.tempo,
  mode: picked[i].mode,
  liveScore: `${picked[i].score.home ?? "-"}:${picked[i].score.away ?? "-"}`,
}));
process.stdout.write(`후보 ${candidates.length}건 → 선정 ${files.length}건\n`);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
for (const k of axisKeys) {
  process.stdout.write(`  축 ${k}: ${[...covered.get(k)].join(", ")}\n`);
}

if (DRY) process.exit(0);

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
for (const f of files) writeFileSync(join(OUT_DIR, `${f.id}.json`), JSON.stringify(f, null, 2) + "\n");
writeFileSync(
  join(OUT_DIR, "index.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      producer: "extract-real-decks@1",
      note: "라이브 DB 사본에서 추출한 고정 픽스처(#374). 서버가 만든 입력을 그대로 옮긴 것 — TS 재구현 아님.",
      cases: files.map((f) => ({ id: f.id, label: f.label, note: f.note, seed: f.seed, live: f.live })),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`\n기록: ${OUT_DIR} (${readdirSync(OUT_DIR).length} 파일)\n`);
