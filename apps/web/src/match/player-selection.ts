/**
 * 경기 화면 **선수 선택**(#406 W4, 요구 5-2) — 순수 판정만. React/DOM 의존 0.
 *
 * <h3>선택 상태의 SoT 는 어디인가</h3>
 * 이 화면엔 "선택됨"이 될 수 있는 자리가 둘이다. **축이 다르므로 하나로 합치지 않는다** —
 * 대신 어느 쪽이 무엇을 소유하는지 여기 적어 둔다(합치려고 하면 아래 이유를 먼저 읽어라).
 *
 * <table>
 *   <tr><th>축</th><th>SoT</th><th>무엇</th></tr>
 *   <tr>
 *     <td><b>피치 열람 선택</b></td>
 *     <td><b>{@link VisualPlayback}</b>(캔버스 표면) — 이 모듈이 규칙을 소유한다</td>
 *     <td>"지금 누구를 보고 있나". 내 선수·상대 선수 <b>둘 다</b> 대상이고, 링 + 정보 카드로 답한다</td>
 *   </tr>
 *   <tr>
 *     <td><b>지시 대상 선택</b></td>
 *     <td>`SecondHalfBriefPanel` / `HalftimePanel`(각 패널의 로컬 상태)</td>
 *     <td>"누구에게 후반 지시를 쓰나". <b>내 팀만</b>이고 대상 칩 + 프롬프트 칸으로 답한다</td>
 *   </tr>
 * </table>
 *
 * <p>감독시간에는 두 축이 <b>서로 다른 탭</b>에 있어(무대가 `경기장면` 탭으로 내려간다 — `StageShell`
 * 의 `managing`) 한 화면에 같이 뜨지 않는다. 전반에는 같이 뜰 수 있는데, 그때도 <b>같은 것을 두 번
 * 고르는 게 아니다</b>: 피치 링은 상대 선수에게도 붙고 지시 칩은 내 팀 전용이며 `팀 전체` 옵션이 있다.
 *
 * <p>⚠️ <b>다만 hero 요구 5-2 의 절반("프롬프트 입력 시 그 선수가 하이라이트")은 아직 반쪽이다.</b>
 * 지시 칩을 누를 때도 피치가 켜지려면 그 패널이 아래 seam 을 부르면 된다 —
 * {@link VisualPlayback} 의 `selection`/`onSelectionChange` **controlled 프롭**이 그 자리다
 * (상태를 `StageShell` 로 들어올리면 두 패널이 같은 값을 쓴다). 그 파일들은 이 웨이브의 소유가
 * 아니라(#406 W1b · #403 W2) 배선을 남겨 두고 후속으로 넘긴다.
 */
import { skinKeyOf } from "@hmb/viewer-core";

export type TeamSide = "home" | "away";

/** 선택 1건. **팀이 항상 붙는다** — 같은 playerId 가 양 팀에 동시에 뛴다(#324/#231). */
export interface SelectedPlayer {
  team: TeamSide;
  playerId: string;
}

/** 코어가 "실제로 그렸다"고 알려주는 토큰(`hooks.curPlayers()`). 좌표는 캔버스 backing px. */
export interface DrawnToken {
  id: string;
  team: TeamSide;
  /** 캔버스 backing 좌표 — 카메라 변환을 밖에서 재구현하지 않는다(#218 규율). */
  px: number;
  py: number;
  /** 오버레이 층의 기준 토큰 반경(px). 코어가 실어 준다. */
  r: number;
  num?: string;
}

/**
 * 토큰 반경 위에 더하는 터치 여유(px, 캔버스 backing 기준).
 *
 * <p>토큰 지름이 backing 16px 이고 폰에서는 캔버스가 축소돼 그려지므로, 반경만으로 재면
 * 손가락으로 맞출 수 없다. 값이 너무 크면 빈 공간 탭이 엉뚱한 선수를 켜므로 **가장 가까운
 * 토큰 하나**를 고른 뒤에만 이 여유를 적용한다(아래 {@link hitTestToken}).
 */
export const HIT_PAD_PX = 14;

/** 선택 조회 키. 규칙은 코어와 **같은 함수**를 쓴다 — 여기서 다시 적으면 조용히 갈라진다. */
export function selectionKey(team: TeamSide, playerId: string): string {
  return skinKeyOf(team, playerId);
}

