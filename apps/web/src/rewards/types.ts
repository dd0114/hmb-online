/**
 * **보상 봉투**(RewardBundle) — 공용 계약 (#405 §2.9, server `RewardBundleService`).
 *
 * hero 요구: *"앞으로 모든 보상이 이 탭 구조를 쓴다."* 그래서 매치 전용 응답이 아니라 봉투 하나가
 * `source` 만 바꿔 매치·미션(#408)·리그·우편에 재사용된다. 이 파일은 그 **모양과 순수 판정**만
 * 갖는다 — 화면은 `RewardSheet` 과 `sections/**`, 등록은 `registry.ts`.
 *
 * ⚠️ **서버는 `sections[].entries` 를 느슨한 맵 배열로 내린다**(`List<Map<String,Object>>`). 그래서
 * 여기서 `Array.isArray` 로 한 번 걸러 준다 — 구 서버·목이 `{}` 나 null 을 줘도 결과 화면이 통째로
 * 흰 화면이 되면 안 된다(#274 부류, `growth-mock` G4 가 실제로 그 형태를 잡았다).
 */
import type { MatchGrowthEntry, PendingChoice } from "../api/growth";

export type RewardSource = "MATCH" | "MISSION" | "LEAGUE" | "MAIL";

/** 재화 한 줄 — **코드와 수량만**. 이름·심볼·아이콘은 `<Amount>` 가 서버 표기 메타로 그린다(#232). */
export interface RewardCurrencyEntry {
  code: string;
  amount: number;
}

/**
 * 성장 한 줄 = `GET /api/growth/report` 의 엔트리와 **같은 자료**(서버가 한 함수로 만든다).
 * 타입을 따로 만들지 마라 — 갈라지는 순간 결과 화면과 보상 시트가 같은 경기를 다르게 말한다.
 */
export type RewardGrowthEntry = MatchGrowthEntry;

export interface RewardSection {
  kind: string;
  entries: unknown[];
}

export interface RewardBundle {
  bundleId: string;
  source: RewardSource | string;
  sourceRef: string;
  /** null = 아직 확인 전 = **보상 시트를 먼저 띄운다**. ISO 문자열이면 이미 본 봉투다. */
  acknowledgedAt: string | null;
  sections: RewardSection[];
}

/**
 * `GET /api/matches/{id}/result` 의 **additive** 블록에서 봉투를 꺼낸다(#368 선례).
 *
 * ⚠️ **W2b 이전에 끝난 매치는 `rewardBundle: null` 이다** — 봉투가 없던 시절의 정산이라 서버가
 * 만들 자료가 없다. 그 매치를 다시 열어도 예전처럼 곧장 결과 화면이어야 한다(회귀 금지).
 * openapi 생성 타입에는 아직 없는 필드라 여기서 한 번만 캐스팅하고, 화면은 이 함수만 부른다.
 */
export function rewardBundleOf(result: unknown): RewardBundle | null {
  const raw = (result as { rewardBundle?: unknown } | null | undefined)?.rewardBundle;
  if (!raw || typeof raw !== "object") return null;
  const bundle = raw as RewardBundle;
  return typeof bundle.bundleId === "string" && bundle.bundleId.length > 0 ? bundle : null;
}

export const SECTION_CURRENCY = "CURRENCY";
export const SECTION_GROWTH = "GROWTH";

/** 이 봉투의 섹션 목록(모양이 아니면 빈 배열). */
export function sectionsOf(bundle: RewardBundle | null | undefined): RewardSection[] {
  const s = bundle?.sections;
  return Array.isArray(s) ? s.filter((x) => Boolean(x) && typeof x === "object") : [];
}

/** `kind` 섹션의 엔트리. 없거나 모양이 아니면 빈 배열 — 호출부가 길이만 보고 판단할 수 있게. */
export function entriesOf<T>(bundle: RewardBundle | null | undefined, kind: string): T[] {
  const section = sectionsOf(bundle).find((s) => s.kind === kind);
  return Array.isArray(section?.entries) ? (section!.entries as T[]) : [];
}

export const currencyEntriesOf = (bundle: RewardBundle | null | undefined): RewardCurrencyEntry[] =>
  entriesOf<RewardCurrencyEntry>(bundle, SECTION_CURRENCY).filter(
    (e) => typeof e?.code === "string" && Number.isFinite(e?.amount),
  );

export const growthEntriesOf = (bundle: RewardBundle | null | undefined): RewardGrowthEntry[] =>
  entriesOf<RewardGrowthEntry>(bundle, SECTION_GROWTH).filter((e) => typeof e?.playerId === "string");

/**
 * 봉투가 기록한 선택권 전부(**정산 시점 스냅샷**).
 *
 * ⚠️ 이건 "지금 남은 것"이 아니다 — 유저가 고른 뒤에도 봉투에는 그대로 남는다. 화면이 세는
 * **대기 수**는 `GET /api/growth/choices`(usePendingChoices)와 교차해서 구한다(`openChoicesOf`).
 */
export function bundleChoicesOf(bundle: RewardBundle | null | undefined): PendingChoice[] {
  const out: PendingChoice[] = [];
  for (const e of growthEntriesOf(bundle)) {
    if (Array.isArray(e.pendingChoices)) out.push(...e.pendingChoices);
  }
  return out;
}

/**
 * 이 봉투가 만든 선택권 중 **아직 안 고른 것**.
 *
 * `open` 을 아직 못 받았으면(로딩·조회 실패) 봉투의 스냅샷을 그대로 쓴다 — 경기 직후에는 둘이
 * 같고, 뱃지가 잠깐 사라졌다 나타나는 것보다 낫다. 도착하면 그 순간 정확해진다.
 */
export function openChoicesOf(
  choices: PendingChoice[],
  open: PendingChoice[] | undefined,
): PendingChoice[] {
  if (!open) return choices;
  const ids = new Set(open.map((c) => c.choiceId));
  return choices.filter((c) => ids.has(c.choiceId));
}

/**
 * 결과 화면보다 **먼저** 보상 시트를 띄워야 하나.
 *
 * ⚠️ 두 부정 조건이 다 필요하다: 봉투가 없으면(W2b 이전 매치 = `rewardBundle: null`) 예전처럼
 * 곧장 결과 화면이고, 이미 확인했으면 다시 띄우지 않는다. 하나만 보면 구 매치를 다시 볼 때마다
 * 빈 오버레이가 뜨거나 매번 [확인]을 또 눌러야 한다.
 */
export function shouldShowRewardSheet(bundle: RewardBundle | null | undefined): boolean {
  return Boolean(bundle?.bundleId) && !bundle?.acknowledgedAt;
}
