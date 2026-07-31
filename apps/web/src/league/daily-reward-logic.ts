/**
 * 오늘의 보상 트랙 — 순수 판정 (#368).
 *
 * **이 파일이 하지 않는 일이 계약의 핵심이다.** 칸 수·대량 위치·금액·재화·다음 칸은 전부
 * 서버가 준 값을 그대로 쓴다 — 하나도 계산하지 않는다. 전부 economy 노브라 언제든 바뀌고,
 * 복제하면 "9번째가 대박"이라 칠해 놓고 실제로는 아무 일도 안 일어나는 화면이 된다
 * (#262 가 승급/강등 컷에서 같은 실수를 했고 계약이 그걸 잡는다).
 *
 * 여기서 하는 일은 둘뿐이다: ① **응답 형태를 믿지 않는 정규화**(구 서버·프록시의 `{}` 하나가
 * 리그 화면을 흰 화면으로 만들지 않게 — #245·#323 과 같은 규율) ② 화면 상태 이름 매핑.
 */
import type { DailyRewardSlot, DailyRewardTrack, LeagueResponseP3 } from "../api/p3";

/** 서버 enum(SoT). 모르는 값은 화면에서 **빈 칸**으로 떨어뜨린다(추측해서 칠하지 않는다). */
export type SlotState = "WON" | "MISSED" | "PENDING";

const KNOWN_STATES: ReadonlySet<string> = new Set<string>(["WON", "MISSED", "PENDING"]);

/**
 * 응답에서 트랙을 꺼낸다. **없으면 null** — 호출부는 그때 트랙 구역을 통째로 안 그린다.
 * 스켈레톤·에러를 띄우면 "아직 없는 기능"이 "고장 난 화면"으로 읽힌다(#286 W5 규율).
 */
export function pickDailyReward(res: LeagueResponseP3 | null | undefined): DailyRewardTrack | null {
  const raw = res?.dailyReward;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const slots = normalizeSlots(raw.slots);
  // 칸이 하나도 없으면 그릴 트랙이 없다 — 빈 껍데기를 띄우면 "보상이 사라졌다"로 읽힌다.
  if (slots.length === 0) return null;
  return {
    day: typeof raw.day === "string" ? raw.day : "",
    slotsPerDay: intOr(raw.slotsPerDay, slots.length),
    consumed: intOr(raw.consumed, 0),
    awardedCount: intOr(raw.awardedCount, 0),
    earned: intOr(raw.earned, 0),
    currency: typeof raw.currency === "string" ? raw.currency : (slots[0]?.currency ?? ""),
    slots,
    next: normalizeSlot(raw.next),
  };
}

function normalizeSlots(raw: unknown): DailyRewardSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeSlot).filter((s): s is DailyRewardSlot => s !== null);
}

function normalizeSlot(raw: unknown): DailyRewardSlot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Partial<DailyRewardSlot>;
  if (!Number.isFinite(o.slotNo)) return null;
  return {
    slotNo: o.slotNo as number,
    currency: typeof o.currency === "string" ? o.currency : "",
    amount: Number.isFinite(o.amount) ? (o.amount as number) : 0,
    // ⚠️ `big` 은 서버가 준 사실이다. `slotNo % 9 === 0` 같은 걸 여기 적으면 config 를 돌리는
    // 순간 화면이 서버가 하지 않는 일을 단언한다.
    big: o.big === true,
    state: typeof o.state === "string" ? o.state : "",
    opponentName: typeof o.opponentName === "string" && o.opponentName ? o.opponentName : null,
  };
}

function intOr(v: unknown, fallback: number): number {
  return Number.isFinite(v) ? (v as number) : fallback;
}

/** 화면 상태 — 모르는 값은 `PENDING` 이 아니라 `null`(칠하지 않는다). */
export function slotState(slot: DailyRewardSlot | null | undefined): SlotState | null {
  if (!slot || !KNOWN_STATES.has(slot.state)) return null;
  return slot.state as SlotState;
}

/** 이 칸이 "다음 칸"인가 — 판정은 서버의 `next.slotNo` 하나로만 한다(consumed+1 을 세지 않는다). */
export function isNextSlot(track: DailyRewardTrack, slot: DailyRewardSlot): boolean {
  return track.next != null && track.next.slotNo === slot.slotNo;
}

/**
 * 트랙 진행 문구용 값. `consumed` 는 트랙 상한을 넘을 수 있으므로(19번째 판) **표시는 상한으로 자른다** —
 * "19 / 18" 은 화면에서 틀린 말이다. 자르는 것은 표기이고, `exhausted` 판정은 서버의 `next` 부재다.
 */
export function trackProgress(track: DailyRewardTrack): {
  used: number;
  total: number;
  exhausted: boolean;
} {
  const total = track.slotsPerDay;
  return {
    used: Math.min(track.consumed, total),
    total,
    exhausted: track.next == null,
  };
}

/**
 * 팀 마크(생성 크레스트)용 결정론 시드 — **리포에 클럽 엠블럼 아트가 0개**라 이름에서 그림을 만든다.
 * 같은 팀은 항상 같은 색·같은 이니셜이다. 실아트가 발행되면 이 자리에 그대로 들어간다.
 */
export function crestSeed(name: string | null | undefined): number {
  let h = 0;
  for (const ch of name ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** 크레스트 이니셜 — 두 단어면 앞 글자 둘, 한 단어면 앞 두 글자. 비면 `?`. */
export function crestInitials(name: string | null | undefined): string {
  const words = (name ?? "").replace(/[^A-Za-z가-힣0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const head = words[0];
  if (!head) return "?";
  const second = words[1]?.[0] ?? head[1] ?? "";
  return ((head[0] ?? "") + second).toUpperCase();
}