export interface CanvasBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 박스 크기만(위치 없음) — 무대 셸·카드처럼 부모 기준으로 재는 자리에 쓴다. */
export interface BoxSize {
  width: number;
  height: number;
}

/**
 * `object-fit: contain` 이 만드는 **축소·레터박스**. 아래 두 변환의 **공용 SoT** 다 —
 * 같은 산술을 두 번 적으면 한쪽만 고쳐지는 날 탭과 배치가 조용히 갈린다.
 *
 * <p>`originX/originY` 는 **박스 좌상단 기준**(클라이언트 좌표가 아니다).
 */
function fitOf(
  box: BoxSize,
  backingW: number,
  backingH: number,
): { scale: number; originX: number; originY: number } | null {
  if (!(box.width > 0) || !(box.height > 0) || !(backingW > 0) || !(backingH > 0)) return null;
  const scale = Math.min(box.width / backingW, box.height / backingH);
  if (!(scale > 0)) return null;
  return {
    scale,
    originX: (box.width - backingW * scale) / 2,
    originY: (box.height - backingH * scale) / 2,
  };
}

/**
 * **캔버스 backing 좌표 → 무대(=캔버스 박스) 상대 CSS 좌표.** `canvasPointOf` 의 역변환이다.
 *
 * <p>무대 오버레이(정보 카드)는 캔버스와 **같은 박스** 안에 절대배치되므로, 여기서 나온 (x,y) 가
 * 곧 그 오버레이 좌표계다. `scale` 도 같이 돌려준다 — 링 반경(backing px)을 CSS px 로 옮기려면
 * 같은 배율이어야 한다(따로 계산하면 갈린다).
 */
export function stagePointOf(
  box: BoxSize,
  backingW: number,
  backingH: number,
  x: number,
  y: number,
): { x: number; y: number; scale: number } | null {
  const fit = fitOf(box, backingW, backingH);
  if (!fit) return null;
  return { x: fit.originX + x * fit.scale, y: fit.originY + y * fit.scale, scale: fit.scale };
}

/**
 * 클라이언트 좌표 → **캔버스 backing 좌표**.
 *
 * <p>⚠️ 캔버스는 `width/height = 1050×680` 인데 CSS 로 `width:100%; height:100%; object-fit:
 * contain` 이다(`MatchViewer.module.css`). 즉 화면 위 그림은 **축소·레터박스**돼 있다.
 * `clientX - rect.left` 를 그대로 쓰면 폰에서 좌표가 2~3배 어긋나 히트테스트가 통째로 빗나간다.
 *
 * <p>박스 밖(레터박스 띠)이면 `null` — 피치가 아닌 자리를 선수 탭으로 읽지 않는다.
 */
export function canvasPointOf(
  rect: CanvasBox,
  backingW: number,
  backingH: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const fit = fitOf(rect, backingW, backingH);
  if (!fit) return null;
  const { scale } = fit;
  const originX = rect.left + fit.originX;
  const originY = rect.top + fit.originY;
  const x = (clientX - originX) / scale;
  const y = (clientY - originY) / scale;
  if (x < 0 || y < 0 || x > backingW || y > backingH) return null;
  return { x, y };
}

/**
 * 가장 가까운 토큰. 그 토큰의 **자기 반경 + 여유** 밖이면 `null`(= 빈 공간 탭 → 해제).
 *
 * <p>반경은 코어가 실어 준 `r` 을 쓴다 — `useFollow ? 11 : 8` 을 여기 적으면 팔로우 줌에서
 * 히트 영역이 실제 토큰과 어긋난다(그리고 두 곳이 조용히 갈라진다).
 */
export function hitTestToken(
  tokens: readonly DrawnToken[],
  x: number,
  y: number,
  pad: number = HIT_PAD_PX,
): DrawnToken | null {
  let best: DrawnToken | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of tokens) {
    if (!t || !Number.isFinite(t.px) || !Number.isFinite(t.py)) continue;
    const d = Math.hypot(x - t.px, y - t.py);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  if (!best) return null;
  const reach = (Number.isFinite(best.r) ? best.r : 8) + pad;
  return bestDist <= reach ? best : null;
}

export function isSelected(
  current: readonly SelectedPlayer[],
  team: TeamSide,
  playerId: string,
): boolean {
  const key = selectionKey(team, playerId);
  return current.some((s) => selectionKey(s.team, s.playerId) === key);
}

