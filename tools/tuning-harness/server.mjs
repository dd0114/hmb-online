/**
 * 무리빌드 튜닝 하네스 — 서버 (#377 M0-1)
 *
 * ## 왜 있나
 * 엔진은 이미 무상태다 — `runMatch(seed, home, away, select, config)` 이고 `config` 는 순수
 * 데이터다. 그런데 계수를 하나 만지려면 `config.ts` 편집 → TS 컴파일 → vitest 재기동 → 전체
 * 로드 → 텍스트 결과를 매번 돌았다. 그 왕복이 밸런스 웨이브를 시간 단위로 만든 정체다(#377 §4).
 *
 * 이 서버는 **엔진을 프로세스에 1회 로드**해 두고, config 를 **HTTP 요청 본문으로** 받아
 * 재시뮬한다. 리빌드 0 · 재기동 0. 결과 로그는 디스크에 떨어뜨리고 브라우저가 viewer-core 로
 * 그대로 재생한다(= hero 눈 QA 와 같은 통로, QA 콘솔 탭이 가리킬 수 있는 파일).
 *
 * ## 실행
 *   npm run harness            # http://127.0.0.1:8310
 *   npm run harness -- --port 8399
 *
 * ## 경계
 * - **엔진은 읽기만 한다**(무접촉 계약 — `league-difficulty-sweep.ts` 선례). 여기서 나온 계수는
 *   커밋하지 않는다(그건 트랙 T 소관).
 * - **로컬 전용**: 127.0.0.1 바인드 고정. 외부 호스팅 금지(#377 제약).
 * - 결정론 불변: 같은 (시드 + 입력 + 오버라이드) 는 항상 같은 경기다. 서버는 상태를 갖지 않는다
 *   (런 목록은 A/B 대조용 캐시일 뿐 시뮬에 영향 0).
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, basename } from "node:path";
import { homedir } from "node:os";

import { defaultEngineConfig } from "../../packages/engine/src/config.ts";
import { runMatch } from "../../packages/engine/src/match.ts";
import { makeSelectData, makeTacticalInput } from "../../packages/engine/src/fixtures.ts";
import {
  applyConfigOverrides,
  listConfigLeaves,
  TUNING_KNOBS,
} from "../../packages/engine/src/realism/config-override.ts";
import { REALISM_SEEDS } from "../../packages/engine/src/realism/harness.ts";
// 측정은 게이트와 **같은 함수**를 쓴다 — 하네스와 계약이 다른 수를 보이면 hero 가 본 화면과
// green/red 가 어긋난다.
import { computeMatchStats, ownerSideOfSnapshot } from "../../packages/engine/dev-viewer/match-stats.ts";
import { listRealDeckCases, loadRealDeckCase } from "../../packages/engine/src/realism/real-decks.ts";
// 시계 스케일은 로그가 정한다(#365 — 엔진 45분 / 표기 0–90분). UI 라벨이 뷰어 시계와 갈라지지
// 않게 **코어의 함수**를 쓴다.
import { clockScaleOf } from "../../packages/viewer-core/src/playback.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const VIEWER_CORE = join(REPO, "packages/viewer-core/src");

/** 런 산출물 위치 — 리포 **밖**(생성물이라 커밋 대상이 아니고, QA 콘솔 allowlist 가 $HOME 을 허용한다). */
const RUN_HOME = process.env.HMB_HARNESS_HOME || join(homedir(), "hmb-harness-runs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ── 입력 소스 ────────────────────────────────────────────────────────────
// AC3: 벤치마크 덱(엔진 픽스처) + 실덱 픽스처(M0-2). 둘 다 같은 `runOne` 을 탄다.

/** 벤치마크 덱 — `aggregateRealism` 이 쓰는 것과 **같은** 입력 조립(측정이 갈라지지 않게). */
function benchmarkInputs(seed) {
  return {
    select: makeSelectData(),
    home: makeTacticalInput("H", seed),
    away: makeTacticalInput("A", seed),
    label: "벤치마크 덱",
  };
}

function realDeckInputs(caseId) {
  const c = loadRealDeckCase(caseId);
  return {
    select: c.selectData,
    home: c.homeInput,
    away: c.awayInput,
    label: c.label,
    nativeSeed: c.seed,
    note: c.note,
  };
}

/** 소스 서술 → 입력 조립기. `source` = "benchmark" | "real:<caseId>". */
function inputsFor(source, seed) {
  if (source === "benchmark" || !source) return benchmarkInputs(seed);
  if (source.startsWith("real:")) return realDeckInputs(source.slice(5));
  throw new Error(`알 수 없는 입력 소스: ${source}`);
}

// ── 시드 ─────────────────────────────────────────────────────────────────
/**
 * 시드 목록을 정한다. hero 가 직접 적으면 그대로, 비우면 기본 시드 풀에서 앞에서부터 N개.
 * 실덱은 그 하프의 **실제 시드**를 1번으로 놓는다 — 라이브에서 실제로 벌어진 그 경기가
 * 기준선이어야 "재현되나"를 볼 수 있다.
 */
function resolveSeeds({ seeds, count, nativeSeed }) {
  const explicit = (seeds || []).map((s) => String(s).trim()).filter(Boolean);
  if (explicit.length > 0) return explicit;
  const n = Math.max(1, Math.min(32, Number(count) || 4));
  const pool = nativeSeed ? [nativeSeed, ...REALISM_SEEDS.map((s) => `${nativeSeed}#${s}`)] : REALISM_SEEDS;
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[i % pool.length]);
  return out;
}

