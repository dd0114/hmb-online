import { type Page } from "@playwright/test";

/**
 * 경기 종료 뒤 **화면을 덮는 카드 스택들**을 유저처럼 지나간다 (#424 브릿지 + #456 보상).
 *
 * 종료·하프 전환에서 오버레이가 화면을 덮고 다음 CTA 를 요구한다. 유저는 그걸 눌러 지나가지만,
 * 브릿지보다 먼저 쓰인 스펙들은 그 걸음을 모른다 — 그래서 그 아래 버튼을 누르려다
 * `subtree intercepts pointer events` 로 죽는다(실측: `to-lobby` 가 그렇게 300초를 태웠다).
 *
 * ⚠️ 계약을 느슨하게 하는 함수가 아니다 — **유저가 실제로 지나는 걸음을 테스트도 지나게** 할 뿐이고,
 * 단언은 호출부에 그대로 남는다(`p406-player-highlight.spec.ts:325` 가 같은 결론을 먼저 적어 뒀다).
 *
 * ⚠️ **덮는 것(blocker)과 누를 것(cta)은 다른 요소다.** 초판은 `match-reward-card` 를 CTA 로도 넣어
 * **카드 `<div>` 자체를 눌렀다** — 클릭은 아무 일도 안 하는데 헬퍼는 "눌렀다"고 여겨 30초를 헛돌고
 * 조용히 반환했다(그 다음 줄의 `to-lobby` 가 대신 죽었다). 스택의 CTA 는 `ReportCardStack` 이
 * 그리는 `{tid}-next` 이고(`HalfReportModal.tsx:453`), 선택 카드만 `actions` 로 갈아끼운다
 * (`MatchRewardFlow.tsx:293`). 그래서 **버튼만** CTA 목록에 둔다.
 */

/** 이게 하나라도 있으면 아직 화면이 덮여 있다 — 뒤 버튼을 누를 수 없다. */
const BLOCKERS = [
  "flow-bridge-card", // 종료/하프 브릿지 (리포트 없음)
  "half-report-card", // 스킵 경로: 브릿지가 리포트 스택 안에 들어간다
  "match-reward-card", // #456 보상 카드 스택
  "match-reward-loading", // 보상 응답 대기(늦으면 pending-exit 가 뜬다)
  "reward-overlay", // #405 보상 시트 — 카드 스택을 지나면 이게 또 덮는다(실측)
];

/** 보이는 것 중 **먼저 오는 것**을 누른다. 전부 실제 `<button>` 이다. */
const CTAS = [
  "flow-bridge-next",
  "half-report-next",
  "match-reward-next",
  "match-reward-choice-later", // 선택 카드는 next 대신 이 버튼이 다음 장으로 간다
  "match-reward-pending-exit",
  // #405 시트: 선택 화면이면 [나중에 선택]/[확인] 으로 목록으로 돌아오고, 목록에서 [확인] 이 닫는다.
  // ⚠️ 미수령이 있으면 첫 [확인] 이 경고로 바뀌고 **두 번째 눌림**이 실제로 닫는다 — 루프가 처리한다.
  "reward-pick-later",
  "reward-pick-done",
  "reward-confirm",
];

export async function passFlowBridge(page: Page, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let blocked = false;
    for (const id of BLOCKERS) {
      if ((await page.getByTestId(id).count()) > 0) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return;

    for (const id of CTAS) {
      const el = page.getByTestId(id).first();
      if ((await el.count()) > 0 && (await el.isVisible())) {
        // ⚠️ 짧은 타임아웃 — actionTimeout 미설정이라 `.catch()` 만 쓰면 테스트 타임아웃까지 매달린다.
        await el.click({ timeout: 5_000 }).catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(250);
  }
  // 여기까지 왔으면 못 지나간 것이다. 조용히 반환하면 호출부가 엉뚱한 곳에서 죽으므로 그대로 알린다.
  const left = [];
  for (const id of BLOCKERS) if ((await page.getByTestId(id).count()) > 0) left.push(id);
  throw new Error(`passFlowBridge: ${timeoutMs}ms 안에 못 지나갔다 — 남은 오버레이 ${left.join(", ")}`);
}
