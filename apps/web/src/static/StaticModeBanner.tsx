/**
 * 스태틱 모드 안내 배너 (#444).
 *
 * hero 지시: *"로그인 안돼서 스태틱하게된다고만 알려주게하고"* — **안내만** 한다. 플레이를 막지
 * 않고, 로그인을 강요하지 않고, 재시도 버튼도 두지 않는다(닫기만 있다).
 *
 * ⚠️ 이 파일은 `App.tsx` 에서 **lazy** 로만 불린다. 정적 import 하면 AI 상태 모듈 → `stubExecutor`
 * → 엔진이 라이브 번들로 딸려 들어간다(스태틱 모드의 비용을 안 쓰는 배포가 물게 된다).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { aiStatus, probeAi, subscribeAiStatus, type AiStatus } from "./tactics";
import styles from "./StaticModeBanner.module.css";

const DISMISS_KEY = "hmb.static.banner.dismissed";

function messageOf(status: AiStatus): { tone: "info" | "ok"; text: string } {
  switch (status.kind) {
    case "ready":
      return {
        tone: "ok",
        text: "Claude Code 에 연결됐습니다 — 선수 프롬프트가 AI 전술 인풋으로 반영됩니다.",
      };
    case "not-logged-in":
      return {
        tone: "info",
        text: "Claude Code 로그인이 확인되지 않아 스태틱 엔진 계산으로 진행합니다.",
      };
    default:
      return {
        tone: "info",
        text: "데모 빌드입니다 — 서버 없이 목데이터 + 스태틱 엔진 계산으로 동작합니다. 프롬프트를 AI 전술로 반영하려면 로컬에서 Claude Code 로그인 후 실행하세요.",
      };
  }
}

export default function StaticModeBanner(): React.ReactElement | null {
  const status = useSyncExternalStore(subscribeAiStatus, aiStatus, aiStatus);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    void probeAi();
  }, []);

  if (dismissed) return null;
  const { tone, text } = messageOf(status);
  return (
    <div className={`${styles.banner} ${tone === "ok" ? styles.ok : styles.info}`} data-testid="static-mode-banner">
      <span className={styles.text}>{text}</span>
      <button
        type="button"
        className={styles.close}
        aria-label="안내 닫기"
        onClick={() => {
          try {
            window.sessionStorage.setItem(DISMISS_KEY, "1");
          } catch {
            // 저장 실패는 무시 — 이번 화면에서만 닫힌다.
          }
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}