// ── 측정 ─────────────────────────────────────────────────────────────────

/** 이 경기의 GK id 집합 — 로스터의 position 에서 뽑는다(id 접두사 추측 금지, #324 교훈). */
function gkIdsOf(select) {
  const out = new Set();
  for (const side of ["home", "away"]) {
    for (const p of select[side].players) if (p.position === "GK") out.add(p.playerId);
  }
  return out;
}

function defenderIdsOf(select) {
  const out = new Set();
  for (const side of ["home", "away"]) {
    for (const p of select[side].players) if (p.position === "DF") out.add(p.playerId);
  }
  return out;
}

/**
 * 점유율 — 스냅샷의 `players[].team` 으로 판정한다. `ballOwner` 는 순수 playerId 라
 * 문자열만 보고 팀을 알 수 없고, 같은 id 가 양 팀에 있을 수 있다(#231/#324).
 */
function possessionOf(log) {
  let h = 0;
  let a = 0;
  for (const sn of log.tickSnapshots) {
    const side = ownerSideOfSnapshot(sn);
    if (side === "home") h++;
    else if (side === "away") a++;
  }
  const tot = h + a;
  if (tot === 0) return { home: 0, away: 0 };
  return { home: Math.round((h / tot) * 1000) / 10, away: Math.round((a / tot) * 1000) / 10 };
}

/** 슛 이벤트 평균 xG(결과마커 제외). */
function xgPerShot(log, side) {
  let sum = 0;
  let n = 0;
  for (const e of log.events) {
    if (e.type !== "shot" || e.team !== side) continue;
    if (e.detail === "saved" || e.detail === "off_target") continue;
    if (e.xg == null) continue;
    sum += e.xg;
    n += 1;
  }
  return n > 0 ? Math.round((sum / n) * 1000) / 1000 : 0;
}

const round1 = (v) => Math.round(v * 10) / 10;

function summarize(log, select, config) {
  const stats = computeMatchStats(log, gkIdsOf(select), {
    defenderIds: defenderIdsOf(select),
    pitchWidthM: config.pitch.width,
    finalThirdLine: config.setPiece.finalThirdLine,
  });
  const poss = possessionOf(log);
  const team = (side) => {
    const t = stats[side];
    return {
      shots: t.shots,
      onTarget: t.onTarget,
      goals: t.goals,
      saves: t.saves,
      passAttempts: t.passAttempts,
      passSuccessPct: round1(t.passSuccessPct),
      corners: t.corners,
      throwIns: t.throwIns,
      fouls: t.fouls,
      offsides: t.offsides,
      yellowCards: t.yellowCards,
      avgWidthM: round1(t.avgWidthM),
      avgDistanceKm: t.avgDistanceKm,
      possessionPct: poss[side],
      xgPerShot: xgPerShot(log, side),
    };
  };
  return { home: team("home"), away: team("away") };
}

/** 재생 UI 가 그리는 상황 핀 — 타입별 1건씩 요약(로그 전체를 안 받고도 점프할 수 있게). */
const PIN_TYPES = new Set(["goal", "penalty", "save", "shot", "foul", "card", "offside", "free_kick", "kickoff"]);
function pinsOf(log) {
  const out = [];
  for (const e of log.events) {
    if (!PIN_TYPES.has(e.type)) continue;
    if (e.type === "shot" && (e.detail === "saved" || e.detail === "off_target")) continue;
    if (e.type === "kickoff" && e.detail !== "corner") continue;
    out.push({ tick: e.tick, minute: e.minute, type: e.type, team: e.team ?? null, detail: e.detail ?? null });
  }
  return out;
}

// ── 실행 ─────────────────────────────────────────────────────────────────

let runCounter = 0;
/** 최근 런 캐시(A/B 대조용). 시뮬에 영향 0 — 순수 표시용. */
const runs = new Map();

