// match-log.json 을 "인간이 눈으로 따라갈 수 있는가" 관점에서 정량 분석한다.
// 브라우저 없이 화면상 공/선수 이동속도·간격·골 빈도·관전시간을 계산해 가독성 판정.
// 사용: node tools/perceptibility.mjs [경로]  (기본: packages/engine/dev-viewer/match-log.json)
import { readFileSync } from "node:fs";
import { PACE } from "../packages/viewer-core/src/playback.mjs";

const path = process.argv[2] || "packages/engine/dev-viewer/match-log.json";
const log = JSON.parse(readFileSync(path, "utf8"));
const snaps = log.tickSnapshots;
const events = log.events;

// ---- 뷰어 상수(index.html 과 일치) ----
const PITCH_W = 105, PITCH_H = 68;
const CANVAS_W = 1050, MARGIN = 20;
const PX_PER_M = (CANVAS_W - 2 * MARGIN) / PITCH_W; // 전체뷰 배율(약 9.6 px/m)
const FOLLOW_ZOOM = 2.6;
// 뷰어 코어 페이싱 SoT 를 그대로 읽는다(#365) — 여기 숫자를 다시 적으면 배속을 바꾼 날
// 이 도구만 옛 속도로 "읽을 만하다"고 판정한다.
const TICKS_PER_SEC = PACE.TICKS_PER_SEC;
const CRUISE = 4, HL = 1, HL_WINDOW = 8;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);

// tick 간격(원본 틱 수 기준; 서브샘플되면 gap>1)
const tickGap = snaps.length > 1 ? snaps[1].tick - snaps[0].tick : 1;
const matchMinutes = snaps.length ? snaps[snaps.length - 1].minute : 0;
const goals = events.filter((e) => e.type === "goal").length;
const shots = events.filter((e) => e.type === "shot").length;
const corners = events.filter((e) => e.type === "corner" || e.detail === "corner").length;

// ---- 공 이동 속도(게임 m/실초, 그리고 화면 px/실초) ----
// 스냅샷 간 공 이동거리(m) / (스냅샷당 게임초). 게임초 = tickGap.
const ballStepM = [];
for (let i = 1; i < snaps.length; i++) ballStepM.push(dist(snaps[i].ball, snaps[i - 1].ball));
const ballM_perSnap = mean(ballStepM); // 스냅샷당 공 이동 m
const snapsPerRealSec = (spd) => (TICKS_PER_SEC * spd) / tickGap; // 실초당 재생되는 스냅샷 수
const ballScreenPxPerSec = (spd, zoom = 1) => ballM_perSnap * PX_PER_M * zoom * snapsPerRealSec(spd);

// ---- 팀 spread(가로/세로 m) ----
const spread = (sn, team) => {
  const ps = sn.players.filter((p) => p.team === team);
  const xs = ps.map((p) => p.pos.x), ys = ps.map((p) => p.pos.y);
  return { w: Math.max(...ys) - Math.min(...ys), l: Math.max(...xs) - Math.min(...xs) };
};
const widths = [], lengths = [];
for (let i = 0; i < snaps.length; i += Math.max(1, Math.floor(snaps.length / 200))) {
  const s = spread(snaps[i], "home");
  widths.push(s.w); lengths.push(s.l);
}
// 주의: x=피치 길이(105), y=피치 폭(68). width=y범위, length=x범위.

// ---- 선수 최근접 간격(뭉침 지표) ----
const nnGaps = [];
for (let i = 0; i < snaps.length; i += Math.max(1, Math.floor(snaps.length / 100))) {
  const ps = snaps[i].players;
  for (const a of ps) {
    let m = Infinity;
    for (const b of ps) if (a !== b) m = Math.min(m, dist(a.pos, b.pos));
    nnGaps.push(m);
  }
}

// ---- 관전 시간(하이라이트 자동페이싱) ----
const keyTicks = events.filter((e) => e.type === "goal" || (e.type === "shot" && e.detail == null)).map((e) => e.tick);
let watchSec = 0;
for (const s of snaps) {
  const near = keyTicks.some((kt) => Math.abs(kt - s.tick) <= HL_WINDOW);
  const spd = near ? HL : CRUISE;
  watchSec += tickGap / (TICKS_PER_SEC * spd);
}

// ---- 판정 밴드(경험적) ----
const band = (v, lo, hi) => (v < lo ? "느림/작음" : v > hi ? "빠름/큼" : "적정");
const cruiseFull = ballScreenPxPerSec(CRUISE, 1);
const hlFollow = ballScreenPxPerSec(HL, FOLLOW_ZOOM);
const goalEveryWatchSec = goals > 0 ? watchSec / goals : Infinity;

console.log(`=== 가독성 분석: ${path} ===`);
console.log(`config ${log.configVersion} · seed ${log.seed} · 스냅샷 ${snaps.length} (tickGap ${tickGap}) · 경기 ${matchMinutes}분`);
console.log(`\n[경기 내용]`);
console.log(`  골 ${goals} · 슛 ${shots} · 코너 ${corners} · 최종 ${log.finalScore.home}:${log.finalScore.away}`);
console.log(`\n[팀 spread] (실제 벤치마크: 폭 40~50m, 길이 25~40m)`);
console.log(`  폭(width)  평균 ${mean(widths).toFixed(1)}m  → ${band(mean(widths), 35, 55)}`);
console.log(`  길이(length) 평균 ${mean(lengths).toFixed(1)}m → ${band(mean(lengths), 22, 42)}`);
console.log(`  선수 최근접 간격 평균 ${mean(nnGaps).toFixed(1)}m (너무 작으면 뭉침)`);
console.log(`\n[공 화면 이동속도] (사람이 따라갈 밴드 대략 120~650 px/s)`);
console.log(`  전체뷰 6배속(빌드업): ${cruiseFull.toFixed(0)} px/s → ${band(cruiseFull, 120, 650)}`);
console.log(`  공따라가기 1배속(찬스): ${hlFollow.toFixed(0)} px/s → ${band(hlFollow, 120, 650)}`);
console.log(`  공 이동 ${ballM_perSnap.toFixed(2)} m/스냅샷`);
console.log(`\n[관전 시간/골 빈도]`);
console.log(`  하이라이트 자동페이싱 총 관전 ${(watchSec).toFixed(0)}초 (${(watchSec / 60).toFixed(1)}분)`);
console.log(`  골 1개당 관전 ${goalEveryWatchSec === Infinity ? "∞" : goalEveryWatchSec.toFixed(0) + "초"} (목표: 30~60초마다 볼거리)`);

// ---- 종합 verdict ----
const checks = [
  ["팀 폭 적정", mean(widths) >= 35 && mean(widths) <= 60],
  ["선수 뭉침 아님(최근접 ≥5m)", mean(nnGaps) >= 5],
  ["빌드업 공속도 인지가능", cruiseFull >= 100 && cruiseFull <= 750],
  ["찬스 공속도 인지가능", hlFollow >= 100 && hlFollow <= 750],
  ["관전시간 적정(2~6분)", watchSec >= 90 && watchSec <= 420],
  ["골 볼거리 빈도(≤75초/골)", goalEveryWatchSec <= 75],
];
console.log(`\n[종합 판정]`);
for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "⚠️ "} ${name}`);
const pass = checks.filter(([, ok]) => ok).length;
console.log(`\n  => ${pass}/${checks.length} 통과 ${pass === checks.length ? "(인지가능 범위)" : "(조정 필요)"}`);
