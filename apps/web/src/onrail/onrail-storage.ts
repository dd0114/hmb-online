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
import { ONRAIL_SKIP_REASONS, type OnRailSkipReason } from "./onrail-logic";
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

/**
 * 건너뛴 스텝 한 건 (#493 W9).
 *
 * ⚠️ **콘솔이 아니라 상태에 적는다.** 스킵은 그 유저에게 "튜토리얼이 못 보여 준 것"의 목록이고,
 * 나중에 *어느 전제가 실제로 얼마나 자주 깨지나*(쿠폰 없는 유저 비율 · 잠긴 화면 비율)를 세려면
 * 그게 SoT 여야 한다. 콘솔 로그는 유저 기기를 떠나지 않고 새로고침에 사라진다.
 */
export interface OnRailSkip {
  /** 건너뛴 스텝. */
  stepId: OnRailStepId;
  reason: OnRailSkipReason;
  /** 대신 선 스텝(`null` = 그대로 완주로 내려갔다). 범위가 신 전체인 스킵의 크기가 여기 남는다. */
  to: OnRailStepId | null;
  /** ISO 시각 — 순서와 간격을 나중에 읽기 위해. */
  at: string;
}

/** 진행 상태가 무한히 자라지 않게 — 각본 길이(현재 21)의 두 배면 어떤 run 도 다 담는다. */
export const ONRAIL_SKIP_LOG_MAX = 40;

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
  /** 전제 불성립으로 건너뛴 스텝들(#493 W9). 없으면 생략된다 — 구 저장값과 호환. */
  skips?: OnRailSkip[];
  /**
   * **덱 드래프트를 한 번 비우라**는 일회성 지시 (#493 W9).
   *
   * ⚠️ 화면 상태가 아니라 여기 사는 이유: `start()` 는 곧바로 `/deck` 으로 이동하는데, 그 화면은
   * **아직 마운트되지 않았다**. 프로바이더 메모리에 두면 그 사이의 새로고침 한 번에 지시가 사라져
   * S2 각본의 전제(빈 보드)가 조용히 깨진다. 소비는 `DeckPage` 가 에디터를 초기화하는 그 한 번뿐이고,
   * 소비하면서 지운다.
   */
  deckDraftReset?: boolean;
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
    const { status, stepId, matchId, skips, deckDraftReset } = parsed as {
      status?: unknown;
      stepId?: unknown;
      matchId?: unknown;
      skips?: unknown;
      deckDraftReset?: unknown;
    };
    if (typeof status !== "string" || !STATUSES.includes(status as OnRailStatus)) return IDLE;
    return {
      status: status as OnRailStatus,
      stepId: typeof stepId === "string" ? (stepId as OnRailStepId) : null,
      matchId: typeof matchId === "string" ? matchId : null,
      skips: sanitizeSkips(skips),
      deckDraftReset: deckDraftReset === true,
    };
  } catch {
    return IDLE;
  }
}

/**
 * 스킵 기록도 **모양이 아니면 버린다** — 손상된 한 건이 진행 상태 전체를 idle 로 되돌리면
 * (= 튜토리얼이 처음부터) 기록 하나 때문에 진행도를 잃는다. 기록은 부차적이므로 **그것만** 버린다.
 */
function sanitizeSkips(raw: unknown): OnRailSkip[] {
  if (!Array.isArray(raw)) return [];
  const out: OnRailSkip[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { stepId, reason, to, at } = item as Record<string, unknown>;
    if (typeof stepId !== "string" || stepId.length === 0) continue;
    if (typeof reason !== "string") continue;
    if (!ONRAIL_SKIP_REASONS.includes(reason as OnRailSkipReason)) continue;
    out.push({
      stepId: stepId as OnRailStepId,
      reason: reason as OnRailSkipReason,
      to: typeof to === "string" ? (to as OnRailStepId) : null,
      at: typeof at === "string" ? at : "",
    });
  }
  return out.slice(-ONRAIL_SKIP_LOG_MAX);
}

/** 기록 한 건을 뒤에 붙인다(상한 초과분은 **오래된 쪽**을 버린다 — 최근 run 이 분석 대상이다). */
export function appendSkip(skips: OnRailSkip[] | undefined, next: OnRailSkip): OnRailSkip[] {
  return [...(skips ?? []), next].slice(-ONRAIL_SKIP_LOG_MAX);
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
