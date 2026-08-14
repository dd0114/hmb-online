/**
 * #504 D2 — 온레일 관측(계측). **동선을 하나도 바꾸지 않는다.**
 *
 * ## 왜 있나
 * 온레일(#493)은 브라우저 안에서만 도는 안내 계층이라 진행 상태가 `localStorage hmb.onrail.<uid>`
 * 하나뿐이었다. 그래서 오픈베타 실유저 2명이 온레일을 한 명도 밟지 않은 것을 확인하고도
 * **"제안을 못 받았다"와 "제안을 받고 거절했다"를 서버에서 가를 수 없었다** — 세 가설의 흔적이
 * 완전히 같았다(#504 조사). 그 결손이 있는 한 동선(D1)을 고쳐도 **고쳐졌는지 셀 수 없다**.
 *
 * ## 규율 셋
 * 1. **실패는 삼킨다.** 계측 한 줄이 튜토리얼을 멈추면 그건 계측이 게임을 깨뜨린 것이다
 *    (서버 `BusinessEventRecorder` 의 3층 봉인과 같은 규율의 클라 쪽 절반).
 * 2. **await 하지 않는다.** 호출부는 전부 클릭 핸들러·마운트 이펙트라, 기다리면 그만큼 화면이
 *    늦는다. 반환값도 없다 — 클라가 분기할 것이 있으면 그게 곧 동선 변경이다.
 * 3. **같은 사실을 두 번 보내지 않는다.** 서버도 유저당 1행으로 좁히지만(#496 `recordOnce`),
 *    스텝은 반복이 의미를 가져 서버가 못 좁힌다 — 그건 여기서 **스텝별 1회**로 좁힌다.
 *    저장소가 `localStorage` 인 이유는 그 좁힘이 **새로고침을 넘겨야** 하기 때문이다.
 *
 * ⚠️ 여기서 보내는 값은 **지표지 근거가 아니다**(서버 `OnRailEventsController` javadoc). 보상·
 * 권한의 근거로 쓰지 마라 — #493 W9 가 클라 신고를 완주 보상 판정에서 걷어낸 것이 그 교훈이다.
 */
import { apiFetch } from "../api/client";

/** 서버 `BusinessEvent.CLIENT_REPORTABLE` 과 **같은 목록**이어야 한다(다르면 400). */
export const ONRAIL_EVENTS = {
  /** 홈 [게임 시작]에서 제안 모달이 실제로 떴다. */
  offerShown: "onrail_offer_shown",
  /** **자격이 있는데 제안 없이 게임 화면에 도착했다** — D1 우회의 크기를 재는 유일한 신호. */
  offerMissed: "onrail_offer_missed",
  accepted: "onrail_accepted",
  declined: "onrail_declined",
  step: "onrail_step",
  done: "onrail_done",
} as const;

export type OnRailEvent = (typeof ONRAIL_EVENTS)[keyof typeof ONRAIL_EVENTS];

/**
 * 보고 이력 — 진행 상태(`hmb.onrail.<uid>`)와 **다른 키**다.
 *
 * ⚠️ 진행 상태에 섞지 않는 이유: 그 값은 `readOnRail` 이 모양을 검사해 아니면 통째로 `idle` 로
 * 되돌린다(= 튜토리얼이 처음부터). 계측 이력 한 줄이 손상돼 진행도를 잃으면 부가 기능이 본
 * 기능을 깨뜨린 것이다. 키를 가르면 그 사고가 **구조적으로** 불가능하다.
 */
const SENT_KEY = (userId: string) => `hmb.onrail.sent.${userId}`;

/** 각본 길이(현재 21)의 세 배 — 어떤 run 도 다 담고 무한히 자라지 않는다. */
export const ONRAIL_SENT_MAX = 64;

/** 같은 사실을 두 번 세지 않기 위한 식별자. 스텝만 스텝 id 로 갈린다. */
export function sentMarkerOf(event: OnRailEvent, stepId?: string | null): string {
  return stepId ? `${event}:${stepId}` : event;
}

/** 손상된 값은 **빈 이력**으로 읽는다 — 최악이 "한 번 더 보낸다"이고 서버가 흡수한다. */
export function readSentMarkers(userId: string | null): string[] {
  if (!userId) return [];
  try {
    const raw = window.localStorage.getItem(SENT_KEY(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function appendSentMarker(sent: readonly string[], marker: string): string[] {
  if (sent.includes(marker)) return [...sent];
  return [...sent, marker].slice(-ONRAIL_SENT_MAX);
}

export function writeSentMarkers(userId: string | null, sent: readonly string[]): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(SENT_KEY(userId), JSON.stringify(sent));
  } catch {
    /* 저장 불가(사파리 프라이빗 등) — 같은 사실을 한 번 더 보낼 뿐, 서버가 흡수한다 */
  }
}

/** 계정 전환·다시 시작 — 그 계정 몫만 지운다(`clearOnRail` 과 같은 규율). */
export function clearSentMarkers(userId: string | null): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(SENT_KEY(userId));
  } catch {
    /* no-op */
  }
}

export interface OnRailReportExtra {
  /** `onrail_step` 전용 — 어느 스텝인가. */
  stepId?: string | null;
  /** `onrail_offer_missed` 전용 — 어느 경로로 우회했나. */
  path?: string | null;
}

/**
 * 사실 하나를 서버에 보고한다. **fire-and-forget** — 던지지 않고, 기다리지 않고, 아무것도 돌려주지
 * 않는다.
 *
 * ⚠️ 표시는 **보내기 전에** 한다(그래야 같은 전이가 두 번 그려져도 두 번 나가지 않는다). 대신
 * 실패하면 표시를 **되돌린다** — 그러면 다음 방문에 다시 시도한다. 되돌리지 않으면 네트워크가
 * 한 번 튄 유저가 그 단계에서 **영영 관측 밖**이 되고, 그건 이 웨이브가 없애려는 상태 그 자체다.
 */
export function reportOnRail(
  userId: string | null,
  event: OnRailEvent,
  extra?: OnRailReportExtra,
): void {
  if (!userId) return;
  const stepId = extra?.stepId ?? null;
  const path = extra?.path ?? null;
  const marker = sentMarkerOf(event, stepId);

  const before = readSentMarkers(userId);
  if (before.includes(marker)) return;
  writeSentMarkers(userId, appendSentMarker(before, marker));

  const body: Record<string, string> = { event };
  if (stepId) body.stepId = stepId;
  if (path) body.path = path;

  void apiFetch("/api/me/onrail-events", { method: "POST", body }).catch(() => {
    // 표시를 되돌린다 — 다음 방문에 다시 시도한다. 이 catch 가 유일한 실패 처리다(화면 신호 0).
    writeSentMarkers(
      userId,
      readSentMarkers(userId).filter((m) => m !== marker),
    );
  });
}
