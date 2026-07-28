import type { Page } from "@playwright/test";

/**
 * `GET /api/config` 목 (#232) — 재화 표기 + 상점 가격.
 *
 * 목 기반 스펙들이 이걸 안 실으면 캐치올 `{}` 가 나가고, 클라는 **가격을 모르는 상태**가 된다
 * (뽑기·다이스 버튼이 잠기고 금액이 코드 폴백으로 뜬다) — 그건 버그가 아니라 설계된 폴백이므로
 * 목이 서버 형상을 지켜 줘야 스펙이 실제 화면을 본다.
 *
 * 기본값은 **운영 발행물과 같은 모양**(뽑기=유상재화, 노말 다이스=무료재화 5,000, 충전 비활성)이다.
 * 표기가 데이터를 따라오는지 보는 스펙은 `symbols` 를 바꿔 쓴다.
 */
export interface ConfigMockOptions {
  pointSymbol?: string;
  pointName?: string;
  gemSymbol?: string;
  gemName?: string;
  /** 충전 탭/섹션 노출 — 서버 `gems.topupEnabled` 에 대응. */
  topupEnabled?: boolean;
  gachaCurrency?: "POINT" | "GEM";
  gachaSingleCost?: number;
  gachaTenCost?: number;
  diceNormalCost?: number;
  diceCashCost?: number;
  initialPoints?: number;
  initialGems?: number;
}

export function appConfigPayload(opts: ConfigMockOptions = {}) {
  const {
    pointSymbol = "G",
    pointName = "골드",
    gemSymbol = "Z",
    gemName = "다이아",
    topupEnabled = false,
    gachaCurrency = "GEM",
    gachaSingleCost = 300,
    gachaTenCost = 3000,
    diceNormalCost = 5000,
    diceCashCost = 10,
    initialPoints = 3000,
    initialGems = 6000,
  } = opts;
  return {
    currencies: [
      {
        code: "POINT",
        symbol: pointSymbol,
        name: pointName,
        icon: "●",
        position: "suffix",
        separator: " ",
      },
      {
        code: "GEM",
        symbol: gemSymbol,
        name: gemName,
        // 서버 기본값과 **같은** 아이콘을 쓴다 — 목만 다른 아이콘을 쓰면 계약이 실제 배포 화면을
        // 검사하지 않게 된다(💎 가 상징하는 재화는 이제 "다이아"이고, 심볼 Z 와 함께 나간다).
        icon: "💎",
        position: "suffix",
        separator: " ",
      },
    ],
    shop: {
      gacha: {
        single: { currency: gachaCurrency, cost: gachaSingleCost },
        ten: { currency: gachaCurrency, cost: gachaTenCost },
        tenCount: 11,
      },
      dice: {
        normal: { currency: "POINT", cost: diceNormalCost },
        cash: { currency: "GEM", cost: diceCashCost },
      },
      gemTopup: {
        enabled: topupEnabled,
        packs: [
          { id: "p1", gems: 60, mockPrice: "₩1,200" },
          { id: "p2", gems: 330, mockPrice: "₩5,900" },
          { id: "p3", gems: 720, mockPrice: "₩11,900" },
        ],
      },
    },
    grants: { initialPoints, initialGems },
  };
}

/** 라우트 등록 — 캐치올 뒤에 부른다(Playwright 는 나중에 등록한 핸들러가 이긴다). */
export async function mockAppConfig(page: Page, opts: ConfigMockOptions = {}) {
  await page.route(
    (url) => url.pathname === "/api/config",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(appConfigPayload(opts)),
      }),
  );
}
