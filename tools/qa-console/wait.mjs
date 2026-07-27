// 피드백 대기(#191 AC3). 세션이 hero 를 기다리는 방법.
//
// 왜 블로킹 CLI 인가: 세션이 이걸 백그라운드로 걸면 **피드백 도착 = 프로세스 종료 = 세션 자동 재진입**이다.
// 주기 wakeup 폴링은 조용할 때도 토큰을 태운다(메모리 patrol-static-not-claude) — 그걸 피하는 형태다.
//
// fs.watch 로 즉시 깨고, watch 가 못 잡는 경우(NFS·에디터 rename·플랫폼 차이)를 위해 저해상도 폴링을 같이 둔다.
// 둘 다 같은 판정 함수를 쓰므로 중복 발화는 무해하다(idempotent).
import { existsSync, watch } from "node:fs";
import { feedbackDir, readAck, readFeedback, tabPath, unreadFeedback } from "./registry.mjs";

/** 세션이 아직 못 받은 피드백을 지금 시점에 계산한다. `since` 를 주면 ack 커서 대신 그 값을 쓴다. */
export function pendingFeedback(home, tabId, since = null) {
  const feedback = readFeedback(home, tabId);
  if (since != null) return feedback.filter((f) => Number(f.seq) > Number(since));
  return unreadFeedback(feedback, readAck(home, tabId));
}

/**
 * 새 피드백이 올 때까지 기다린다.
 *
 * @returns `{status:"feedback", items}` — 1건 이상 도착(또는 대기 시작 시점에 이미 있었음)
 *          `{status:"timeout", items:[]}` — timeoutMs 경과
 *          `{status:"gone"}` — 대기 중 탭이 삭제됨(세션이 매달려 있지 않게 알려준다)
 * @throws 탭이 처음부터 없으면 — 오타를 조용히 삼키지 않는다
 */
export function waitForFeedback({
  home,
  tabId,
  since = null,
  timeoutMs = 900_000,
  pollMs = 1000,
} = {}) {
  if (!existsSync(tabPath(home, tabId))) {
    return Promise.reject(new Error(`없는 탭이다: ${tabId} (먼저 register)`));
  }

  const immediate = pendingFeedback(home, tabId, since);
  if (immediate.length > 0) return Promise.resolve({ status: "feedback", items: immediate });

  return new Promise((settle) => {
    let done = false;
    let watcher = null;
    let timer = null;
    let deadline = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* 이미 닫힘 */
        }
      }
      if (timer) clearInterval(timer);
      if (deadline) clearTimeout(deadline);
      settle(result);
    };

    const check = () => {
      if (done) return;
      // 탭이 지워졌으면 계속 기다려도 아무 일도 안 생긴다 → 세션에 알린다.
      if (!existsSync(tabPath(home, tabId))) return finish({ status: "gone", items: [] });
      const items = pendingFeedback(home, tabId, since);
      if (items.length > 0) finish({ status: "feedback", items });
    };

    try {
      // 파일이 아직 없을 수 있으니 **디렉토리**를 본다(첫 피드백이 곧 파일 생성이다).
      watcher = watch(feedbackDir(home), { persistent: true }, check);
    } catch {
      watcher = null; // watch 불가 환경 — 아래 폴링이 담당한다
    }
    timer = setInterval(check, Math.max(50, pollMs));
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      deadline = setTimeout(() => finish({ status: "timeout", items: [] }), timeoutMs);
    }
  });
}
