/**
 * #493 W7-v3 — 온레일 튜토리얼 진행 상태(localStorage).
 *
 * ⚠️ **키는 userId 격리다** — `guide-storage.ts` 머리말의 규율을 그대로 따른다(한 기기에서 계정을
 * 바꾸면 남의 진행도가 따라오던 결함을 반복하지 않는다). userId 를 모르면 아무것도 쓰지 않는다.
 *
 * 왜 화면 단위(`guide-storage.seen`)가 아니라 **스텝 단위**인가: 온레일은 화면을 넘나드는 **한 줄기
 * 시나리오**다(덱 → 경기 → 결과 → 성장 → 트레이드). 스토리보드 엣지 표가 요구하는 것도
 * *"진행 스텝 저장 → 재진입 시 **그 스텝부터** 재개"* 라 저장 단위가 곧 스텝이어야 한다.
 * 화면 단위로 저장하면 "덱 화면 중간에서 새로고침" 이 처음으로 되감긴다.
 */
import type { OnRailStepId } from "./onrail-script";

const KEY = (userId: string) => `hmb.onrail.${userId}`;

export type OnRailStatus =
  /** 아직 제안조차 안 했거나, 제안 모달 단계 (S1) */
  | "idle"
  /** 온레일 진행 중 — `stepId` 가 지금 스텝 */
  | "running"
  /** 유저가 [건너뛰기] 로 사양했다. **재노출 없음**(스토리보드 조정 ⑥). */
  | "skipped"
  /** 완주(S7). */
  | "done";

export interface OnRailState {
  status: OnRailStatus;
  /** running 일 때만 의미가 있다. 모르는 id 면 로직이 첫 스텝으로 되돌린다. */
  stepId: OnRailStepId | null;
  /**
   * 온레일이 만든 튜토리얼 매치 id.
   *
   * ⚠️ **재생 정지(S3 투어)를 이 값으로 좁힌다.** "지금 스텝이 투어다"만 보고 얼리면, 유저가
   * 중간에 홈으로 나가 **다른 경기**를 시작했을 때 그 경기가 얼어붙는다. 새로고침을 넘겨야
   * 하므로 메모리가 아니라 여기 산다.
   */
  matchId?: string | null;
}

const IDLE: OnRailState = { status: "idle", stepId: null, matchId: null };

const STATUSES: readonly OnRailStatus[] = ["idle", "running", "skipped", "done"];

/**
 * 저장된 진행 상태. **모양이 아니면 idle** — 손상된 값 하나가 앱을 못 쓰게 만들면 안 된다
 * (`guide-storage.readGuideSeen` 과 같은 규율).
 */
export function readOnRail(userId: string | null): OnRailState {
  if (!userId) return IDLE;
  try {
    const raw = window.localStorage.getItem(KEY(userId));
    if (!raw) return IDLE;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return IDLE;
    const { status, stepId, matchId } = parsed as {
      status?: unknown;
      stepId?: unknown;
      matchId?: unknown;
    };
    if (typeof status !== "string" || !STATUSES.includes(status as OnRailStatus)) return IDLE;
    return {
      status: status as OnRailStatus,
      stepId: typeof stepId === "string" ? (stepId as OnRailStepId) : null,
      matchId: typeof matchId === "string" ? matchId : null,
    };
  } catch {
    return IDLE;
  }
}

export function writeOnRail(userId: string | null, state: OnRailState): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(KEY(userId), JSON.stringify(state));
  } catch {
    /* 저장 불가(사파리 프라이빗 등) — 새로고침에 처음부터가 될 뿐 동선은 그대로 */
  }
}

/** 계정 전환·다시 시작 — 그 계정 몫만 지운다. */
export function clearOnRail(userId: string | null): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(KEY(userId));
  } catch {
    /* no-op */
  }
}

/** 온레일이 이 계정에서 이미 끝났나(완주 또는 사양) — 다시 제안하지 않는 근거. */
export function onRailSettled(userId: string | null): boolean {
  const s = readOnRail(userId).status;
  return s === "done" || s === "skipped";
}
