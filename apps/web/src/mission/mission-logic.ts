/**
 * 원정 데일리 미션 — 순수 판정 (#408, 설계 = `docs/plan-v5/away-daily-mission.md` §8).
 *
 * **이 파일이 하지 않는 일이 계약의 핵심이다**(`league/daily-reward-logic.ts` 와 같은 규율).
 * 티어→금액 · 달성 여부 · 리롤 가능 여부 · "자정에 초기화"의 시각을 **하나도 계산하지 않는다** —
 * 금액은 economy 노브고 카탈로그·리롤 정책은 서버 config 라 언제든 바뀐다. 복제하면 노브를 돌린
 * 순간 화면이 서버가 하지 않는 일을 단언한다(#262·#368 이 같은 실수를 했고 계약이 그걸 잡는다).
 *
 * 여기서 하는 일은 둘뿐이다:
 *  ① **응답 형태를 믿지 않는 정규화** — 구 서버·프록시의 200 `{}` 하나가 원정 화면을 흰 화면으로
 *    만들지 않게(#245·#251·#323 과 같은 규율). 배열이 아니면 빈 배열, 숫자가 아니면 폴백.
 *  ② 서버 enum → 화면 라벨 매핑. **모르는 값은 칠하지 않는다**(추측해서 배지를 그리지 않는다).
 */

/** 서버 enum(SoT). 모르는 값은 배지·라벨을 그리지 않는다. */
export type MissionTier = "EASY" | "NORMAL" | "HARD";
/** 서버 enum(SoT). `COMPLETED` 만이 수령 가능 신호다 — `progress >= target` 이 아니다. */
export type MissionState = "IN_PROGRESS" | "COMPLETED" | "CLAIMED";

export interface DailyMission {
  /** `daily_missions` 행 id — claim·reroll 의 키. 없으면 화면에서 아무것도 할 수 없다. */
  id: string;
  /** 카탈로그 키(분석·디버깅용). **화면 표시 아님** — 표시는 `title` 이다. */
  missionId: string;
  /** 서버가 완성한 문구. 클라가 `missionId` 로 문구를 만들지 않는다(카탈로그가 바뀌면 거짓말한다). */
  title: string;
  tier: string;
  currency: string;
  amount: number;
  progress: number;
  target: number;
  state: string;
  /**
   * ⚠️ **서버 판단이다.** "1회 썼나 / 달성했나"를 클라가 추론해 버튼을 켜면 리롤 정책
   * (`hmb.mission.daily.reroll-per-slot`)이 바뀔 때 조용히 어긋난다(설계 §8).
   */
  rerollable: boolean;
}

export interface DailyMissions {
  day: string;
  /** 화면의 초기화 안내용 — 클라가 "다음 자정"을 계산하지 않는다(기기 시계가 진실이 되면 안 된다). */
  resetAtKst: string;
  missions: DailyMission[];
}

/** 결과 화면에 실리는 미션 한 줄(§8 additive). 상태·리롤이 없다 — 여기선 **보여주기만** 한다. */
export interface MatchMission {
  id: string;
  missionId: string;
  title: string;
  tier: string;
  currency: string;
  amount: number;
  progress: number;
  target: number;
  /** **이 경기로** 달성됐다(이전에 이미 달성돼 있던 것과 구분). */
  completedNow: boolean;
}

const TIER_LABELS: Record<string, string> = { EASY: "쉬움", NORMAL: "보통", HARD: "어려움" };
const STATE_LABELS: Record<string, string> = {
  IN_PROGRESS: "진행 중",
  COMPLETED: "달성",
  CLAIMED: "수령 완료",
};
/** 색 단일 채널 금지(#262 적록색약 규율) — 글리프는 텍스트 라벨의 **보조**다. */
const STATE_GLYPHS: Record<string, string> = { IN_PROGRESS: "▷", COMPLETED: "★", CLAIMED: "✓" };

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return Number.isFinite(v) ? (v as number) : fallback;
}

/**
 * 응답에서 오늘의 미션 블록을 꺼낸다. **없거나 비어 있으면 null** — 호출부는 그때 섹션을
 * 통째로 안 그린다(#286 W5 규율: 스켈레톤·에러를 띄우면 "아직 없는 기능"이 "고장 난 화면"이 된다).
 *
 * ⚠️ `missions: []` 도 null 이다. 롤백 스위치(`hmb.mission.daily.count: 0`)가 켜지면 서버가 그
 * 상태를 준다(설계 §9) — 빈 껍데기를 띄우면 "미션이 사라졌다"로 읽힌다.
 */
export function pickDailyMissions(raw: unknown): DailyMissions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.missions)) return null;
  const missions = o.missions
    .map(normalizeMission)
    .filter((m): m is DailyMission => m !== null);
  if (missions.length === 0) return null;
  return { day: str(o.day), resetAtKst: str(o.resetAtKst), missions };
}

