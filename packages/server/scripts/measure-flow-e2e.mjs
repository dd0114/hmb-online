/**
 * 게임시작→관전가능 대기 분해 계측 (#193 W1) — 3프로세스 실스택, AI=stub.
 *
 * AI 시간을 0(stub)으로 고정해 **AI 외 모든 성분**(킥오프 요청 → 잡 enqueue → 서번트 long-poll 픽업 →
 * complete → 엔진 RPC 시뮬 → FIRST_HALF 전이 → 웹이 그걸 알아채는 폴링 지연 → 3.7MB 로그 전송/파싱)을
 * 실측한다. AI 성분은 measure-ai-latency.ts 가 따로 잰다 → 둘을 합치면 실제 대기 분해가 된다.
 *
 * ⚠️ 포트: 이 스크립트는 계측 전용 포트만 쓴다(데모 8080/8790 · 배포 18080/18790 무접촉).
 * 실행(호출부가 java/runner/executor 를 미리 띄운 뒤):
 *   node packages/server/scripts/measure-flow-e2e.mjs --java http://127.0.0.1:8081
 */

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const JAVA = arg("java", "http://127.0.0.1:8081");
const NICK = arg("nick", `measure-${process.pid}`);
/** 실제 웹 폴링 주기(apps/web live-clock.pollIntervalFor: GEN=3000ms) — 체감 지연 재현용. */
const WEB_POLL_MS = Number(arg("web-poll", "3000"));
/** 브리핑 체류 시간(유저가 프롬프트를 쓰는 동안) — A 프리페치가 그 사이 끝나는지 재현용. */
const BRIEF_WAIT_MS = Number(arg("brief-wait", "0"));
/** FIRST_HALF 도달 대기 상한. */
const DEADLINE_MS = Number(arg("deadline", "600000"));

let token = null;
const t0 = Date.now();
const marks = [];
const mark = (label) => {
  const at = Date.now() - t0;
  marks.push({ label, at });
  console.log(`[${String(at).padStart(6)}ms] ${label}`);
};

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${JAVA}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return { json: text ? JSON.parse(text) : null, bytes: text.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 준비: 로그인(스타터 팩) → 덱 구성 ────────────────────────────────
  const login = await api("/api/auth/login", { method: "POST", body: { nickname: NICK } });
  token = login.json.token;
  mark("login");

  const players = (await api("/api/players")).json;
  const owned = (players.items ?? players).filter((p) => p.owned === true);
  const gk = owned.find((p) => p.position === "GK");
  const others = owned.filter((p) => p.position !== "GK");
  if (!gk || others.length < 10) throw new Error(`스타터 팩 부족: owned=${owned.length} gk=${Boolean(gk)}`);
  const slots = [gk, ...others.slice(0, 10)].map((p, i) => ({
    playerId: p.id,
    role: "starter",
    slotIndex: i,
  }));
  await api("/api/deck", { method: "PUT", body: { formation: "4-3-3", slots } });
  mark("deck ready");

  // ── 계측 구간 시작: 매치 생성(BRIEFING) → 프롬프트 → 킥오프 ──────────
  const created = await api("/api/matches", { method: "POST", body: {} });
  const matchId = created.json.id;
  mark(`match created (BRIEFING) id=${matchId} — A 프리페치 enqueue 됨`);

  // 브리핑 체류(유저가 프롬프트를 쓰는 시간). A 프리페치가 이 사이에 끝나는지가 대기의 갈림길.
  if (BRIEF_WAIT_MS > 0) {
    await sleep(BRIEF_WAIT_MS);
    mark(`briefing 체류 ${BRIEF_WAIT_MS}ms 경과`);
  }

  await api(`/api/matches/${matchId}/prompts`, {
    method: "POST",
    body: { phase: "pre", scope: "team", text: "전방압박 강하게, 측면 전환 빠르게." },
  });
  mark("pre prompt submitted");

  const kickoffAt = Date.now();
  await api(`/api/matches/${matchId}/kickoff`, { method: "POST" });
  mark("KICKOFF 202 (GEN1)");

  // ── 서버가 실제로 FIRST_HALF 가 되는 시각(고해상 100ms 폴링) ─────────
  let serverReadyAt = null;
  let webNoticedAt = null;
  let lastWebPoll = kickoffAt;
  let state = "GEN1";
  while (Date.now() - kickoffAt < DEADLINE_MS) {
    const detail = (await api(`/api/matches/${matchId}`)).json;
    if (detail.state !== state) {
      state = detail.state;
      mark(`state → ${state}${state === "FAILED" ? ` (${detail.failReason ?? "?"})` : ""}`);
      if (state === "FAILED") throw new Error(`매치 FAILED: ${detail.failReason ?? "?"}`);
    }
    if (serverReadyAt === null && (state === "FIRST_HALF" || state === "HALFTIME")) {
      serverReadyAt = Date.now();
      mark("SERVER READY (관전 가능 상태 진입)");
    }
    // 웹 체감: 3s 주기 폴링만 상태를 알아챈다 → 그 격자에 맞춘 첫 인지 시각.
    if (serverReadyAt !== null && webNoticedAt === null) {
      const gridPolls = Math.ceil((serverReadyAt - lastWebPoll) / WEB_POLL_MS);
      webNoticedAt = lastWebPoll + gridPolls * WEB_POLL_MS;
      mark(`WEB WOULD NOTICE (poll ${WEB_POLL_MS}ms grid)`);
      break;
    }
    await sleep(100);
  }
  if (serverReadyAt === null) throw new Error("타임아웃 — FIRST_HALF 미도달");

  // ── 관전 시작 비용: 전반 로그 전송(3.7MB) + 파싱 ─────────────────────
  const fetchStart = Date.now();
  const logRes = await fetch(`${JAVA}/api/matches/${matchId}/halves/1/log`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const logText = await logRes.text();
  const transferMs = Date.now() - fetchStart;
  const parseStart = Date.now();
  const parsed = JSON.parse(logText);
  const parseMs = Date.now() - parseStart;
  mark(`half1 log fetched ${(logText.length / 1024 / 1024).toFixed(2)}MB transfer=${transferMs}ms parse=${parseMs}ms ticks=${parsed.matchLog?.tickSnapshots?.length ?? parsed.tickSnapshots?.length ?? "?"}`);

  const summary = {
    matchId,
    kickoffToServerReadyMs: serverReadyAt - kickoffAt,
    kickoffToWebNoticeMs: webNoticedAt - kickoffAt,
    webPollLagMs: webNoticedAt - serverReadyAt,
    logMB: Number((logText.length / 1024 / 1024).toFixed(2)),
    logTransferMs: transferMs,
    logParseMs: parseMs,
    totalPerceivedMs: webNoticedAt - kickoffAt + transferMs + parseMs,
    marks,
  };
  console.log("\n--- SUMMARY(JSON) ---");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
