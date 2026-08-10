import type { TutorialStep } from "./tutorial-steps";

/**
 * #493 W2 — 화면별 첫 진입 가이드 정의.
 *
 * ⚠️ **온보딩 배열(`TUTORIAL_STEPS`)에 합치지 마라.** 스텝을 더하면 "n / total" 진행 표시와
 * 완료 저장(= 서버 덱 지급 트리거)이 같이 깨진다 — 트레이드 코치마크가 정확히 그렇게 롤백됐다
 * (tutorial-steps.ts 머리말, hero Q7=A). 화면별 가이드는 **별도 프로바이더**(`GuideProvider`)가
 * 이 배열을 자기 진행 상태(`guide-storage`, 화면 단위 seen)로 돌린다.
 *
 * 규칙:
 *  - 화면 = 라우트 pathname 정확 일치. **홈·덱은 온보딩 소유**라 여기 넣지 않는다
 *    (계약 = guide-steps.test.ts). /match 는 라우트가 아니라 상태 기반이라 W2 스코프 밖(#493).
 *  - 대상은 전부 기존 `data-testid` — 상태에 따라 없을 수 있는 대상(리그 시작/다음 경기)은
 *    오버레이의 대상 부재 스킵이 처리한다(있는 쪽만 뜬다).
 *  - 문구는 게임 언어로, 시스템 용어 금지(#382 규율).
 */
export interface ScreenGuide {
  /** 화면 식별자 = 라우트 pathname (seen 저장 키로도 쓴다). */
  screen: string;
  steps: TutorialStep[];
}

const step = (id: string, targetTestId: string, title: string, body: string): TutorialStep => ({
  id,
  targetTestId,
  title,
  body,
  enabled: true,
});

export const SCREEN_GUIDES: ScreenGuide[] = [
  {
    screen: "/game",
    steps: [
      step("guide-game-practice", "mode-practice", "연습 경기", "부담 없는 상대와 한 판. 첫 경기는 여기서 시작해 보세요."),
      step("guide-game-league", "mode-league", "리그", "10팀이 18라운드를 도는 시즌. 순위에 따라 승급과 보상이 걸립니다."),
      step("guide-game-away", "mode-away", "원정", "다른 감독의 팀에 도전합니다. 이긴 만큼 레이팅이 오릅니다."),
    ],
  },
  {
    screen: "/away",
    steps: [
      step("guide-away-start", "away-start", "원정 떠나기", "누르면 상대 후보를 제시받고, 한 팀을 골라 도전합니다."),
    ],
  },
  {
    screen: "/players",
    steps: [
      step("guide-players-scope", "codex-scope-owned", "선수", "모은 선수를 한눈에. 카드를 누르면 상세와 강화로 이어집니다."),
    ],
  },
  {
    screen: "/recruit",
    steps: [
      step("guide-recruit-gacha", "gacha-single", "뽑기", "새 선수 카드를 뽑습니다. 더 강한 선수로 스쿼드를 넓혀 보세요."),
      step("guide-recruit-trade", "recruit-tab-trade", "트레이드", "안 쓰는 선수를 걸고 다른 감독과 교환합니다."),
    ],
  },
  {
    screen: "/league",
    steps: [
      // 상태 분기: 시즌 전엔 start-league 만, 진행 중엔 next-match 만 존재한다 — 없는 쪽은 스킵된다.
      step("guide-league-start", "start-league", "리그 시작", "시즌을 열면 18라운드 일정이 잡힙니다. 하루 몇 경기든 자유."),
      step("guide-league-next", "next-match", "다음 경기", "일정의 다음 상대와 바로 경기합니다. 순위표는 아래에."),
    ],
  },
  {
    screen: "/me",
    steps: [
      step("guide-me-replay", "tutorial-replay", "내 정보", "전적과 설정이 여기에. 튜토리얼과 화면 안내는 언제든 다시 볼 수 있습니다."),
    ],
  },
];

/** 라우트 정확 일치로 가이드를 찾는다 — 미정의 화면·온보딩 소유 화면은 null. */
export function guideForPath(pathname: string): ScreenGuide | null {
  return SCREEN_GUIDES.find((g) => g.screen === pathname) ?? null;
}