function normalizeMission(raw: unknown): DailyMission | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  // id 가 없으면 수령·리롤의 키가 없다 = 그릴 수는 있어도 아무것도 할 수 없는 카드다.
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    missionId: str(o.missionId),
    title: str(o.title),
    tier: str(o.tier),
    currency: str(o.currency),
    amount: num(o.amount),
    progress: num(o.progress),
    target: num(o.target),
    state: str(o.state),
    rerollable: o.rerollable === true,
  };
}

/** 결과 화면 `missions` 배열. 배열이 아니면 빈 배열 — 결과 화면이 죽으면 안 된다. */
export function normalizeMatchMissions(raw: unknown): MatchMission[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const m = normalizeMission(entry);
      if (!m) return null;
      const o = entry as Record<string, unknown>;
      return {
        id: m.id,
        missionId: m.missionId,
        title: m.title,
        tier: m.tier,
        currency: m.currency,
        amount: m.amount,
        progress: m.progress,
        target: m.target,
        completedNow: o.completedNow === true,
      };
    })
    .filter((m): m is MatchMission => m !== null);
}

/**
 * 홈 "받을 보상 N건" 한 줄이 읽는 값 (§8).
 *
 * ⚠️ **오늘 것만이 아니다** — 달성분은 기한 없이 남으므로 서버가 지난 날짜 미수령분까지 합산해서
 * 준다. 그래서 `missions` 배열을 세어 만들면 안 된다(어제 못 받은 것이 화면에서 사라진다).
 */
export function claimableSummary(raw: unknown): { count: number; amount: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { count: 0, amount: 0 };
  const o = raw as Record<string, unknown>;
  return { count: num(o.claimableCount), amount: num(o.claimableAmount) };
}

/** 티어 배지 문구. 모르는 값은 **null**(배지를 그리지 않는다). */
export function missionTierLabel(tier: string): string | null {
  return TIER_LABELS[tier] ?? null;
}

/** 상태 문구. 모르는 값은 null. */
export function missionStateLabel(state: string): string | null {
  return STATE_LABELS[state] ?? null;
}

export function missionStateGlyph(state: string): string | null {
  return STATE_GLYPHS[state] ?? null;
}

/**
 * 지금 [받기]를 누를 수 있나.
 *
 * ⚠️ **`progress >= target` 으로 다시 계산하지 마라.** 달성 판정은 서버가 경기 정산에서 하고
 * (`completed_at`), 진행도는 달성 후 얼어붙는다 — 두 값이 갈라지는 상태가 실재하고, 그때
 * 클라 계산은 "달성했다"고 말하면서 서버는 409 `MISSION_NOT_COMPLETED` 를 준다.
 */
export function missionClaimable(m: DailyMission): boolean {
  return m.state === "COMPLETED";
}

/** [받기] 버튼 문구. 이미 받은 것은 그렇게 말한다(우편함 선례). */
export function missionClaimLabel(m: DailyMission): string {
  return m.state === "CLAIMED" ? "수령 완료" : "받기";
}

/**
 * [다시 뽑기]가 잠긴 **이유**. 잠긴 버튼만 두면 유저는 이유를 못 찾는다(복수 큐 선례).
 *
 * ⚠️ 문을 여는 판정은 **서버의 `rerollable` 하나**다. 여기서 하는 일은 이미 잠긴 버튼에 말을
 * 붙이는 것뿐이고, 그 문구를 고르는 데만 서버가 준 `state` 를 읽는다(재계산이 아니다).
 */
export function rerollBlockReason(m: DailyMission): string | null {
  if (m.rerollable) return null;
  if (m.state === "COMPLETED" || m.state === "CLAIMED") {
    return "달성한 미션은 다시 뽑을 수 없습니다";
  }
  return "다시 뽑기를 이미 썼습니다";
}

/** 진행 막대 폭(0~1). **표시 전용** — 목표가 0이거나 넘쳐도 화면이 깨지지 않게 자른다. */
export function progressRatio(m: { progress: number; target: number }): number {
  if (!(m.target > 0)) return 0;
  return Math.max(0, Math.min(1, m.progress / m.target));
}

/**
 * "언제 초기화되나" 안내 문구.
 *
 * ⚠️ **서버가 준 `resetAtKst` 의 벽시계를 그대로 읽는다.** `new Date(...)` 로 파싱하면 브라우저
 * 타임존으로 환산돼 KST 밖 기기에서 "00:00"이 다른 시각으로 뜬다 — 그 값은 서버가 KST 오프셋을
 * 박아서 보낸 것이라 환산 대상이 아니다. 못 읽으면 **null**(문구를 지어내지 않는다).
 */
export function resetNoticeText(resetAtKst: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(resetAtKst);
  if (!m) return null;
  return `${Number(m[2])}월 ${Number(m[3])}일 ${m[4]}:${m[5]} 초기화`;
}
