/**
 * 로비 팝업 **큐** (#248 §4 — #245 원정 리포트와의 조율).
 *
 * 문제: 로비에 팝업을 얹는 세션이 각자 자기 조건만 들고 있으면, 트리거가 한 번 바뀌는 순간
 * 조용히 겹친다(#245 는 이미 한 번 [게임 시작] 시점으로 옮겼다). 그래서 "**동시에 하나만
 * 열린다**"를 화면이 아니라 **여기 한 곳**에서 강제한다.
 *
 * 로비에 팝업을 추가하는 사람은 이 배열에만 등록하면 된다.
 */

/**
 * 우선순위 — 앞이 이긴다.
 *
 * **공지 우선**(hero Q4): 공지는 점검·사고 안내라 시급하고, 원정은 [게임 시작] 흐름을 잇는
 * 성격이라 한 박자 뒤여도 맥락이 유지된다(공지 닫기 → CTA 다시 누름 → 원정 팝업).
 *
 * ⚠️ `"away"` 는 **미배선**이다 — main 에는 아직 원정 팝업(#245)이 없다. #245 가 머지되면
 * `LobbyPage` 에서 `pickLobbyPopup({ notice: …, away: shouldShowAwayPopup(data) })` 로 한 줄만
 * 붙이면 된다(그쪽 세션은 추가 작업 없음 — #248 §4 "머지 순서 합의" 3항).
 */
export const LOBBY_POPUP_PRIORITY = ["notice", "away"] as const;

export type LobbyPopupKind = (typeof LOBBY_POPUP_PRIORITY)[number];

/**
 * 열 준비가 된 팝업 중 **하나**를 고른다. 아무것도 준비되지 않았으면 null.
 * 등록되지 않은 종류는 무시한다 — 우선순위 배열이 유일한 SoT 다.
 */
export function pickLobbyPopup(
  ready: Partial<Record<LobbyPopupKind, boolean>>,
): LobbyPopupKind | null {
  for (const kind of LOBBY_POPUP_PRIORITY) {
    if (ready[kind]) return kind;
  }
  return null;
}
