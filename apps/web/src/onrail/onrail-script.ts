/**
 * #493 W7-v3 — **온레일 튜토리얼 시나리오**(순수 데이터).
 *
 * SoT = `evidence/493/W7v3-scenario-storyboard.html`(hero 승인, 2026-08-12) 의 S1~S7.
 * 조정 포인트 6건 확정: ①덱셋팅 AUTO→프롬프트→저장 ②탭투어=**경기 화면 요소** ③강화만 무료 ·
 * 승급은 유저가 직접 ④뽑기 강제 제외 ⑤하프타임 안내만(교체 강제 없음) ⑥건너뛴 유저 재진입 없음.
 *
 * ## 온레일이 코치마크와 다른 점
 *
 * `common/guide-steps.ts`(화면별 첫 진입 가이드)는 **비-모달**이다 — 딤이 입력을 막지 않고 유저는
 * 아무 데나 누를 수 있다. 온레일은 정반대다: hero 지시가 *"유저가 선택할 여유가 없이 강제해야돼"*
 * 라서 **허용 타깃 하나를 뺀 화면 전체가 실제로 막힌다**(`OnRailOverlay`). 그래서 두 시퀀스를 한
 * 배열에 합치지 않는다 — 합치면 한쪽의 규율이 다른 쪽을 깬다(`tutorial-steps` ↔ `guide-steps` 가
 * 갈라진 것과 같은 이유, hero Q7=A).
 *
 * ## 스텝이 넘어가는 문은 셋뿐이다
 *  · `next`   — 설명만 하고 [다음] (경기 화면 투어 S3)
 *  · `action` — **유저가 그 행동을 실제로 해야** 넘어간다. 발화 = `onrail-actions.ts`
 *  · `cta`    — 말풍선의 버튼이 그 자리에서 무언가를 한다(경기 시작 · 화면 이동 · 완주)
 *
 * ## 대상이 없으면 **기다린다**(건너뛰지 않는다)
 *
 * 이것이 온레일과 코치마크의 두 번째 차이다. `TutorialOverlay` 는 대상이 없으면 그 스텝을 버리는데
 * (화면 사정), 온레일에서 그러면 **다음 스텝의 전제가 무너진다**(저장 안 한 덱으로 경기하러 간다).
 * 그래서 기본은 **hold** — 오버레이가 안 뜨고 유저는 자유롭다가, 대상이 나타나면 그 자리에서 잡는다.
 * 이 성질이 화면 전환을 공짜로 만든다: 매치를 만들면 감독시간이 먼저 뜨는데, 투어 첫 스텝은
 * 스코어보드가 생길 때까지 조용히 기다리므로 유저는 그동안 [킥오프]를 누를 수 있다.
 *
 * `skipIfMissing` 은 그 반대를 **명시적으로 고른** 스텝이다 — 영영 안 나타날 수 있는 손잡이
 * (정보 탭은 탭이 2개 이상일 때만, AUTO 는 빈 자리가 있을 때만) 앞에서 유저를 가두지 않기 위해서다.
 *
 * ⚠️ **`targetTestId` 는 전부 기존 손잡이다.** 온레일 때문에 화면에 새 testid 를 심지 않는다 —
 * 심으면 그 화면의 계약이 온레일을 알게 되고, 온레일을 지울 때 같이 죽는다.
 */

/** 덱 첫 슬롯 선수 — 프로바이더가 런타임 값으로 치환한다(S2 "지정 선수 1명"). */
export const DECK_PLAYER_TOKEN = "{deckPlayerId}";
/** 스타터 고정 튜토리얼 카드(서버 `hmb.tutorial.starter.card-id`) — 런타임 해석은 `useTutorialCard`. */
export const TUTORIAL_CARD_TOKEN = "{tutorialCardId}";

/** 어느 화면에서나 뜨는 스텝(완주 연출). */
export const ANY_SCREEN = "*";

export type OnRailAdvance =
  /** 말풍선 [다음] — 설명형. */
  | { kind: "next" }
  /** 그 행동이 올 때까지 기다린다. 말풍선에 진행 버튼이 **없다**. */
  | { kind: "action"; action: string }
  /** 말풍선 버튼이 곧 그 동작. `cta` 는 프로바이더의 스위치 하나로 해석된다. */
  | { kind: "cta"; label: string; cta: OnRailCta };

