import { useState } from "react";
import { usePlayers, useDeck } from "../api/hooks";
import { DecklessDialog } from "./DecklessDialog";
import { deckMissing, isDeckRequiredError } from "./deckless";

/**
 * 덱 없는 유저 가드 — **매치를 만드는 모든 화면이 공유한다** (#286 W3.5).
 *
 * ⚠️ **처음엔 게임 탭의 연습 경로에만 배선했다가 독립검증에 잡혔다(MAJ-2).** `/league`·`/away`
 * 는 북마크·뒤로가기로 직접 들어올 수 있고, 거기서 매치를 만들면 서버가 거부하는데 화면은
 * 막다른 토스트 한 줄로 끝났다. 가드가 한 화면에만 있으면 나머지는 **조용히 예전 상태**다.
 *
 * 그래서 판정·상태·화면을 훅 하나로 묶어 배선을 잊기 어렵게 만든다. 새로 매치를 만드는
 * 버튼을 추가하면 `guard()` 를 앞에, `catchReject(err)` 를 `onError` 앞에 두고 `dialog` 를
 * 렌더하면 끝이다(#217 의 `matchInProgressIdOf` 와 같은 규율).
 */
export function useDecklessGuard() {
  const { data: deck } = useDeck();
  const { data: players } = usePlayers();
  const [open, setOpen] = useState(false);

  // ⚠️ 미도착 카탈로그를 0 으로 읽지 않는다 — "현재 0/11명입니다"라는 틀린 숫자가 뜬다.
  const ownedCount = Array.isArray(players) ? players.filter((p) => p.owned).length : null;

  return {
    /** 매치를 만들기 **전에** 부른다. `false` 면 아무것도 시작하지 않는다. */
    guard(): boolean {
      if (deckMissing(deck)) {
        setOpen(true);
        return false;
      }
      return true;
    },
    /**
     * 서버 거부를 흡수했는가 — `onError` 맨 앞에서 부르고 `true` 면 그대로 반환한다.
     * 클라 가드는 진실이 아니다(다른 탭에서 덱을 지우는 경합이 실재한다).
     */
    catchReject(err: unknown): boolean {
      if (isDeckRequiredError(err)) {
        setOpen(true);
        return true;
      }
      return false;
    },
    dialog: open ? (
      <DecklessDialog ownedCount={ownedCount} onClose={() => setOpen(false)} />
    ) : null,
  };
}