/** 그 팀에서 지금 선택된 선수(없으면 null). */
export function selectedOf(
  current: readonly SelectedPlayer[],
  team: TeamSide,
): SelectedPlayer | null {
  return current.find((s) => s.team === team) ?? null;
}

/**
 * 토글 규칙 — **팀당 한 명**(목업 §2: "홈·어웨이 각각 1명씩 동시에 선택할 수 있다 = 내가 고른
 * 선수 + 정보 보는 상대"). 같은 선수를 다시 누르면 해제한다.
 *
 * <p>순서는 유지한다(뒤에 붙인다) — 카드가 "마지막에 누른 선수"를 보여주므로 순서가 정보다.
 */
export function toggleSelection(
  current: readonly SelectedPlayer[],
  next: SelectedPlayer,
): SelectedPlayer[] {
  const nextKey = selectionKey(next.team, next.playerId);
  const already = current.some((s) => selectionKey(s.team, s.playerId) === nextKey);
  const others = current.filter((s) => s.team !== next.team);
  return already ? others : [...others, { team: next.team, playerId: next.playerId }];
}

/**
 * 내 팀 선수인가. **모르면 `null`** — "내 선수"라고 잘못 말하지 않는다(#322 와 같은 태도:
 * 어웨이 라운드에서 내 팀은 오른쪽이고, `myTeamSide` 를 모르면 답할 수 없는 질문이다).
 */
export function mineOf(team: TeamSide, myTeamSide: TeamSide | null | undefined): boolean | null {
  if (myTeamSide !== "home" && myTeamSide !== "away") return null;
  return team === myTeamSide;
}

/** 코어 이름표 문구 — 밀집 UI 라 **짧은 이름 + 등번호**(#406 요구 6 의 두 축 규율). */
export function arenaLabelOf(shortName: string | null | undefined, num: string | null | undefined): string | null {
  const name = shortName?.trim();
  const n = num?.trim();
  if (name && n) return `${name}(${n})`;
  if (name) return name;
  if (n) return `#${n}`;
  return null;
}


