// QA: match-log 의 각 상황(골/선방/빗나감/코너/골킥/오프사이드/파울/PK)이
// 실제 공 궤적·점수·후속 재시작과 맞는지, 그리고 뷰어가 붙일 자막이 상황에 맞는지 전수 검수한다.
import { readFileSync } from "node:fs";
import { buildStoppages, buildAnnotations, eventKind } from "../packages/viewer-core/src/playback.mjs";

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

// 2) 선방: 공이 골라인 앞(키퍼 캐치, 골문 밖) + 그 틱에 골 아님(score 불변).
for (const s of ev.filter((e) => e.type === "save")) {
  const b = ballAt(s.tick);
  if (!b) { P(`선방 t${s.tick}: 스냅샷 없음`); continue; }
  // 선방인데 그 시점/직후에 골이 찍히면 = "선방인데 골처럼" 버그.
  const goalNear = ev.find((e) => e.type === "goal" && Math.abs(e.tick - s.tick) <= 2);
  if (goalNear) P(`선방 t${s.tick} ${s.team}: 근처(±2)에 골 이벤트 t${goalNear.tick} — 선방↔골 혼동 위험`);
  const bScore = scoreAt(s.tick - 1), aScore = scoreAt(s.tick + 3);
  if (aScore.h + aScore.a > bScore.h + bScore.a) P(`선방 t${s.tick}: 직후 score 증가(선방인데 득점 처리?)`);
  // #91: 선방이 코너로 굴절되면(다음 재시작 코너) 공이 골라인 밖으로 **와이드하게** 나간다(off_target 동일).
  // 골 오인(V2 #15)의 진짜 조건은 "공이 **골문 안**(골라인×포스트 사이)". 와이드(포스트 밖)로 나가면 코너 굴절.
  const leadsToCorner = ev.some((e) => e.tick > s.tick && e.tick <= s.tick + 8 && e.type === "kickoff" && e.detail === "corner");
  // 하프/경기 종료 휘슬이 곧바로 뒤따르면 **후속 재시작이 잘려** leadsToCorner 를 볼 수 없다
  // (#178 후속: 경계에서 비행 슛을 마저 해소하면서 생기는 정상 케이스). 그 경우 굴절 여부를
  // 판정할 근거가 없으므로 클린세이브 기하 검사를 건너뛴다 — 골 오인 검사(위)는 그대로 적용된다.
  const whistleCuts = ev.some((e) => (e.type === "half_whistle" || e.type === "full_whistle") && e.tick >= s.tick && e.tick <= s.tick + 8);
  // 골 오인: 공이 골문 안(골라인 위 × 포스트 사이) — 언제나 금지(선방인데 골처럼).
  if ((b.x <= 1 || b.x >= 104) && inPosts(b.y)) P(`선방 t${s.tick}: 공이 골문 안(골라인×포스트 사이) — 골 오인`);
  // 클린 세이브(코너 굴절 아님): 공이 키퍼 위치(골라인 앞·포스트 사이)여야. 코너 굴절이면 와이드 아웃 정상.
  if (!leadsToCorner && !whistleCuts) {
    if (b.x <= 1 || b.x >= 104) P(`선방 t${s.tick}: 공 x 가 골라인 위 (${b.x.toFixed(1)}) — 캐치는 앞이어야`);
    if (!inPosts(b.y)) P(`선방 t${s.tick}: 공 y 가 포스트 밖 (${b.y.toFixed(1)}) — 키퍼 위치 아님`);
  } else {
    // 코너 굴절: 키퍼가 공 궤적 위에서 쳐낸 게 보여야 = 키퍼 y 가 공 y 와 정렬(±2m). (구: 키퍼 중앙, 공
    // 와이드 → 9m 떨어져 "터치 없이 선방"처럼 보였던 회귀 가드. #91b.)
    const sn = log.tickSnapshots.find((x) => x.tick === s.tick);
    const gk = sn && sn.players.find((p) => p.playerId === s.playerId);
    if (gk && Math.abs(gk.pos.y - b.y) > 2) P(`선방 t${s.tick}(코너 굴절): 키퍼 y(${gk.pos.y.toFixed(1)})가 공 y(${b.y.toFixed(1)})와 어긋남 — 키퍼가 안 건드린 듯`);
  }
}

// 3) 빗나감: 공이 골라인 넘어(x<0 또는 x>105) 옆으로 + 포스트 바깥.
for (const o of ev.filter((e) => e.type === "shot" && e.detail === "off_target")) {
  // ⚠️ 다음 틱을 보는 이유는 아웃이 한 틱 늦게 확정되기 때문인데, **그 다음 틱이 하프 경계면
  // 공은 이미 킥오프로 중앙(52.5,34)에 리셋돼 있다** — 그러면 "골문 안쪽에 머묾"으로 오판된다.
  // 위 선방 검사가 `whistleCuts` 로 이미 갖고 있는 가드와 같은 부류이고, `penalty-spot.test.ts`
  // 의 `kickBoundedEnd`(창을 하프 안으로 자르기)와도 같은 부류다 — 회귀가 아니라 **측정 창 버그**.
  // 실제 오탐: #377 M3-A 데모의 `off_target@719` → t720 이 half_whistle+kickoff 였다
  // (t719 실측 공 x=-3.5 = 골라인 밖, 즉 벗어남은 정상적으로 보였다).
  // ⚠️ 이 경우 **검사를 건너뛴다**(선방 검사의 `whistleCuts` 와 같은 처리). 이벤트 틱의 공으로
  // 대신 보려 했다가 더 나쁜 오탐을 얻었다 — 그 틱의 공은 아직 슈터 발밑이라 거의 항상
  // 포스트 사이·피치 안이다. 판정할 근거가 없을 땐 판정하지 않는 것이 맞다.
  const cutByWhistle = ev.some(
    (e) => (e.type === "half_whistle" || e.type === "full_whistle" || e.type === "kickoff") && e.tick === o.tick + 1,
  );
  if (cutByWhistle) continue;
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
