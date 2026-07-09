import type { CoachBackend } from "./coach-backend.js";
import { anthropicCoachBackend } from "./backends/anthropic.js";
import { stubCoachBackend } from "./backends/stub.js";

/**
 * 환경설정 기반 백엔드 선택. `COACH_BACKEND=anthropic|stub` 로 강제, 미지정 시:
 * 자격증명(API 키/구독 토큰)이 있으면 anthropic, 없으면 stub(오프라인/테스트).
 * 모델은 anthropic 백엔드가 `COACH_MODEL`(기본 sonnet) 로 결정.
 */
export function defaultCoachBackend(): CoachBackend {
  const kind = process.env["COACH_BACKEND"]
    ?? (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"] ? "anthropic" : "stub");
  switch (kind) {
    case "stub":
      return stubCoachBackend();
    case "anthropic":
    default:
      return anthropicCoachBackend();
  }
}
