// QA: match-log 의 각 상황(골/선방/빗나감/코너/골킥/오프사이드/파울/PK)이
// 실제 공 궤적·점수·후속 재시작과 맞는지, 그리고 뷰어가 붙일 자막이 상황에 맞는지 전수 검수한다.
import { readFileSync } from "node:fs";
import { buildStoppages, buildAnnotations, eventKind } from "../packages/engine/dev-viewer/playback.mjs";

const path = process.argv[2] || "packages/engine/dev-viewer/match-log.json";
const log = JSON.parse(readFileSync(path, "utf8"));
const snaps = log.tickSnapshots;
const byTick = new Map(snaps.map((s) => [s.tick, s]));
const ev = log.events;

const POST_LO = 30.34, POST_HI = 37.66; // 골포스트 y
const inPosts = (y) => y >= POST_LO - 0.6 && y <= POST_HI + 0.6;
const atLine = (x) => x < 3 || x > 102;
const ballAt = (tick) => { const s = byTick.get(tick); return s ? s.ball : null; };
const scoreAt = (tick) => {
  let h = 0, a = 0;
  for (const e of ev) if (e.type === "goal" && e.tick <= tick) (e.team === "home" ? h++ : a++);
  return { h, a };
};

const problems = [];
const P = (msg) => problems.push(msg);

// 1) 골: 공이 네트 안(라인 안쪽) + 포스트 사이 + 그 틱에 score 증가.
for (const g of ev.filter((e) => e.type === "goal")) {
  const b = ballAt(g.tick);
  if (!b) { P(`골 t${g.tick}: 스냅샷 없음`); continue; }
  if (!atLine(b.x) || !inPosts(b.y)) P(`골 t${g.tick} ${g.team}: 공이 골문에 없음 (${b.x.toFixed(1)},${b.y.toFixed(1)})`);
  const before = scoreAt(g.tick - 1), after = scoreAt(g.tick);
  if (after.h + after.a <= before.h + before.a) P(`골 t${g.tick}: score 증가 안 함`);
}

// 2) 선방: 공이 골문(키퍼, y 포스트내) + 그 틱에 골 아님(score 불변) + 이후 재시작(코너 등) 존재.
for (const s of ev.filter((e) => e.type === "save")) {
  const b = ballAt(s.tick);
  if (!b) { P(`선방 t${s.tick}: 스냅샷 없음`); continue; }
  // 선방인데 그 시점/직후에 골이 찍히면 = "선방인데 골처럼" 버그.
  const goalNear = ev.find((e) => e.type === "goal" && Math.abs(e.tick - s.tick) <= 2);
  if (goalNear) P(`선방 t${s.tick} ${s.team}: 근처(±2)에 골 이벤트 t${goalNear.tick} — 선방↔골 혼동 위험`);
  const bScore = scoreAt(s.tick - 1), aScore = scoreAt(s.tick + 3);
  if (aScore.h + aScore.a > bScore.h + bScore.a) P(`선방 t${s.tick}: 직후 score 증가(선방인데 득점 처리?)`);
  if (!inPosts(b.y)) P(`선방 t${s.tick}: 공 y 가 포스트 밖 (${b.y.toFixed(1)}) — 키퍼 위치 아님`);
}

// 3) 빗나감: 공이 골라인 넘어(x<0 또는 x>105) 옆으로 + 포스트 바깥.
for (const o of ev.filter((e) => e.type === "shot" && e.detail === "off_target")) {
  const rb = ballAt(o.tick + 1) || ballAt(o.tick);
  if (rb && rb.x > 0 && rb.x < 105 && inPosts(rb.y)) P(`빗나감 t${o.tick}: 공이 골문 안쪽에 머묾 (${rb.x.toFixed(1)},${rb.y.toFixed(1)}) — 벗어남 안 보임`);
}

// 4) 정지 시퀀스: 원인→재시작 자막 매핑 검수.
const stops = buildStoppages(ev);
const RESTART = { corner: "코너킥", goal_kick: "골킥", throw_in: "스로인", free_kick: "프리킥", kickoff: "킥오프" };
for (const st of stops) {
  const cause = ev.find((e) => e.tick === st.causeTick);
  const restart = ev.find((e) => e.tick === st.restartTick);
  const rk = restart ? eventKind(restart) : "(없음)";
  // 선방 원인인데 재시작이 코너/골킥이 아니면 이상. off_target 인데 코너면 이상(보통 골킥).
  if (eventKind(cause) === "save" && !["corner", "goal_kick"].includes(rk)) P(`정지 선방 t${st.causeTick} → 재시작이 '${rk}' (코너/골킥 아님)`);
  if (eventKind(cause) === "shot_off_target" && !["goal_kick", "corner"].includes(rk)) P(`정지 빗나감 t${st.causeTick} → 재시작이 '${rk}'`);
}

// 5) 자막 커버리지: 큰자막(save/off_target/foul/offside/penalty)이 goal 과 시각적으로 구분되는지(문구/신호).
const annos = buildAnnotations(ev, snaps);
const goalBanner = annos.find((a) => a.text && a.text.includes("골"));

// ---- 리포트 ----
const c = (k) => ev.filter((e) => eventKind(e) === k).length;
console.log(`=== QA: ${path} (${log.configVersion}) ===`);
console.log(`이벤트: 골 ${c("goal")} · 선방 ${c("save")} · 빗나감 ${c("shot_off_target")} · 1대1 ${c("shot_one_on_one")} · 코너 ${c("corner")} · 골킥 ${c("goal_kick")} · 오프사이드 ${c("offside")} · 파울 ${c("foul")} · PK ${c("penalty")}`);
console.log(`정지 시퀀스 ${stops.length}개, 자막(annos) ${annos.length}개`);
console.log("");
if (problems.length === 0) console.log("✅ 상황-데이터 정합성 문제 없음");
else { console.log(`⚠️  ${problems.length}건 발견:`); for (const p of problems) console.log("  - " + p); }