async function executeRun(body) {
  const overrides = body.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const config = applyConfigOverrides(defaultEngineConfig, overrides);
  const source = body.source || "benchmark";
  const probe = inputsFor(source, "probe");
  const seeds = resolveSeeds({ seeds: body.seeds, count: body.count, nativeSeed: probe.nativeSeed });

  runCounter += 1;
  const runId = `run-${String(runCounter).padStart(3, "0")}-${process.pid}`;
  const dir = join(RUN_HOME, runId);
  await mkdir(dir, { recursive: true });

  const started = Date.now();
  const matches = [];
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const inp = inputsFor(source, seed);
    const t0 = Date.now();
    const log = runMatch(seed, inp.home, inp.away, inp.select, config);
    const simMs = Date.now() - t0;
    const logPath = join(dir, `match-${String(i + 1).padStart(2, "0")}.json`);
    await writeFile(logPath, JSON.stringify(log));
    matches.push({
      index: i,
      seed,
      label: inp.label,
      note: inp.note ?? null,
      homeName: inp.select.home.name,
      awayName: inp.select.away.name,
      score: log.finalScore,
      ticks: log.tickSnapshots.length,
      clockScale: clockScaleOf(log.events, log.tickSnapshots),
      eventCount: log.events.length,
      lastHash: log.tickSnapshots.at(-1)?.hash ?? null,
      simMs,
      stats: summarize(log, inp.select, config),
      pins: pinsOf(log),
      logUrl: `/api/log/${runId}/${i}`,
      logPath,
    });
  }

  const run = {
    runId,
    createdMs: started,
    totalMs: Date.now() - started,
    engineVersion: config.version,
    source,
    overrides,
    dir,
    matches,
  };
  runs.set(runId, run);
  // 매니페스트 — QA 콘솔 탭·사후 조회용.
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({ ...run, matches: matches.map(({ pins, ...m }) => m) }, null, 2),
  );
  return run;
}

// ── HTTP ─────────────────────────────────────────────────────────────────

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function sendFile(res, path) {
  if (!existsSync(path)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const buf = await readFile(path);
  res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(buf);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        fail(e);
      }
    });
    req.on("error", fail);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/api/health") return sendJson(res, 200, { ok: true, engineVersion: defaultEngineConfig.version });

  if (path === "/api/meta") {
    return sendJson(res, 200, {
      engineVersion: defaultEngineConfig.version,
      matchMinutes: defaultEngineConfig.matchMinutes,
      displayMinutes: defaultEngineConfig.displayMinutes ?? null,
      knobs: TUNING_KNOBS.map((k) => ({ ...k, value: leafValue(k.path) })),
      paths: listConfigLeaves(defaultEngineConfig).map((l) => ({ path: l.path, value: l.value, type: l.type })),
      sources: [
        { id: "benchmark", label: "벤치마크 덱 (엔진 픽스처)", note: "밴드·골든이 쓰는 그 입력" },
        ...listRealDeckCases().map((c) => ({
          id: `real:${c.id}`,
          label: c.label,
          note: c.note,
        })),
      ],
      runHome: RUN_HOME,
      defaultSeeds: REALISM_SEEDS.slice(0, 8),
    });
  }

  if (path === "/api/config") return sendJson(res, 200, defaultEngineConfig);

  if (path === "/api/runs") {
    return sendJson(
      res,
      200,
      [...runs.values()].map((r) => ({
        runId: r.runId,
        source: r.source,
        overrides: r.overrides,
        totalMs: r.totalMs,
        matches: r.matches.length,
      })),
    );
  }

  if (path === "/api/run" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const run = await executeRun(body);
      return sendJson(res, 200, { ...run, matches: run.matches });
    } catch (e) {
      return sendJson(res, 400, { error: String(e && e.message ? e.message : e) });
    }
  }

  const logMatch = /^\/api\/log\/([\w.-]+)\/(\d+)$/.exec(path);
  if (logMatch) {
    const run = runs.get(logMatch[1]);
    const m = run?.matches[Number(logMatch[2])];
    if (!m) return sendJson(res, 404, { error: "no such match" });
    return sendFile(res, m.logPath);
  }

  // viewer-core 런타임(.mjs)은 **브라우저 안전한 순수 ESM** 이라 그대로 서빙한다(빌드 0).
  if (path.startsWith("/vendor/")) {
    const name = basename(path);
    if (!name.endsWith(".mjs")) return sendJson(res, 403, { error: "mjs only" });
    return sendFile(res, join(VIEWER_CORE, name));
  }

  if (path === "/" || path === "/index.html") return sendFile(res, join(HERE, "ui/index.html"));
  if (path.startsWith("/ui/")) {
    const name = basename(path);
    return sendFile(res, join(HERE, "ui", name));
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

function leafValue(path) {
  let node = defaultEngineConfig;
  for (const seg of path.split(".")) node = node?.[seg];
  return node;
}

const portArg = process.argv.indexOf("--port");
const PORT = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.HMB_HARNESS_PORT || 8310);

createServer((req, res) => {
  handle(req, res).catch((e) => {
    sendJson(res, 500, { error: String(e && e.stack ? e.stack : e) });
  });
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `무리빌드 튜닝 하네스 — ${defaultEngineConfig.version}\n` +
      `  http://127.0.0.1:${PORT}\n` +
      `  런 산출물: ${RUN_HOME}\n`,
  );
});

export { executeRun, resolveSeeds, summarize, pinsOf, inputsFor };
void readdir;
void stat;
