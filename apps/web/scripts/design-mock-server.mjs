// design-mock-server.mjs — S1 관전 화면(#169) 디자인 확인용 **로컬 전용** 목 API 서버.
//
// 백엔드(server-java) 없이 게임화면을 실제 브라우저에서 눌러보기 위한 하니스다. e2e 목 하니스
// (`apps/web/e2e/match-stage.spec.ts`)와 같은 응답 형태를 쓰되, Playwright 대신 실제 HTTP 로 낸다.
// vite dev 의 `/api` 프록시가 이 서버를 가리키게 해서(`VITE_API_TARGET`) 앱 코드는 **무수정**이다.
//
// 실행: node apps/web/scripts/design-mock-server.mjs [--port 8132]
// 보통은 `npm run design:preview` 가 vite dev 와 함께 띄운다.
//
// ⚠️ 개발 편의 도구다. 인증/검증이 없으니 로컬에서만 쓴다(0.0.0.0 바인딩 금지 — 127.0.0.1 고정).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const argPort = process.argv.indexOf("--port");
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : (process.env.DESIGN_MOCK_PORT ?? 8132));

// 결정론 데모 로그(build:viewer 생성물) — 진짜 MatchLog 를 그대로 먹여야 화면이 진짜처럼 움직인다.
const LOG_PATH = join(repoRoot, "packages", "engine", "dev-viewer", "match-log.json");
let MATCH_LOG;
try {
  MATCH_LOG = JSON.parse(readFileSync(LOG_PATH, "utf8"));
} catch {
  console.error(
    `[design-mock] match-log.json 이 없다: ${LOG_PATH}\n` +
      `  → cd apps/web && npm run build:viewer  (또는 npx vitest run packages/engine/dev-viewer/generate-demo.test.ts)`,
  );
  process.exit(1);
}

// 게임화면 캐릭터 스킨(#145)은 **실선수 id**(P001..)에 매핑돼 있다. 데모 로그는 엔진 픽스처
// id(H0/A0..)라 그대로면 스킨이 안 붙어 프리뷰가 단색 원으로 보인다 → 실게임처럼 캐릭터 얼굴이
// 나오게 스냅샷 player/ballOwner 를 실선수 id 로 리매핑한다(e2e p3-char-skin 과 같은 규약).
function remapToRealIds(log) {
  const map = new Map();
  let n = 1;
  for (const s of log.tickSnapshots ?? [])
    for (const pl of s.players ?? [])
      if (!map.has(pl.playerId)) map.set(pl.playerId, `P${String(n++).padStart(3, "0")}`);
  const mid = (id) => (id && map.has(id) ? map.get(id) : id);
  return {
    ...log,
    tickSnapshots: (log.tickSnapshots ?? []).map((s) => ({
      ...s,
      players: (s.players ?? []).map((pl) => ({ ...pl, playerId: mid(pl.playerId) })),
      ballOwner: mid(s.ballOwner),
    })),
  };
}
const SKINNED_LOG = remapToRealIds(MATCH_LOG);

/** 로그가 실제로 담고 있는 골 수 — 스코어를 여기서 파생해야 화면 어디를 봐도 값이 어긋나지 않는다. */
function goalsOf(log) {
  let home = 0;
  let away = 0;
  for (const e of log.events ?? []) {
    if (e.type !== "goal") continue;
    if (e.team === "home") home += 1;
    else if (e.team === "away") away += 1;
  }
  return { home, away };
}
const H1 = goalsOf(MATCH_LOG);
// 두 하프에 같은 로그를 먹이므로 최종은 그 2배 — 결과 카드·팀스탯·스코어바가 서로 일치한다.
const FULL = { home: H1.home * 2, away: H1.away * 2 };
const RESULT = FULL.home === FULL.away ? "DRAW" : FULL.home > FULL.away ? "WIN" : "LOSS";

/** 매치 id 로 상태를 고른다 — `/match/h1break`, `/match/finished` 처럼 URL 만으로 화면을 바꾼다. */
function stateOf(id) {
  const key = String(id).toLowerCase();
  if (key.includes("finish") || key.includes("result")) return "FINISHED";
  if (key.includes("live") || key.includes("first")) return "FIRST_HALF";
  return "H1_BREAK";
}

const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `선수${i + 1}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW",
    grade: ["LEGEND", "EPIC", "RARE", "COMMON", "BRONZE"][i % 5],
    attributes: { pace: 70, shooting: 68, passing: 72, defending: 60, physical: 66, technique: 71 },
    condition: 90,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `b${i + 1}`,
    name: `벤치${i + 1}`,
    position: i === 0 ? "GK" : "MF",
    grade: "COMMON",
    attributes: { pace: 62, shooting: 58, passing: 63, defending: 55, physical: 60, technique: 61 },
    condition: 85,
  })),
];

const DECK = {
  formation: "4-3-3",
  slots: [
    ...Array.from({ length: 11 }, (_, i) => ({ slotIndex: i, playerId: `p${i + 1}`, role: "starter" })),
    ...Array.from({ length: 5 }, (_, i) => ({ slotIndex: i, playerId: `b${i + 1}`, role: "bench" })),
  ],
};

const ME = {
  user: { id: "u-design", nickname: "디자인프리뷰", points: 1200, wins: 3, draws: 1, losses: 2, isAdmin: false },
  wallet: { points: 1200 },
  records: { wins: 3, draws: 1, losses: 2 },
};

function matchDetail(id) {
  const state = stateOf(id);
  return {
    id,
    state,
    scoreH1Home: H1.home,
    scoreH1Away: H1.away,
    scoreHome: state === "FINISHED" ? FULL.home : null,
    scoreAway: state === "FINISHED" ? FULL.away : null,
    result: state === "FINISHED" ? RESULT : null,
    createdAt: "2026-07-22T09:00:00Z",
    opponent: { name: "뮌헨봇", analysisText: "측면 압박이 강한 팀입니다." },
  };
}

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/api/me") return json(res, ME);
  if (p === "/api/players") return json(res, PLAYERS);
  if (p === "/api/deck") return json(res, DECK);
  if (p === "/api/presets" || p === "/api/team-presets" || p === "/api/relations") return json(res, []);

  const logMatch = p.match(/^\/api\/matches\/([^/]+)\/halves\/([12])\/log$/);
  if (logMatch) return json(res, SKINNED_LOG); // 실선수 id → 캐릭터 스킨 적용(실게임처럼)

  const resultMatch = p.match(/^\/api\/matches\/([^/]+)\/result$/);
  if (resultMatch) {
    return json(res, { result: RESULT, scoreHome: FULL.home, scoreAway: FULL.away, pointsAwarded: 120 });
  }

  const detailMatch = p.match(/^\/api\/matches\/([^/]+)$/);
  if (detailMatch) return json(res, matchDetail(detailMatch[1]));

  // 목업 로그인 — 제품 경로(`/match/<id>`)로도 화면을 볼 수 있게 토큰을 내준다.
  // (`/design/stage` 는 로그인 없이 열리지만, 실제 라우팅을 그대로 보고 싶을 때가 있다.)
  if (p === "/api/auth/login" || p === "/api/auth/register") {
    return json(res, { token: "design-mock-token", user: ME.user });
  }

  // 제출/재개 등 쓰기 계열은 "받았다"고만 답한다(디자인 프리뷰라 상태는 URL 이 정한다).
  if (req.method !== "GET") return json(res, { ok: true });

  return json(res, {});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[design-mock] http://127.0.0.1:${PORT} — 전반 ${H1.home}:${H1.away} · 최종 ${FULL.home}:${FULL.away} (${RESULT})`,
  );
});
