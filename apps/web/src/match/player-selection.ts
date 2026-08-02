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
  if (!(rect.width > 0) || !(rect.height > 0) || !(backingW > 0) || !(backingH > 0)) return null;
  const scale = Math.min(rect.width / backingW, rect.height / backingH);
  if (!(scale > 0)) return null;
  const drawnW = backingW * scale;
  const drawnH = backingH * scale;
  const originX = rect.left + (rect.width - drawnW) / 2;
  const originY = rect.top + (rect.height - drawnH) / 2;
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
