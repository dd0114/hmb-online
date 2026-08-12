import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiError } from "../api/client";
import { useCreateMatch } from "../api/hooks";
import { practiceError } from "../game/game-logic";
import { matchInProgressIdOf } from "./match-lock";

/** `useDecklessGuard()` 가 돌려주는 것 중 **이 훅이 쓰는 부분만**(dialog 는 호출부가 그린다). */
export interface PracticeGuard {
  guard(): boolean;
  catchReject(err: unknown): boolean;
}

/**
 * 연습경기 시작 — **매치를 만드는 한 경로** (#493 W5).
 *
 * 예전엔 `GamePage.startPractice` 안에만 있었다. W5 가 홈 [게임 시작]에 튜토리얼 제안 모달을
 * 붙이면서 **두 번째 호출부**가 생겼고, 그때 로직을 베끼면 409(이어하기)·L3(서버 덱 거부)
 * 처리가 한쪽에서만 낡는다 — `useDecklessGuard` 가 세 화면을 하나로 묶은 것과 같은 이유로
 * 여기도 하나만 둔다.
 *
 * 규율은 그대로 옮겨 왔다:
 *  · 만들기 **전에** `guard()` — 덱 없는 유저는 시작조차 하지 않는다.
 *  · 409 는 실패가 아니라 **이어가라는 안내**다(#217) — 그 매치로 보낸다.
 *  · 서버가 "덱이 없다"고 거부하면(L3) 토스트가 아니라 같은 안내로 흡수한다.
 */
export function usePracticeStart(deckless: PracticeGuard) {
  const navigate = useNavigate();
  const createMatch = useCreateMatch();
  const [error, setError] = useState<string | null>(null);

  return {
    /** 눌렀다. 가드에 걸리면 아무 일도 일어나지 않는다(가드가 자기 화면을 띄운다). */
    start(onSettled?: () => void) {
      if (!deckless.guard()) {
        onSettled?.();
        return;
      }
      setError(null);
      createMatch.mutate(
        {},
        {
          onSuccess: (match) => navigate(`/match/${match.id}`),
          onError: (err) => {
            // #217: 409 는 실패가 아니라 **이어가라는 안내**다. 문구만 띄우면 막다른 길이 된다.
            const resumeId = matchInProgressIdOf(err);
            if (resumeId) {
              navigate(`/match/${resumeId}`);
              return;
            }
            // L3 — 서버가 "덱이 없다"고 거부했다. 에러 토스트로 끝내면 막다른 길이다.
            if (deckless.catchReject(err)) {
              onSettled?.();
              return;
            }
            setError(practiceError(err as ApiError | Error));
            onSettled?.();
          },
        },
      );
    },
    isPending: createMatch.isPending,
    error,
    dismissError: () => setError(null),
  };
}