/** 말풍선 버튼이 하는 일 — 데이터에 코드를 넣지 않기 위한 **닫힌 목록**이다. */
export type OnRailCta =
  /** 튜토리얼 고정 매치를 만들고 그 매치로 간다(S2 끝 → S3). */
  | "start-match"
  /** 선수 탭으로(S4 끝 → S5). */
  | "go-growth"
  /** 영입 탭 트레이드로(S5 끝 → S6). */
  | "go-trade"
  /** 완주 — 상태를 done 으로 굳히고 홈으로(S7). */
  | "finish";

export interface OnRailStep {
  id: string;
  /**
   * 이 스텝이 사는 화면(pathname). `/match` 는 매치 id 가 붙으므로 **접두 일치**,
   * `ANY_SCREEN` 은 아무 데나. 쿼리(`?tab=trade`)는 보지 않는다.
   */
  screen: string;
  /**
   * 하이라이트 대상. 생략하면 **대상 없는 전면 안내**(완주 연출처럼 화면 전체가 주인공일 때).
   * 치환 토큰을 포함할 수 있다(위 두 상수).
   */
  targetTestId?: string;
  /** 치환이 실패했을 때 대신 겨눌 손잡이(런타임 값을 서버가 아직 안 줄 때의 착지점). */
  fallbackTestId?: string;
  title: string;
  body: string;
  advance: OnRailAdvance;
  /**
   * 대상이 유예 시간 안에 안 나타나면 **그 스텝을 건너뛴다**(기본은 hold — 위 머리말).
   * 영영 없을 수 있는 손잡이 앞에서만 켠다.
   */
  skipIfMissing?: boolean;
  /**
   * 경기 재생을 **정지**시키고 [스킵]을 **잠근다**(S3 투어 구간).
   * 소비 = `match/MatchPage`(`useOnRail().matchFrozen`).
   */
  freezeMatch?: boolean;
}

export type OnRailStepId = string;

/**
 * S2 — 덱셋팅. hero: *"덱셋팅은 오토버튼누르게하고 저장하게하고 한명눌러서 프롬프트 입력하게해야돼."*
 * 순서는 조정 ① 확정안(AUTO → 프롬프트 → **저장**) — 저장을 먼저 시키면 한마디가 안 담긴 덱이
 * 한 번 저장되고, 그 저장이 첫 저장 보상을 태워 버린다.
 *
 * ⚠️ **AUTO 는 `skipIfMissing` 이다.** `auto-fill` 은 **빈 자리가 있을 때만** 뜨는데(#455 A3
 * `hasEmptySlotGap`), 온보딩 완료가 이미 11명짜리 덱을 지급하므로 이 동선의 유저는 대개 빈 자리가
 * 없다. 없는 버튼 앞에 세우면 유저는 [홈으로] 말고 나갈 길이 없다. 강제하려면 서버가 튜토리얼
 * 덱을 비워 주거나 AUTO 노출 조건이 바뀌어야 한다 — web 혼자 못 고치는 자리다(#57 이슈).
 */
