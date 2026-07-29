import { emptyHalftimeDraft, withDraftText, type HalftimeDraft, type PromptTarget } from "./halftime-draft";
import type { HalftimeDraftHandle } from "./useHalftimeDraft";

/**
 * 테스트용 초안 핸들 (#284). `useHalftimeDraft` 는 훅이라 컴포넌트 밖에서 못 만들고, 패널 계약을
 * 재는 데 실제 디바운스·localStorage 가 필요하지도 않다 — **여기서 만든 건 저장을 흉내 내지 않는다**.
 *
 * ⚠️ 그래서 이 픽스처로는 "자동 저장이 실제로 나갔는가"를 못 잰다 — 그건 훅 자신의 테스트와
 * e2e(`p284-info-tabs.spec.ts`) 가 잰다. 여기서 흉내 내면 두 곳이 조용히 갈라진다.
 */
export function stubDraftHandle(
  init?: { team?: string; players?: Record<string, string> },
): HalftimeDraftHandle {
  let draft: HalftimeDraft = emptyHalftimeDraft();
  if (init?.team) draft = withDraftText(draft, null, init.team);
  for (const [id, text] of Object.entries(init?.players ?? {})) {
    draft = withDraftText(draft, id, text);
  }
  const setText = (target: PromptTarget, text: string) => {
    draft = withDraftText(draft, target, text);
  };
  return {
    get draft() {
      return draft;
    },
    status: "idle",
    error: null,
    setText,
    flush: async () => {},
    markSent: () => {},
  };
}
