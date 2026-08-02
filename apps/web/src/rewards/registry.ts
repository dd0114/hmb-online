import type { ReactNode } from "react";
import type { PendingChoice } from "../api/growth";
import { CurrencySection } from "./sections/CurrencySection";
import { GrowthSection } from "./sections/GrowthSection";
import {
  SECTION_CURRENCY,
  SECTION_GROWTH,
  currencyEntriesOf,
  growthEntriesOf,
  type RewardBundle,
} from "./types";
import { createElement } from "react";

/**
 * **보상 섹션 레지스트리** (#405 §2.9.1 — #408 과 합의된 파일 경계).
 *
 * 소유 경계: **셸은 #405, 섹션 내부는 각 기능.** 다른 에픽은 자기 섹션 컴포넌트 파일 하나
 * (예: `rewards/sections/MissionRewardSection.tsx`)와 그 하위만 갖고, 이 배열에 **등록 한 줄은
 * #405 가 넣는다**(머지 순서 충돌 최소화).
 *
 * ⚠️ **`isPresent` 가 거짓이면 탭 자체를 안 그린다.** 목업 화면 ①에는 비활성 `[미션 준비중]`
 * 자리가 있었지만 **그리지 않는다**: (a) 눌러도 아무 데도 안 가는 손잡이를 남기지 않는다는 게 이
 * 리포의 기존 규율이고(`briefTabVisible`·#254 `hideTeamTune` 과 같은 규칙), (b) "준비중"은
 * 레지스트리에 항목이 없다는 뜻인데 그 자리를 그리려면 **없는 섹션의 이름을 셸에 하드코딩**해야
 * 해서 §2.9.1 의 경계를 셸 쪽에서 먼저 깬다. #408 이 섹션을 등록하는 순간 탭이 저절로 생긴다 —
 * 그게 이 구조가 약속하는 것이고, 빈 자리를 미리 그려 둘 이유가 없다.
 */
export type RewardSectionDef = {
  kind: string;
  /** 탭/섹션 정렬 — 화면마다 순서가 달라지면 근육기억이 깨진다. */
  order: number;
  title: string;
  /** 없으면 섹션(=탭) 자체를 안 그린다. */
  isPresent: (bundle: RewardBundle) => boolean;
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
  /** 아직 안 고른 선택권 id(미도착이면 undefined → 봉투 스냅샷을 그대로 센다). */
  openChoiceIds?: ReadonlySet<string> | undefined;
  onPickChoice?: ((choice: PendingChoice) => void) | undefined;
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
];

/** 이 봉투에 실제로 실린 섹션만, 정렬해서. 셸은 이 결과의 길이로 탭바를 그릴지 정한다. */
export function presentSections(bundle: RewardBundle | null | undefined): RewardSectionDef[] {
  if (!bundle) return [];
  return REWARD_SECTIONS.filter((s) => s.isPresent(bundle)).sort((a, b) => a.order - b.order);
}
