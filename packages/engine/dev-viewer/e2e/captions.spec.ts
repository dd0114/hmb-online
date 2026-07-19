import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType, playUntilCaption, playUntilSituationContains, situationCaptions, seekCaptions, VIEWER_REAL_URL } from "./fixture";

// 자막 계약: 이벤트 타입별로 화면에 뜨는 자막(flash=거대 GOAL / situation=상황카드 / banner=상단)이
// 정확한 텍스트인지 + GOAL 플래시는 오직 goal 에서만. (공 위치가 아니라 "자막 레이어" 검증.)
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("goal → 거대 GOAL 플래시 (situation 아님)", async ({ page }) => {
  const goals = await eventsOfType(page, "goal");
  expect(goals.length).toBeGreaterThan(0);
  const caps = await playUntilCaption(page, goals[0].tick - 2);
  expect(caps.flash).toContain("GOAL");
  expect(caps.situation).toBe(""); // 골은 상황카드가 아니라 플래시로만.
});

test("save → 선방 상황카드, GOAL 플래시 없음", async ({ page }) => {
  const saves = await eventsOfType(page, "save");
  expect(saves.length).toBeGreaterThan(0);
  // 재생하며 선방 자막이 뜰 때 캡처 → flash 는 비어야(골 오인 방지 계약).
  const caps = await playUntilCaption(page, saves[0].tick - 2);
  expect(caps.situation).toContain("SAVE");
  expect(caps.flash).toBe("");
});

test("off_target → 빗나감 상황카드", async ({ page }) => {
  // 쇼케이스 시드엔 off_target 이 없을 수 있어 real config 픽스처로 검증.
  await loadViewer(page, VIEWER_REAL_URL);
  const offs = await eventsOfType(page, "shot", "off_target");
  expect(offs.length).toBeGreaterThan(0);
  const caps = await situationCaptions(page, offs[0].tick);
  expect(caps.situation).toContain("OFF TARGET");
  expect(caps.flash).toBe("");
});

test("set-piece 배너: 코너/골킥/스로인 각각 정확한 텍스트", async ({ page }) => {
  const corner = (await eventsOfType(page, "kickoff", "corner"))[0];
  const goalKick = (await eventsOfType(page, "kickoff", "goal_kick"))[0];
  const throwIn = (await eventsOfType(page, "kickoff", "throw_in"))[0];
  expect(corner && goalKick && throwIn).toBeTruthy();
  expect((await seekCaptions(page, corner.tick)).banner).toContain("CORNER");
  expect((await seekCaptions(page, goalKick.tick)).banner).toContain("GOAL KICK");
  expect((await seekCaptions(page, throwIn.tick)).banner).toContain("THROW");
});

// #29: 재생 중 코너/스로인은 큰 상황자막으로 정지 → 관객이 세트피스를 인지.
// 시작을 넉넉히 앞(-8)에서: 세이브→코너처럼 선행 정지가 코너 틱으로 skip-착지해도 코너 자막이
// 누락되지 않아야 한다(트리거 경계 버그 회귀 방지).
test("corner → 재생 중 '코너킥!' 상황카드로 정지 (선행 정지 skip 착지에도 누락 없음)", async ({ page }) => {
  const corner = (await eventsOfType(page, "kickoff", "corner"))[0];
  expect(corner).toBeTruthy();
  const caps = await playUntilSituationContains(page, corner.tick - 8, "CORNER");
  expect(caps.situation).toContain("CORNER");
  expect(caps.flash).toBe(""); // 골 플래시 아님.
});

test("throw_in → 재생 중 '스로인!' 상황카드로 정지 (배너만이 아님)", async ({ page }) => {
  const throwIn = (await eventsOfType(page, "kickoff", "throw_in"))[0];
  expect(throwIn).toBeTruthy();
  const caps = await playUntilSituationContains(page, throwIn.tick - 3, "THROW");
  expect(caps.situation).toContain("THROW");
  expect(caps.flash).toBe("");
});

test("킥오프(경기중) → 킥오프 배너", async ({ page }) => {
  const kickoffs = (await eventsOfType(page, "kickoff")).filter((e) => !e.detail && e.minute > 0);
  expect(kickoffs.length).toBeGreaterThan(0);
  expect((await seekCaptions(page, kickoffs[0].tick)).banner).toContain("KICK-OFF");
});
