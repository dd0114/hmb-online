import type { ReactNode } from "react";
import type { PendingChoice } from "../api/growth";
import { MissionRewardSection } from "../mission/MissionRewardSection";
import { missionClaimable, normalizeMatchMissions } from "../mission/mission-logic";
import { CurrencySection } from "./sections/CurrencySection";
import { GrowthSection } from "./sections/GrowthSection";
import {
  SECTION_CURRENCY,
  SECTION_GROWTH,
  SECTION_MISSION,
  currencyEntriesOf,
  growthEntriesOf,
  type RewardBundle,
} from "./types";
import { createElement } from "react";

/**
 * **보상 섹션 레지스트리** (#405 §2.9.1). hero 요구 2 = *"앞으로 모든 보상이 이 탭 구조를 쓴다"* —
 * 이 배열이 그 "모든"의 목록이다.
 *
 * 소유 경계: **셸은 #405, 섹션 내부는 각 기능.** 다른 에픽은 자기 섹션 컴포넌트 파일과 그 하위를
 * 갖고, 이 배열의 **등록 한 줄만 #405 가 넣는다**(머지 순서 충돌 최소화).
 * ⚠️ **레지스트리는 파일 위치를 강제하지 않는다.** `render` 가 노드를 돌려주므로 컴포넌트가 어디
 * 있든 상관없다 — 실제로 미션 섹션은 `mission/MissionRewardSection.tsx` 에 있고(#408 소유),
 * `rewards/sections/` 아래로 옮기지 않았다. 한때 이 자리에 *"예: `rewards/sections/
 * MissionRewardSection.tsx`"* 라고 적혀 있었는데 그런 경로는 **존재한 적이 없다** — 위치를 옮기는
 * 것은 남의 에픽 파일을 움직이는 일이고, 얻는 것이 없다.
 *
 * ⚠️ **`isPresent` 가 거짓이면 탭 자체를 안 그린다.** 목업 화면 ①에는 비활성 `[미션 준비중]`
 * 자리가 있었지만 **그리지 않는다**: (a) 눌러도 아무 데도 안 가는 손잡이를 남기지 않는다는 게 이
 * 리포의 기존 규율이고(`briefTabVisible`·#254 `hideTeamTune` 과 같은 규칙), (b) "준비중"은
 * 레지스트리에 항목이 없다는 뜻인데 그 자리를 그리려면 **없는 섹션의 이름을 셸에 하드코딩**해야
 * 해서 §2.9.1 의 경계를 셸 쪽에서 먼저 깬다. 섹션이 등록되는 순간 탭이 저절로 생긴다.
 *
 * ── 🚨 **claim ≠ ack — 그 차이는 셸이 다룬다** ────────────────────────────────────────────
 * 봉투에 실리는 보상의 성질이 **하나가 아니다**:
 *  · 매치 재화·성장 = **자동 지급**. `[확인]`(ack)은 *"봤다"* 라는 뜻뿐이다.
 *  · 미션(#408) = **`[받기]` 를 눌러야 지급**된다. 안 누르고 `[확인]` 하면 아무것도 안 들어온다.
 *
 * 그냥 같은 탭에 넣으면 유저는 *"확인 눌렀으니 다 받았겠지"* 하고 미수령분을 지나친다 — 그건
 * 화면 오해가 아니라 **실제 손실**이다. 그래서 섹션이 `unclaimed` 로 "아직 유저가 해야 할 건수"를
 * 신고하고, **셸(`RewardSheet.confirm`)이 그 합이 0 이 아니면 `[확인]` 을 그냥 통과시키지 않는다**.
 * ⚠️ 셸은 그 건수가 **무엇인지 모른다**(미션이라는 단어가 셸에 없다) — 판정은 여기, 집행은 셸.
 * 새 섹션이 "눌러야 지급"이면 `unclaimed` 를 반드시 달아라. 안 달면 조용히 지나가는 쪽으로 떨어진다.
 */
export type RewardSectionDef = {
  kind: string;
  /** 탭/섹션 정렬 — 화면마다 순서가 달라지면 근육기억이 깨진다. */
  order: number;
  title: string;
  /**
   * 없으면 섹션(=탭) 자체를 안 그린다.
   *
   * ⚠️ **섹션 컴포넌트가 스스로 `null` 을 돌려주는 조건과 반드시 같은 판정이어야 한다.** 두 곳이
   * 갈리면 탭은 생기는데 내용이 비는 **빈 탭**이 뜬다(그래서 미션은 양쪽 다 `normalizeMatchMissions`
   * 한 함수를 통과한다).
   */
  isPresent: (bundle: RewardBundle, result?: unknown) => boolean;
  /**
   * **유저가 아직 받지 않은 건수** — 0 이 아니면 셸이 `[확인]` 앞에 확인 단계를 하나 더 둔다.
   * 자동 지급 섹션은 이 필드를 두지 않는다(받을 것이 없으니 막을 것도 없다).
   */
  unclaimed?: (bundle: RewardBundle, result?: unknown) => number;
  /**
   * 지금 안 받으면 **어디서** 받나. 경고가 막다른 길이 되지 않게 셸이 이 한 줄을 같이 띄운다 —
   * 이 문장이 없으면 유저는 "받지 않은 게 있다"는 사실만 알고 갈 곳을 모른다.
   */
  unclaimedHint?: string;
  render: (ctx: RewardSectionContext) => ReactNode;
};

/**
 * 섹션 렌더 컨텍스트.
 *
 * `matchId` 는 §2.9.1 계약 그대로 옵셔널(매치 밖 봉투 = 미션·우편에는 없다). 성장 섹션만 쓰는
 * 두 값(열린 선택권·선택 진입)은 **셸이 주입**한다 — 섹션이 직접 조회하면 탭을 열 때마다 왕복이
 * 생기고, 탭 두 개가 서로 다른 시점의 목록을 들고 있게 된다.
 */