const DECK_STEPS: OnRailStep[] = [
  {
    id: "deck-auto",
    screen: "/deck",
    targetTestId: "auto-fill",
    title: "먼저 라인업부터",
    body: "[⚡ 자동 채우기]를 누르면 빈 자리가 한 번에 채워집니다. 첫 경기는 이 스쿼드로 치릅니다.",
    advance: { kind: "action", action: "deck-auto" },
    skipIfMissing: true,
  },
  {
    id: "deck-player",
    screen: "/deck",
    targetTestId: `token-${DECK_PLAYER_TOKEN}`,
    fallbackTestId: "tactics-board",
    title: "선수를 한 명 눌러 보세요",
    body: "선수를 누르면 그 선수의 지시판이 열립니다. 감독이 한마디 건넬 차례예요.",
    advance: { kind: "action", action: "deck-player" },
  },
  {
    id: "deck-prompt",
    screen: "/deck",
    targetTestId: "rail-prompt-input",
    title: "감독의 한마디",
    body: "하고 싶은 말을 그대로 쓰면 됩니다 — 예: ‘오늘 너만 믿는다’. 이 문장이 경기에서 그 선수의 성향이 됩니다.",
    advance: { kind: "action", action: "deck-prompt" },
  },
  {
    id: "deck-save",
    screen: "/deck",
    targetTestId: "save-deck",
    title: "저장해야 반영됩니다",
    body: "[저장]을 눌러 지금 짠 덱을 확정하세요. 첫 저장 보상 300 젬을 우편으로 보내드립니다.",
    advance: { kind: "action", action: "deck-save" },
  },
  {
    id: "deck-done",
    screen: "/deck",
    targetTestId: "save-deck",
    title: "이제 경기하러 가볼까요?",
    body: "덱이 저장됐습니다. 준비된 상대와 한 판 치르면서 경기 화면을 익혀 봅시다.",
    advance: { kind: "cta", label: "경기 시작", cta: "start-match" },
  },
];

/**
 * S3 — 경기 화면 투어. 조정 ② 확정: **앱 하단 탭이 아니라 경기 화면 요소**다(경기 중엔 하단 탭이
 * 잠기는 구조라 그쪽은 투어가 성립하지 않는다).
 *
 * 투어가 도는 동안 `freezeMatch` 로 **재생 정지 + 스킵 잠금**. 마지막 스텝을 넘기면 풀리고, 그
 * 뒤는 일반 관전과 완전히 같다(전·후반 · 배속 · 스킵 자유). 하프타임은 **안내만**(조정 ⑤) —
 * 교체는 사전에 구운 후반 로그에 반영되지 않으므로 온레일이 그 자리를 막는다(W6-v3 전제).
 *
 * ⚠️ 전부 `skipIfMissing` 이다. 손잡이가 폭·상태에 따라 없을 수 있고(정보 탭은 탭이 2개 이상일
 * 때만, 시크바는 스냅샷이 2개 이상일 때만), 여기서 막히면 유저는 **경기를 못 본다**.
 */
const MATCH_TOUR_STEPS: OnRailStep[] = [
  {
    id: "match-scoreboard",
    screen: "/match",
    targetTestId: "stage-scorebar",
    title: "① 스코어보드와 시계",
    body: "양 팀 점수와 경기 시계입니다. 전반·후반으로 나뉘어 진행돼요.",
    advance: { kind: "next" },
    skipIfMissing: true,
    freezeMatch: true,
  },
  {
    id: "match-pitch",
    screen: "/match",
    targetTestId: "stage-canvas",
    title: "② 경기 장면",
    body: "선수들이 실제로 움직입니다. 감독이 적은 한마디가 여기서 성향으로 나타나요.",
    advance: { kind: "next" },
    skipIfMissing: true,
    freezeMatch: true,
  },
  {
    id: "match-timeline",
    screen: "/match",
    targetTestId: "viewer-seek-bar-half1",
    title: "③ 타임라인과 장면 핀",
    body: "골·선방 같은 장면이 핀으로 찍힙니다. 눌러서 그 순간으로 바로 건너뛸 수 있어요.",
    advance: { kind: "next" },
    skipIfMissing: true,
    freezeMatch: true,
  },
  {
    id: "match-controls",
    screen: "/match",
    targetTestId: "viewer-controls-half1",
    title: "④ 재생과 배속",
    body: "멈추고 다시 보고, 빠르게 넘길 수 있습니다. 급할 땐 배속을 올려 보세요.",
    advance: { kind: "next" },
    skipIfMissing: true,
    freezeMatch: true,
  },
  {
    id: "match-stats",
    screen: "/match",
    targetTestId: "stage-tab-stats",
    title: "⑤ 통계",
    body: "점유율·슛·패스 성공률이 쌓입니다. 무엇이 통했는지 여기서 확인해요.",
    advance: { kind: "next" },
    skipIfMissing: true,
    freezeMatch: true,
  },
  {
    id: "match-skip",
    screen: "/match",
    targetTestId: "match-skip",
    title: "⑥ 건너뛰기",
    body: "결과만 빨리 보고 싶을 땐 이 버튼입니다. 지금은 잠가 뒀어요 — 첫 경기는 끝까지 함께 봅시다.",
    advance: { kind: "next" },
    skipIfMissing: true,
    freezeMatch: true,
  },
];

