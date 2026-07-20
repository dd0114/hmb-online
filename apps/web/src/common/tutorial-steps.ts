/**
 * 온보딩 튜토리얼 스텝 정의 (PRD-v4 §B, P3-D6) — **순수 데이터**.
 *
 * 코치마크는 `targetTestId` 로 대상 요소를 지목한다(DOM 구조·클래스에 의존하지 않는다).
 * 대상이 없거나 화면 밖이면 그 스텝은 **건너뛴다**(TutorialOverlay). 따라서 여기에
 * 아직 없는 화면의 스텝을 넣어도 깨지지 않는다 — 다만 `enabled:false` 인 스텝은
 * 아예 실행 목록에서 빠진다(정의만 남기는 stub).
 */
export interface TutorialStep {
  /** 안정 식별자(테스트/저장용). */
  id: string;
  /** 하이라이트 대상 요소의 data-testid. */
  targetTestId: string;
  title: string;
  body: string;
  /** false = 실행 목록에서 제외(미완 기능 stub). */
  enabled: boolean;
}

/**
 * 기본 스텝 — 전부 **로비 화면에 존재하는 요소**를 대상으로 한다(간단 수준 허용, P3-D6).
 * 라우트를 강제로 옮기지 않으므로 "탭 이동 중 튜토리얼이 길을 잃는" 상태가 없다.
 */
export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "play",
    targetTestId: "play-cta",
    title: "여기서 경기를 시작합니다",
    body: "‘게임 시작’을 누르면 연습 경기와 리그 중에서 고를 수 있어요. 연습 경기는 봇과의 단판입니다.",
    enabled: true,
  },
  {
    // TODO(#106): 덱 재설계 머지 후 **덱 화면 안의 실제 요소** testid 로 바꾸고 enabled:true.
    // 지금 대상은 로비의 '덱 구성' 버튼(실재하는 요소)이라 켜기만 해도 깨지지 않는다.
    // src/deck/** 는 #106 세션 소유라 이 웨이브에서 건드리지 않는다.
    id: "deck",
    targetTestId: "lobby-deck",
    title: "덱을 구성하세요",
    body: "선발 11명과 벤치, 선수별 프롬프트를 여기서 설정합니다.",
    enabled: false,
  },
  {
    id: "shop",
    targetTestId: "lobby-shop",
    title: "상점에서 선수를 모읍니다",
    body: "포인트로 뽑기를 돌려 카드를 얻습니다. 포인트가 모자라면 충전 탭을 확인하세요.",
    enabled: true,
  },
  {
    id: "codex",
    targetTestId: "lobby-codex",
    title: "도감에서 보유 선수를 확인",
    body: "등급·포지션별로 모은 선수를 모아 봅니다. 아직 못 얻은 선수도 여기서 확인할 수 있어요.",
    enabled: true,
  },
  {
    // 리그 진입점은 ‘게임 시작’ 모달 안(mode-league)이라 로비에서는 같은 버튼을 다시 가리킨다.
    id: "league",
    targetTestId: "play-cta",
    title: "리그로 시즌을 치릅니다",
    body: "‘게임 시작 → 리그’ 를 고르면 10팀 18라운드 시즌이 열리고, 시즌이 끝나면 순위 보상을 받습니다.",
    enabled: true,
  },
];
