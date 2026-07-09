import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType, playUntilCaption, situationCaptions, seekCaptions } from "./fixture";

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
  expect(caps.situation).toContain("선방");
  expect(caps.flash).toBe("");
});

test("off_target → 빗나감 상황카드", async ({ page }) => {
  const offs = await eventsOfType(page, "shot", "off_target");
  expect(offs.length).toBeGreaterThan(0);
  const caps = await situationCaptions(page, offs[0].tick);
  expect(caps.situation).toContain("빗나감");
  expect(caps.flash).toBe("");
});

test("set-piece 배너: 코너/골킥/스로인 각각 정확한 텍스트", async ({ page }) => {
  const corner = (await eventsOfType(page, "kickoff", "corner"))[0];
  const goalKick = (await eventsOfType(page, "kickoff", "goal_kick"))[0];
  const throwIn = (await eventsOfType(page, "kickoff", "throw_in"))[0];
  expect(corner && goalKick && throwIn).toBeTruthy();
  expect((await seekCaptions(page, corner.tick)).banner).toContain("코너");
  expect((await seekCaptions(page, goalKick.tick)).banner).toContain("골킥");
  expect((await seekCaptions(page, throwIn.tick)).banner).toContain("스로인");
});

test("킥오프(경기중) → 킥오프 배너", async ({ page }) => {
  const kickoffs = (await eventsOfType(page, "kickoff")).filter((e) => !e.detail && e.minute > 0);
  expect(kickoffs.length).toBeGreaterThan(0);
  expect((await seekCaptions(page, kickoffs[0].tick)).banner).toContain("킥오프");
});