/*
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * 정보 카드가 **지금 켜진 모든 선택 링을 덮지 않는다** (#406 W6 MAJOR-A · W7 BLOCKER-1)
 *
 * W4 는 카드를 무대 **왼쪽 위 고정**(`left:6px; top:34px`)으로 뒀다. 390 폰에서 그 사각 안에는
 * 토큰이 여럿 들어가고, 독립검증 실측으로 **22탭 중 7건**(전부 홈 = 내 선수)에서 선택 토큰의
 * **중심이 카드 안**이라 링이 통째로 가려졌다 — 카드는 "한글선수0 · 내 선수"라고 말하는데
 * 피치 어디에도 링이 없다.
 *
 * <h3>⚠️ W6 의 수리는 상태공간의 절반만 닫았다 (W7 BLOCKER-1)</h3>
 * 이 화면은 **팀당 1명씩 동시 2명 선택**을 1급으로 지원한다({@link toggleSelection}). 그런데 W6 은
 * 피할 대상을 **카드가 보여주는 그 선수**(= 마지막에 누른 선수)의 링 하나로 잡았다 — 두 번째를
 * 누르면 카드가 두 번째만 피해 기본 자리로 돌아와 **첫 번째 링을 100% 덮었다**(독립검증 실측
 * `home:H1 중심카드안=true · 덮인둘레 32/32`). 그래서 여기는 이제 **링 목록**을 받고 판정은
 * `min(모든 링)` 이다. 계약도 짝을 이룬다 — 순수 기하는 아래 단위 계약의 **2링 격자**가,
 * 실화면은 `e2e/p406-player-highlight.spec.ts` ⑪(홈+어웨이 동시 선택)이 잰다.
 *
 * ⚠️ **왜 계약이 못 잡았나**: ⑤ 는 카드가 뷰포트 안인지·시크바를 안 덮는지만 쟀고, ⑧ 은 카드 밑
 *    선수를 **누를 수 있는지**만 쟀다(m-6 수리는 "가려도 누를 수는 있다"에서 끝났다). *"가려도
 *    보이는가"* 를 아무도 묻지 않았다 — ⑧ 은 카드 아래 토큰 4개를 **로그로 찍으면서도** 묻지 않았다.
 *
 * <h3>왜 "네 모서리"가 아닌가 — 390 폰에서 그 모델은 사각지대를 남긴다</h3>
 * 무대는 390×253(폰 390×844 실측), 카드는 그보다 훨씬 넓다(아래 {@link CARD_INSET} 의 실측표).
 * 좌·우 열이 가로로 **겹치고** 위·아래 줄도 겹친다. 그래서 네 모서리만 후보로 두면 무대
 * 한가운데에 **어느 모서리로도 못 피하는 구멍**이 남는다 — 하필 센터서클이라 선수가 자주 선다.
 * 후보를 **열 2 × 줄 여럿**으로 세우면 그 구멍이 닫힌다: 줄은 기본(배너 아래) → 아래(시크바 위)
 * → 빠듯(배너까지 침범, 순간 연출이라 잠깐 겹쳐도 된다) → 링 기준(위/아래) 순으로 훑는다.
 *
 * <h3>탐색이 **완전**하다 — "못 찾았다"와 "없다"를 가른다 (W7 m-1/m-2)</h3>
 * 한 열(side)에서 카드 윗변이 앉을 수 있는 구간 `[topTight, 마지막줄]` 중 **링을 안 가리는**
 * 부분집합은 금지 구간(링당 1개)의 여집합이라 **구간들의 합집합**이고, 각 구간의 왼쪽 끝은
 * 언제나 `topTight` 아니면 `링아래줄 = ring.y + ring.r + clear` 중 하나다. 후보에 그 둘을
 * **전부**(구간 밖으로 밀려난 것까지 마지막 줄로 캡해서) 넣으므로 — 비킬 자리가 존재하면
 * 반드시 찾는다. 즉 아래에서 "못 비켰다"가 나오면 그건 **정말로 자리가 없는 형상**이다.
 * (그 완전성 자체를 단위 계약이 **독립 오라클**(연속 구간 전수 탐색)로 검정한다.)
 *
 * <p>정말로 자리가 없으면 **가장 덜 가리는 곳**을 준다 — 카드를 지우는 것보다 낫다. ⚠️ W6 주석은
 * 이 상태를 *"계약이 표본으로 드러낸다"* 고 적었는데 **그때는 거짓이었다**(어떤 표본도 그 가지를
 * 태우지 않았다 — W7 m-2). 지금은 참이다: 단위 계약 *"자리가 없으면 가장 덜 가리는 곳"* 이 그
 * 가지를 태우고, 고른 값이 **후보 전체의 최댓값**임을 독립 계산으로 확인한다.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 */

/** 카드가 앉은 자리(무대 상대 CSS px). `side` 는 붙는 가장자리, `top` 은 윗변. */
export interface CardPlacement {
  side: "left" | "right";
  top: number;
}

/** 기본 자리 = 종전과 같은 왼쪽 위. */
export const CARD_HOME: CardPlacement = { side: "left", top: 34 };