/**
 * S4 — 결과(반드시 승리, 서버 고정 시드).
 *
 * ⚠️ **보상 봉투를 온레일이 대신 눌러 주지 않는다.** `FIRST_RESULT_VIEW` 300 젬은 봉투 `ack`
 * (`reward-confirm`)이 서버에서 태우는데, 그 시트는 자기 모달이라 온레일이 **비켜난다**
 * (`OnRailOverlay` 의 외부 다이얼로그 규칙). 유저가 시트를 닫으면 결과 화면에서 이 스텝이 잡힌다.
 * 온레일이 그 버튼을 겨누려 했다가는 시트가 안 뜨는 경기(봉투 없음)에서 영원히 기다린다.
 */
const RESULT_STEPS: OnRailStep[] = [
  {
    id: "result-view",
    screen: "/match",
    targetTestId: "result-page",
    title: "첫 승리입니다",
    body: "결과와 평점, 받은 보상이 여기 정리됩니다. 이제 선수를 키워 볼 차례예요.",
    advance: { kind: "cta", label: "선수 키우러 가기", cta: "go-growth" },
  },
];

/**
 * S5 — 성장. hero: *"성장탭들어가면 무조건 한명 강화, 승급시켜야돼."*
 *
 * ⚠️ **순서가 스토리보드와 뒤집혔다 — 서버가 그렇게만 허용한다.** 스토리보드는 ①강화 →②승급
 * 이었지만 잠재 강화(`POST /api/growth/dice`)는 **2★ 미만이면 `POTENTIAL_LOCKED` 로 거절**하고
 * (화면도 `potentialLocked` 로 버튼을 잠근다), 스타터 카드는 1★ + 중복 2장으로 온다. 즉 승급이
 * 먼저 와야 강화가 열린다. 무료 쿠폰(`FREE_ENHANCE`)과 `FIRST_ENHANCE` 300 젬은 **강화 쪽**에
 * 걸려 있으므로 순서를 지키지 않으면 둘 다 못 받는다.
 *
 * ⚠️ **"골드 써보기"(조정 ③)는 이 빌드에서 성립하지 않는다.** 승급 비용은 골드가 아니라
 * **중복 카드**이고(`growth-star-cost` = "중복 −N"), 강화는 쿠폰으로 무료다. 스토리보드의 그
 * 문장은 재화 모델과 어긋나므로 문구에 골드를 적지 않았다 — 되살리려면 서버가 승급에 골드
 * 비용을 붙여야 한다(W8-v3 로 올릴 편차).
 */
const GROWTH_STEPS: OnRailStep[] = [
  {
    id: "growth-open",
    screen: "/players",
    targetTestId: `codex-card-${TUTORIAL_CARD_TOKEN}`,
    fallbackTestId: "codex-grid",
    title: "이 선수를 키워 봅시다",
    body: "카드를 누르면 성장 화면이 열립니다. 가입 선물로 받은 카드예요.",
    advance: { kind: "action", action: "growth-open" },
  },
  {
    id: "growth-promote",
    screen: "/players",
    targetTestId: "growth-star-up",
    title: "같은 카드 2장이면 승급",
    body: "가입 선물에 같은 카드가 더 들어 있습니다. 합치면 성★이 오르고 능력치 상한이 열려요.",
    advance: { kind: "action", action: "growth-promote" },
  },
  {
    id: "growth-choice",
    screen: "/players",
    targetTestId: "growth-pending-banner",
    title: "어떤 능력을 올릴까요",
    body: "경험치가 차면 올릴 능력을 고를 수 있습니다. 원하는 쪽을 하나 골라 보세요.",
    advance: { kind: "action", action: "growth-choice" },
    skipIfMissing: true,
  },
  {
    id: "growth-enhance",
    screen: "/players",
    targetTestId: "growth-dice-normal",
    title: "무료 강화권을 써 보세요",
    body: "승급으로 잠재력이 열렸습니다. 첫 강화는 무료권으로 공짜예요 — 눌러서 잠재력을 다시 굴려 봅시다.",
    advance: { kind: "action", action: "growth-enhance" },
  },
  {
    id: "growth-done",
    screen: "/players",
    targetTestId: "growth-dice-normal",
    title: "성장 보상이 도착했습니다",
    body: "첫 강화 보상 300 젬을 우편으로 보냈어요. 다음은 새 선수를 데려올 차례입니다.",
    advance: { kind: "cta", label: "영입하러 가기", cta: "go-trade" },
  },
];

