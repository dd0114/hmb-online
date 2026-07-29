import { useCallback, useEffect, useRef, useState } from "react";
import { useSubmitMatchPrompt } from "../api/hooks";
import {
  draftTextOf,
  emptyHalftimeDraft,
  pendingSaves,
  readHalftimeDraft,
  withDraftText,
  withSent,
  writeHalftimeDraft,
  type HalftimeDraft,
  type PromptTarget,
} from "./halftime-draft";

/**
 * 타이핑이 멎고 나서 저장까지의 대기 (#284 hero 확정 C — 버튼 없는 자동 저장).
 * 짧으면 글자마다 POST 가 나가고, 길면 "적자마자 탭을 닫는" 흐름에서 놓친다.
 */
const AUTOSAVE_DELAY_MS = 800;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface HalftimeDraftHandle {
  draft: HalftimeDraft;
  status: SaveStatus;
  error: string | null;
  /** 타이핑 반영 — 저장은 이 훅이 알아서 한다(호출부에 저장 버튼이 없다). */
  setText: (target: PromptTarget, text: string) => void;
  /** 남은 초안을 지금 전부 보낸다(감독시간 [후반 시작] 직전). 실패하면 throw. */
  flush: () => Promise<void>;
  /** 이 대상이 서버로 갔다고 기록 — 감독시간이 자기 경로로 보냈을 때. */
  markSent: (target: PromptTarget, text: string) => void;
}

/**
 * 후반 지시 **미리작성 초안 + 자동 저장** (#284).
 *
 * ── 왜 버튼이 아니라 자동인가 (hero 결정 C) ────────────────────────────────────────────────
 * hero 는 "감독시간이 끝날 때 알아서 저장되게 하면 미리 보낼 필요 없지 않냐"고 제안했다. 의도는
 * 맞지만 **그 시점에 저장할 주체가 없다**: 감독시간 만료는 서버 이벤트이고(`MatchClockSweeper` —
 * *"아무도 보고 있지 않은 매치도 … 후반 시뮬로 넘어간다"*, `sweep-interval-ms: 1000`), 탭이 닫혀
 * 있으면 아무 일도 안 일어나며, 열려 있어도 전이 후 도착한 저장은 **409**(허용 상태 = FIRST_HALF·
 * HALFTIME). 그래서 **유저가 확실히 화면에 있는 동안**(=타이핑 직후) 보낸다. 유저 체감은 같다 —
 * 아무 버튼도 안 누른다.
 *
 * ⚠️ **저장 실패를 화면에서 지우지 마라.** 자동 저장은 조용해서, 실패까지 조용하면 유저는 적어둔
 * 것이 서버에 있다고 믿은 채 감독시간을 놓친다. `status`/`error` 를 호출부가 반드시 그린다.
 */
export function useHalftimeDraft(matchId: string): HalftimeDraftHandle {
  const submitPrompt = useSubmitMatchPrompt(matchId);
  const [draft, setDraft] = useState<HalftimeDraft>(() => readHalftimeDraft(matchId));
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // 매치가 바뀌면 그 매치의 초안으로 갈아탄다(같은 셸이 재사용되는 경로 방어).
  useEffect(() => {
    setDraft(readHalftimeDraft(matchId));
    setStatus("idle");
    setError(null);
  }, [matchId]);

  /**
   * 저장 루프가 보는 **최신 초안**. state 를 클로저로 잡으면 디바운스 타이머가 한 박자 낡은 값을
   * 보낸다(마지막 글자가 빠진 문장이 서버로 간다).
   */
  const latest = useRef(draft);
  latest.current = draft;
  /** 동시 저장 방지 — 두 타이머가 겹치면 같은 대상을 두 번 POST 한다. */
  const inflight = useRef(false);

  const persist = useCallback(
    (next: HalftimeDraft) => {
      latest.current = next;
      writeHalftimeDraft(matchId, next);
      setDraft(next);
    },
    [matchId],
  );

  /** 남은 것을 순서대로 보낸다. 하나라도 실패하면 그 자리에서 멈춘다(뒤엣것은 다음 기회에). */
  const drain = useCallback(async () => {
    if (inflight.current) return;
    const queue = pendingSaves(latest.current);
    if (queue.length === 0) return;
    inflight.current = true;
    setStatus("saving");
    try {
      for (const { target } of queue) {
        // 큐를 만든 뒤 유저가 더 쳤을 수 있다 — **지금 화면의 문장**을 보낸다(큐에 담긴 값이 아니라).
        // 그 사이 비웠으면 보낼 게 없다(빈 문자열은 서버가 400 으로 막는다).
        const now = draftTextOf(latest.current, target).trim();
        if (!now) continue;
        await submitPrompt.mutateAsync(
          target === null
            ? { phase: "halftime", scope: "team", text: now }
            : { phase: "halftime", scope: "player", playerId: target, text: now },
        );
        persist(withSent(latest.current, target, now));
      }
      setError(null);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다");
      setStatus("error");
      throw err;
    } finally {
      inflight.current = false;
    }
  }, [persist, submitPrompt]);

  // 디바운스 — 타이핑이 멎으면 보낸다. 실패는 `drain` 이 상태에 남기므로 여기선 삼킨다
  // (타이머에서 던지면 처리할 곳이 없다 — unhandled rejection).
  const timer = useRef<number | null>(null);
  const schedule = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void drain().catch(() => {});
    }, AUTOSAVE_DELAY_MS);
  }, [drain]);

  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);

  const setText = useCallback(
    (target: PromptTarget, text: string) => {
      persist(withDraftText(latest.current, target, text));
      setStatus("idle");
      schedule();
    },
    [persist, schedule],
  );

  const flush = useCallback(async () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    await drain();
  }, [drain]);

  const markSent = useCallback(
    (target: PromptTarget, text: string) => persist(withSent(latest.current, target, text)),
    [persist],
  );

  return { draft, status, error, setText, flush, markSent };
}

export { emptyHalftimeDraft };