/**
 * 카드 여백(무대 CSS px) — **여기가 SoT** 다. CSS 에 같은 숫자를 또 적으면 두 곳이 갈리고,
 * 그러면 아래 기하가 "안 겹친다"고 말하는 동안 화면은 겹친다.
 *
 * <ul>
 *   <li>`side` 6 — 좌·우 가장자리 여백.</li>
 *   <li>`top` 34 — 무대 가운데 위를 지나는 배너(`.capBanner`, `top:6px`) 아래 줄.</li>
 *   <li>`topTight` 4 — 링을 피할 다른 방법이 없을 때만 쓰는 윗줄. 배너와 겹칠 수 있지만 배너는
 *       **순간 연출**이고 링은 선택이 유지되는 내내 보여야 한다.</li>
 *   <li>`bottom` 44 — 아랫줄을 잡을 때 무대 하단에 남기는 몫. 과거 전용 시크바(`.controlsSeek`,
 *       `bottom:6px` · 트랙 26 + 패딩 10 = 42) 위 2px 에서 끝난다.</li>
 * </ul>
 *
 * ⚠️ **`topTight + bottom` 이 이 기제의 진짜 예산이다.** 사각지대가 0 이려면
 * `무대높이 − topTight − bottom ≥ 카드높이×2 + (링반경+여유)×2` 여야 한다.
 * 값을 키우면 그 여유가 먼저 없어지고 무대 한가운데에 못 피하는 구멍이 생긴다(격자 계약이 잡는다).
 *
 * <h3>실측 형상 (390×844 폰, Chromium — W7 m-8 재측정)</h3>
 * 무대 **390×253**. 카드는 내용에 따라 다르다 — **내 선수 200×76 · 상대 208×76 · 미상 152×76**
 * (W6 기록 "211×79"·CSS 주석 "280×~120" 은 **스테일**이었다). 예산: 좌변 `253 − 4 − 44 = 205`
 * vs 우변 `76×2 + (7.3+5)×2 = 176.6` → **28px 남는다**(링 반경은 코어가 그린 값 7.3 CSS px).
 *
 * <p>⚠️ **W7 이 안내 문구를 한 줄로 줄인 것은 세로가 아니라 가로를 줄였다** — 내 선수 카드가
 * 234 → **200px**(세로는 76 그대로다. 그 문구는 원래도 한 줄이었고 높이는 머리행이 정한다).
 * 한때 여기 *"76 → 62 로 낮아졌다"* 고 적을 뻔했는데 **재보지 않은 숫자**였다. 예산에 들어가는
 * 것은 세로이므로, 문구를 줄여서 예산이 늘어난 것은 **아니다**.
 *
 * <h3>"시크바를 안 덮는다"는 폭 **≥360** 에서만 참이다 (W7 m-7 · 조정 포인트)</h3>
 * 단일 링 격자 전수(6px 간격) 실측 — **390 침범 0 · 360 침범 0 · 320 침범 64/1716 = 3.7%**.
 * 320 에서는 무대가 208px 로 낮아져 카드 두 장(152)에 링 여유(24.6)를 더하면 예산(160)을 넘는다.
 *
 * <p>**320 을 지원에서 빼지 않는다** — 그 폭에서도 ⓐ 링은 언제나 보이고 ⓑ 카드는 무대 안이며
 * ⓒ 시크바는 카드 아래에서 **계속 조작된다**(`pointer-events:none`, W4 m-6). 즉 320 에서 잃는
 * 것은 기능이 아니라 **자리 예절 하나**이고, 그 거래는 아래 `last` 주석이 선언한 우선순위
 * (링 > 시크바) 그대로다. 그래서 결정은 "폭을 자른다"가 아니라 **"어느 폭에서 어느 성질이
 * 참인지 계약에 적는다"** 이고, 격자 계약이 폭별로 그 값을 박제한다.
 *
 * <p>⚠️ **링이 둘이면 출하 형상(390)에서도 확장 줄이 난다**(예: 세로로 갈라 선 두 링
 * `(195,22)`·`(195,122)` → `left@135` · 카드 밑 211 > 시크바 위 209). 링을 살리려고 시크바를
 * 내주는 그 거래가 실제로 일어나는 자리이고, 단위 계약이 그 표본을 태운다.
 */
export const CARD_INSET = { side: 6, top: 34, topTight: 4, bottom: 44 } as const;

/**
 * 링 바깥으로 더 요구하는 여유(CSS px). 0 이면 "링에 카드가 스치기만 해도 통과"가 되고, 그건
 * 유저 눈으로는 여전히 가려진 것이다.
 */
export const CARD_RING_CLEAR_PX = 5;

/**
 * 더 앞선 자리로 **되돌아갈 때만** 요구하는 추가 여유(CSS px) — 경계에서 선수가 서성이면 카드가
 * 매 폴마다 튀는데, 그게 링을 살짝 가리는 것보다 읽기 나쁘다.
 */
const CARD_HYSTERESIS_PX = 12;

export interface CardRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 그 자리에 앉았을 때 카드가 차지하는 무대 상대 사각. CSS 의 `left|right` + `top` 과 등가. */
export function cardRectOf(place: CardPlacement, stage: BoxSize, card: BoxSize): CardRect {
  const left =
    place.side === "left" ? CARD_INSET.side : stage.width - CARD_INSET.side - card.width;
  return { left, top: place.top, width: card.width, height: card.height };
}

/** 점 → 사각 최단거리(안이면 0). */
function distToRect(p: { x: number; y: number }, r: CardRect): number {
  const dx = Math.max(r.left - p.x, 0, p.x - (r.left + r.width));
  const dy = Math.max(r.top - p.y, 0, p.y - (r.top + r.height));
  return Math.hypot(dx, dy);
}

