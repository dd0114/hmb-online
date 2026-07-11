// 실화면 캡처 템플릿 — tools/qa_capture.mjs 등으로 복사해 쓴다(tools/qa_*.mjs 는 gitignore).
// 실행: cd ~/spider/hmb-online && node tools/qa_capture.mjs
// 주의: playwright 모듈 해석 때문에 리포지토리 루트의 node_modules 가 보이는 위치(tools/)에서 실행할 것.
import { chromium } from "playwright";

// 출력 폴더는 세션 scratchpad 로(프로젝트 오염 방지). 실제 경로로 바꿔서 쓰기.
const OUT = process.env.OUT || "/tmp/hmb-capture";
// e2e 풀해상도 테스트 뷰어(globalSetup 또는 `node packages/engine/dev-viewer/e2e/build-test-viewer.mjs` 로 빌드).
const VIEWER = "file:///Users/peter.park/spider/hmb-online/packages/engine/dev-viewer/e2e/viewer-test.html";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 780 } });
await p.goto(VIEWER);
await p.waitForFunction(() => window.__viewer && window.__viewer.ready());

// ── 패턴 A: 특정 틱들을 정지 상태로 캡처(레이아웃/자막 확인) ──
await p.evaluate(() => window.__viewer.autoPace(false)); // 전체뷰 고정(줌 방지)
for (const [tick, name] of [[92, "goal"], [145, "save"], [633, "corner"]]) {
  await p.evaluate((t) => window.__viewer.seek(t), tick);
  await p.waitForTimeout(60);
  await p.screenshot({ path: `${OUT}/scene-${name}-t${tick}.png` });
}

// ── 패턴 B: 재생하며 연출 진행 캡처(트윈/자막/카메라 확인) ──
const GOAL = 92;
await p.evaluate((t) => { window.__viewer.seek(t); window.__viewer.play(); }, GOAL - 3);
for (let i = 0; i < 9; i++) {
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/play-${String(i).padStart(2, "0")}.png` });
}

// ── 패턴 C: 순간이동 수치 검출(렌더된 보간 공 샘플) ──
const launch = 91, land = 92; // 슛 발사틱 → 도착틱
const a = await p.evaluate((t) => window.__viewer.idxOfTick(t), launch);
const g = await p.evaluate((t) => window.__viewer.idxOfTick(t), land);
let prev = null, maxStep = 0;
for (let tp = a; tp <= g + 1e-9; tp = +(tp + 0.1).toFixed(4)) {
  const ball = await p.evaluate((x) => window.__viewer.renderAt(x), tp);
  if (prev) maxStep = Math.max(maxStep, Math.hypot(ball.x - prev.x, ball.y - prev.y));
  prev = ball;
}
console.log(`렌더 공 인접프레임 최대 이동 = ${maxStep.toFixed(1)}m ${maxStep > 5 ? "← 순간이동!" : "(부드러움)"}`);

await b.close();
console.log(`캡처 완료 → ${OUT} (Read 로 PNG 를 직접 열어 눈으로 확인할 것)`);
// ⚠️ 디스크 규율: 프레임 단위 검증은 위 "패턴 C"처럼 renderAt/cam() 수치를 메모리로 모아 판단하고
//    프레임마다 PNG 저장하지 말 것. 눈확인 끝나면 반드시 정리: `rm -rf $OUT` (안 지우면 /private/tmp 에 누적).