/**
 * S6 — 트레이드. hero: *"처음은 무조건 한명 높은 등급 하나 나오게하고 단축도 무료로."*
 * 등급 확정(최상위 근접 **DIA** — 이 게임의 등급 사다리에 EPIC 은 없다)과 단축 무료는 **서버가
 * 한다**(W6-v3). web 은 그 자리로 데려가고 눌러 보게 할 뿐이다.
 */
const TRADE_STEPS: OnRailStep[] = [
  {
    id: "trade-start",
    screen: "/recruit",
    targetTestId: "trade-slot-1-start",
    title: "트레이드를 걸어 봅시다",
    body: "선수를 내보내고 새 선수를 받아옵니다. 첫 트레이드는 좋은 등급이 나오도록 준비해 뒀어요.",
    advance: { kind: "action", action: "trade-start" },
  },
  {
    id: "trade-rush",
    screen: "/recruit",
    targetTestId: "trade-slot-1-speedup",
    title: "기다릴 필요 없습니다",
    body: "트레이드는 시간이 걸리지만 단축권이 있으면 바로 받을 수 있어요. 무료 단축권을 써 봅시다.",
    advance: { kind: "action", action: "trade-rush" },
  },
  {
    id: "trade-accept",
    screen: "/recruit",
    targetTestId: "trade-slot-1-accept",
    title: "받아 가세요",
    body: "수락하면 새 선수가 스쿼드에 들어옵니다. 첫 트레이드 보상 300 젬도 함께 도착해요.",
    advance: { kind: "action", action: "trade-accept" },
    // 제안형(FA) 오퍼가 나오면 [수락]이 아니라 [제안]이 뜬다 — 그때는 이 스텝을 넘긴다.
    // 첫 트레이드 보상은 이미 `start` 에서 태웠으므로 여기서 잃는 것은 연출뿐이다.
    skipIfMissing: true,
  },
];

/** S7 — 완주. 대상 없는 전면 안내(화면 전체가 주인공)라 어느 화면에서든 뜬다. */
const FINISH_STEPS: OnRailStep[] = [
  {
    id: "finish",
    screen: ANY_SCREEN,
    title: "🎉 튜토리얼 완료!",
    body: "완주 보상 300 젬을 우편으로 보냈습니다. 이제 당신의 팀으로 진짜 경기를 시작해 보세요.",
    advance: { kind: "cta", label: "홈으로", cta: "finish" },
  },
];

/** 온레일 전체 각본 — **한 줄기**다(화면을 넘나든다). */
export const ONRAIL_SCRIPT: readonly OnRailStep[] = [
  ...DECK_STEPS,
  ...MATCH_TOUR_STEPS,
  ...RESULT_STEPS,
  ...GROWTH_STEPS,
  ...TRADE_STEPS,
  ...FINISH_STEPS,
];

/**
 * 각본의 시작점 = 덱셋팅 첫 스텝.
 *
 * ⚠️ `ONRAIL_SCRIPT[0]` 이 아니라 `DECK_STEPS[0]` 에서 읽는다 — 타입상 `readonly OnRailStep[]` 의
 * 인덱싱은 `undefined` 가 될 수 있고(`noUncheckedIndexedAccess`), 여기서 `!` 로 넘기면 "각본이
 * 비면 런타임에 터진다"를 침묵시키게 된다. 배열 리터럴에서 읽으면 그 자리가 **비어 있을 수 없다**.
 */
export const ONRAIL_FIRST_STEP: OnRailStepId = DECK_STEPS[0]!.id;