/** 무대 상대 좌표의 선택 링 하나(반경은 CSS px — `stagePointOf` 의 `scale` 로 옮긴 값). */
export interface RingOnStage {
  x: number;
  y: number;
  r: number;
}

const SIDES: readonly CardPlacement["side"][] = ["left", "right"];

/** 그 자리에서 **가장 아슬아슬한 링**까지 남는 여유(CSS px). 음수 = 그 링 위로 올라탔다. */
function slackOf(rings: readonly RingOnStage[], rect: CardRect): number {
  let worst = Number.POSITIVE_INFINITY;
  for (const ring of rings) {
    const s = distToRect(ring, rect) - Math.max(0, ring.r);
    if (s < worst) worst = s;
  }
  return worst;
}

/**
 * 그 열(side)에서 이 링을 비우려면 **세로로** 얼마나 떨어져야 하나.
 *
 * <p>⚠️ 가로 여유를 무시하면 안 된다 — 카드가 열에 붙어 있어 링이 옆으로 `dx` 만큼 비껴 있으면
 * 필요한 세로는 `√(need² − dx²)` 로 줄어든다. W6 은 이걸 무시하고(게다가 반경을 두 번 세어)
 * `y + r + need` 를 썼는데, 그 줄은 **필요보다 낮아서** 링이 둘일 때 아래쪽 링에 걸린다 —
 * 320×208 격자에서 *비킬 자리가 실제로 있는데 못 찾는* 지점이 61곳이었다(2링 오라클 실측).
 */
function verticalNeed(ring: RingOnStage, rect: CardRect): number {
  const need = Math.max(0, ring.r) + CARD_RING_CLEAR_PX;
  const dx = Math.max(rect.left - ring.x, 0, ring.x - (rect.left + rect.width));
  return dx >= need ? 0 : Math.sqrt(need * need - dx * dx);
}

/**
 * 그 열에서 훑을 윗줄 — **우선순위 순서**. 앞의 것일수록 "평소 자리"다.
 *
 * <p>링 기준 줄은 **링마다** 낸다(아래 / 위). 고정 세 줄만으로는 카드 높이의 두 배가 안 되는
 * 무대에서 구멍이 남고, 링이 둘이면 그 구멍이 훨씬 넓다. 줄이 **열마다 다른** 이유는 위
 * {@link verticalNeed} — 같은 링이라도 어느 열에 붙느냐에 따라 필요한 세로가 다르다.
 *
 * <p>⚠️ **`링아래줄` 은 완전성의 핵심이라 밴드 밖으로 밀려나도 버리지 않는다** — 시크바 줄(`hi`)
 * 아래로 내려가는 몫은 뒤쪽 확장 후보로 따로 담는다(머리말의 완전성 논증). 클램프해서 접으면
 * "자리가 있는데 못 찾는" 상태가 생기고, 그건 아래 폴백과 구별되지 않아 **거짓 폴백**이 된다.
 */
function candidateTops(
  stage: BoxSize,
  card: BoxSize,
  rings: readonly RingOnStage[],
  side: CardPlacement["side"],
): number[] {
  const rect = cardRectOf({ side, top: 0 }, stage, card); // 열이 정하는 것은 left/width 뿐
  const lo = CARD_INSET.topTight;
  const hi = stage.height - CARD_INSET.bottom - card.height;
  /*
   * **바닥 줄** — 무대 맨 아래(시크바 자리를 침범한다).
   *
   * 두 약속의 우선순위가 여기서 갈린다: ⓐ *링을 절대 가리지 않는다*(요구 5-2 그 자체) ⓑ *시크바를
   * 안 덮는다*(자리 예절). 위 후보로 못 피하는 형상이 되면 ⓑ 를 내준다 — 카드는
   * `pointer-events: none` 이라 시크바는 **덮여도 조작된다**(W4 m-6). 링은 가리면 그냥 없어진다.
   *
   * ⚠️ **W6 은 이 줄을 "카드가 자라는 날의 안전망"이라 적고 어떤 표본도 태우지 않았다**(W7 m-1 —
   * 제거해도 격자 전수가 동일했다). 실측으로 다시 쓰면: 시크바 침범은 **확장 줄**(아래 `below` 가
   * `hi` 밑으로 내려간 것)이 대부분 하고, **이 바닥 줄이 실제로 선택되는 것**은 카드가 무대 높이의
   * 절반을 넘는 형상에서 잦다(320×208 · 카드 234×110 격자에서 61곳). 둘 다 단위 계약이 태운다.
   * 출하 카드(200×76)에서 단일 링 침범은 **390·360 은 0 · 320 은 3.7%** 이고, 390 에서도
   * **링이 둘이면** 확장 줄이 난다.
   */
  const last = stage.height - CARD_INSET.side - card.height;

  const below: number[] = [];
  const above: number[] = [];
  for (const ring of rings) {
    const dy = verticalNeed(ring, rect);
    below.push(ring.y + dy);
    above.push(ring.y - dy - card.height);
  }
  const out: number[] = [];
  const push = (t: number, min: number, max: number) => {
    if (!Number.isFinite(t) || t < min || t > max) return;
    if (out.some((u) => Math.abs(u - t) < 0.5)) return;
    out.push(t);
  };
  for (const t of [CARD_INSET.top, hi, lo]) push(t, lo, hi);
  for (const t of below) push(t, lo, hi);
  for (const t of above) push(t, lo, hi);
  // 확장 — 시크바 줄 아래. 완전성을 위해 링아래줄을 마지막 줄까지 캡해서 담는다.
  for (const t of below) push(t, lo, last);
  push(last, lo, last);
  // 무대가 너무 낮아 `hi < lo` 면 위 필터가 전부 걸러진다 — 그때도 자리는 있어야 한다.
  return out.length ? out : [CARD_INSET.top];
}