export interface RewardSectionContext {
  bundle: RewardBundle;
  matchId?: string;
  /**
   * 봉투가 실려 온 **응답 전체**(`GET /api/matches/{id}/result`).
   *
   * ⚠️ 봉투 밖 자료를 읽는 섹션이 있어서 필요하다 — 미션은 `sections[]` 가 아니라 응답의 additive
   * `missions` 블록으로 온다(설계 §8, #368 선례). 셸에 `missions` prop 을 다는 대신 **응답을 통째로**
   * 넘기는 쪽을 골랐다: (a) 셸이 특정 기능의 필드 이름을 알게 되면 §2.9.1 경계가 셸에서 깨지고,
   * (b) 다음 섹션이 또 다른 additive 블록을 쓸 때마다 셸의 prop 이 하나씩 늘어난다. 지금은 셸이
   * 모르는 채로 넘기고, **어느 블록을 읽을지는 각 섹션의 등록 줄이 정한다**.
   */
  result?: unknown;
  /** 아직 안 고른 선택권 id(미도착이면 undefined → 봉투 스냅샷을 그대로 센다). */
  openChoiceIds?: ReadonlySet<string> | undefined;
  onPickChoice?: ((choice: PendingChoice) => void) | undefined;
}

/**
 * 결과 응답의 additive 미션 블록(#408 §8). `ResultPanel` 이 직접 삽입하던 시절과 **같은 자리**를
 * 읽는다 — 자료가 옮겨간 게 아니라 그리는 곳이 옮겨간 것이다.
 */
function missionsOf(result: unknown): unknown {
  return (result as { missions?: unknown } | null | undefined)?.missions;
}

export const REWARD_SECTIONS: RewardSectionDef[] = [
  {
    kind: SECTION_CURRENCY,
    order: 10,
    title: "재화",
    isPresent: (bundle) => currencyEntriesOf(bundle).length > 0,
    render: ({ bundle }) => createElement(CurrencySection, { entries: currencyEntriesOf(bundle) }),
  },
  {
    kind: SECTION_GROWTH,
    order: 20,
    title: "성장",
    isPresent: (bundle) => growthEntriesOf(bundle).length > 0,
    render: ({ bundle, openChoiceIds, onPickChoice }) =>
      createElement(GrowthSection, {
        entries: growthEntriesOf(bundle),
        openChoiceIds,
        onPick: onPickChoice,
      }),
  },
  {
    kind: SECTION_MISSION,
    order: 30,
    title: "미션",
    /*
     * ⚠️ **`MissionRewardSection` 이 스스로 null 을 돌려주는 조건과 같은 판정이다** — 둘 다
     * `normalizeMatchMissions` 한 함수를 통과한다. 여기서 `Array.isArray(missions)` 같은 걸로
     * 따로 재면 원정이 아닌 경기·구 서버·손상 응답에서 **탭은 생기는데 안이 빈** 상태가 난다.
     */
    isPresent: (_bundle, result) => normalizeMatchMissions(missionsOf(result)).length > 0,
    /*
     * 🚨 미션은 **`[받기]` 를 눌러야 지급된다** — ack 가 대신해 주지 않는다. 판정은 `missionClaimable`
     * (= 서버 `state === "COMPLETED"`) 하나로, 결과 화면·원정 화면과 **같은 함수**다. `progress >=
     * target` 으로 다시 세지 마라(수령한 뒤에도 셀 수가 남아 경고가 영원히 뜬다).
     */
    unclaimed: (_bundle, result) =>
      normalizeMatchMissions(missionsOf(result)).filter(missionClaimable).length,
    // 놓쳐도 사라지지 않는다는 사실이 핵심이다 — 달성분은 기한 없이 남는다(#408 설계 §6.3).
    unclaimedHint: "원정 화면에서 기한 없이 받을 수 있습니다",
    render: ({ result }) => createElement(MissionRewardSection, { missions: missionsOf(result) }),
  },
];

/**
 * 이 봉투에 실제로 실린 섹션만, 정렬해서. 셸은 이 결과의 길이로 탭바를 그릴지 정한다.
 *
 * `result` 는 옵셔널이다 — 봉투만으로 판정되는 섹션(재화·성장)은 없어도 정확하고, 봉투 밖 자료를
 * 읽는 섹션(미션)은 없으면 **없는 쪽**으로 떨어진다(fail-closed: 빈 탭보다 탭 없음이 낫다).
 */
export function presentSections(
  bundle: RewardBundle | null | undefined,
  result?: unknown,
): RewardSectionDef[] {
  if (!bundle) return [];
  return REWARD_SECTIONS.filter((s) => s.isPresent(bundle, result)).sort((a, b) => a.order - b.order);
}

/**
 * 지금 이 봉투에서 **유저가 아직 받지 않은** 것들. 셸이 `[확인]` 을 그냥 통과시킬지 정하는 근거다.
 *
 * ⚠️ 그려지는 섹션만 센다(`presentSections` 결과 위에서 돈다) — 화면에 없는 것 때문에 `[확인]` 이
 * 막히면 유저는 무엇을 하라는 건지 알 방법이 없다(막다른 길).
 */
export function unclaimedIn(
  sections: RewardSectionDef[],
  bundle: RewardBundle,
  result?: unknown,
): { section: RewardSectionDef; count: number }[] {
  return sections
    .map((section) => ({ section, count: section.unclaimed?.(bundle, result) ?? 0 }))
    .filter((x) => x.count > 0);
}
