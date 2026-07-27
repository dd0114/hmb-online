/**
 * 덱 저장 선실행 before/after 계측 (#215 W2-B3) — 3프로세스 실스택.
 *
 * measure-flow-e2e.mjs(#193 W1)가 재지 못한 두 가지를 잰다:
 *   ① **브라우저 경로** — 킥오프에 teamTactics 를 실어 보낸다. #193 계측·v8 스모크는 전부 API 직접
 *      호출이라 전술이 null 이었고, 그래서 "A 캐시 키 불일치"(#215 W1 addendum)가 표본에 안 잡혔다.
 *   ② **선실행 리드타임** — 덱을 먼저 저장하고 A 가 끝난 뒤에 매치를 시작한다(= 실제 유저의 시간 축).
 *      기존 하네스는 매치 생성 직후 킥오프해서 A 가 항상 미완이었다.
 *
 * 시나리오(--scenario):
 *   cold      매치 생성 직후 킥오프 — A 미완(현행 라이브 재현). 전술 실음.
 *   prewarm   덱 저장 → A done 까지 대기 → 매치 생성 → 즉시 킥오프. 전술 실음(중앙=미지정).
 *   tuned     prewarm 과 같되 슬라이더를 실제로 움직여 보낸다(= B 패치 경로).
 *
 * ⚠️ 포트: 계측 전용만. 데모 8080/8790 · 배포 18080/18790 **무접촉**.
 * 실행: node packages/server/scripts/measure-prewarm.mjs --java http://127.0.0.1:8081 --scenario prewarm
 */

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const JAVA = arg("java", "http://127.0.0.1:8081");
const SCENARIO = arg("scenario", "prewarm");
const NICK = arg("nick", `pw-${SCENARIO}-${process.pid}`);
const DEADLINE_MS = Number(arg("deadline", "600000"));
/** A(베이스) 완료 대기 상한 — prewarm/tuned 에서 덱 저장 후 얼마나 기다릴지. */
const WARM_DEADLINE_MS = Number(arg("warm-deadline", "300000"));

/** 봇 고정 — 봇 A 캐시 상태를 시나리오 간 동일하게 두려면 상대가 같아야 한다(라이브는 봇 A 가 장기 캐시). */
const BOT = arg("bot", "BOT_BAL");

const NEUTRAL = { line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 };
const TUNED = { line: 0.8, press: 0.9, tempo: 0.3, width: 0.2 };

let token = null;
const t0 = Date.now();
const marks = [];
const mark = (label) => {
  const at = Date.now() - t0;
  marks.push({ label, at });
  console.log(`[${String(at).padStart(7)}ms] ${label}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return text ? JSON.parse(text) : null;
}

async function setupDeck() {
  const login = await api("/api/auth/login", { method: "POST", body: { nickname: NICK } });
  token = login.token;
  await api("/api/me/tutorial-complete", { method: "POST" }).catch(() => null);
  const players = await api("/api/players");
  const owned = (players.items ?? players).filter((p) => p.owned === true);
  const gk = owned.find((p) => p.position === "GK");
  const others = owned.filter((p) => p.position !== "GK");
  if (!gk || others.length < 10) throw new Error(`스타터 팩 부족: owned=${owned.length}`);
  const slots = [gk, ...others.slice(0, 10)].map((p, i) => ({
    playerId: p.id,
    role: "starter",
    slotIndex: i,
    // 저장마다 다른 덱이 되게 해 A 캐시가 앞 실행분과 섞이지 않게 한다(측정 독립성).
    promptText: i === 10 ? `측정 ${NICK}` : undefined,
  }));
  await api("/api/deck", { method: "PUT", body: { formation: "4-3-3", slots } });
  mark("deck saved (prewarm 트리거 지점)");
}

/** A(베이스)가 done 이 될 때까지 — 서버 내부 상태는 못 보므로 "킥오프가 콜0으로 끝나는지"로 간접 확인하지 않고, 단순 대기 후 진행. */
async function waitForWarm() {
  const started = Date.now();
  // A 완료를 직접 조회할 공개 API 가 없다 — 대신 매치를 만들지 않고 기다린다. 상한까지 폴링 없이
  // 고정 간격으로 재고, 실제 완료 시각은 서버 로그/DB 로 사후 대조한다(리포트에 명시).
  while (Date.now() - started < WARM_DEADLINE_MS) {
    await sleep(2000);
    if (Date.now() - started >= Number(arg("warm-wait", "45000"))) break;
  }
  mark(`A 프리워밍 대기 ${Date.now() - started}ms 경과`);
}

async function run() {
  await setupDeck();

  if (SCENARIO !== "cold") await waitForWarm();

  const created = await api("/api/matches", { method: "POST", body: { botId: BOT } });
  const matchId = created.id;
  mark(`match created (BRIEFING) id=${matchId}`);

  const tactics = SCENARIO === "tuned" ? TUNED : NEUTRAL;
  const kickoffAt = Date.now();
  await api(`/api/matches/${matchId}/kickoff`, { method: "POST", body: { teamTactics: tactics } });
  mark(`KICKOFF 202 (teamTactics=${SCENARIO === "tuned" ? "moved" : "neutral"})`);

  let state = "GEN1";
  let readyAt = null;
  while (Date.now() - kickoffAt < DEADLINE_MS) {
    const detail = await api(`/api/matches/${matchId}`);
    if (detail.state !== state) {
      state = detail.state;
      mark(`state → ${state}`);
      if (state === "FAILED") throw new Error(`매치 FAILED: ${detail.failReason ?? "?"}`);
    }
    if (state === "FIRST_HALF" || state === "HALFTIME") {
      readyAt = Date.now();
      break;
    }
    await sleep(100);
  }
  if (readyAt === null) throw new Error("타임아웃 — FIRST_HALF 미도달");

  const summary = {
    scenario: SCENARIO,
    nickname: NICK,
    matchId,
    kickoffToWatchableMs: readyAt - kickoffAt,
    marks,
  };
  console.log("\n--- SUMMARY(JSON) ---");
  console.log(JSON.stringify(summary, null, 2));
}

run().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