/**
 * **지금 켜진 링을 하나도 가리지 않는** 자리를 고른다.
 *
 * @param rings 링 **전부**(팀당 1명씩 최대 2개). 하나만 피하면 나머지가 통째로 덮인다 —
 *   그게 W7 BLOCKER-1 이다. 편의상 단일 링·`null` 도 받는다(코어 없는 경로).
 * @param current 지금 앉아 있는 자리(있으면 히스테리시스가 걸린다).
 */
export function pickCardPlacement(
  stage: BoxSize,
  card: BoxSize,
  rings: readonly RingOnStage[] | RingOnStage | null | undefined,
  current?: CardPlacement | null,
): CardPlacement {
  const list = (!rings ? [] : Array.isArray(rings) ? rings : [rings as RingOnStage]).filter(
    (r): r is RingOnStage => !!r && Number.isFinite(r.x) && Number.isFinite(r.y),
  );
  if (!list.length || !(stage.width > 0) || !(stage.height > 0) || !(card.width > 0) || !(card.height > 0)) {
    return current ?? CARD_HOME;
  }
  const slack = (p: CardPlacement) => slackOf(list, cardRectOf(p, stage, card));

  /*
   * 열마다 후보 줄이 다르므로(위 `verticalNeed`) **줄 인덱스로 번갈아** 훑는다 — 앞의 세 줄은
   * 두 열이 같은 값(평소 자리)이라 종전 순서가 그대로 보존되고, 링에서 유도한 줄부터 갈린다.
   */
  const perSide = SIDES.map((side) => candidateTops(stage, card, list, side));
  const order: CardPlacement[] = [];
  for (let i = 0; i < Math.max(...perSide.map((t) => t.length)); i++) {
    for (let s = 0; s < SIDES.length; s++) {
      const top = perSide[s]![i];
      if (top !== undefined) order.push({ side: SIDES[s]!, top });
    }
  }

  // 지금 자리가 아직 어느 링도 안 가린다면 **넉넉히** 나은 곳이 있을 때만 옮긴다(진동 방지).
  if (current && slack(current) >= CARD_RING_CLEAR_PX) {
    for (const p of order) {
      if (samePlacement(p, current)) break;
      if (slack(p) >= CARD_RING_CLEAR_PX + CARD_HYSTERESIS_PX) return p;
    }
    return current;
  }

  let best = order[0]!;
  let bestS = Number.NEGATIVE_INFINITY;
  for (const p of order) {
    const s = slack(p);
    if (s >= CARD_RING_CLEAR_PX) return p;
    if (s > bestS) {
      bestS = s;
      best = p;
    }
  }
  // 자리가 정말 없다 → **가장 덜 가리는 곳**(후보 전체의 최댓값. 단위 계약이 독립 계산으로 확인).
  return best;
}

export function samePlacement(a: CardPlacement, b: CardPlacement): boolean {
  return a.side === b.side && Math.abs(a.top - b.top) < 0.5;
}
