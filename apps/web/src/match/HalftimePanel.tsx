import { useEffect, useMemo, useRef, useState } from "react";
import {
  useDeck,
  useHalftime,
  usePlayers,
  useResume,
  useSubmitMatchPrompt,
  type CatalogPlayer,
  type MatchDetail,
} from "../api/hooks";
import { ErrorToast } from "../common/ErrorToast";
import { DeckEditor } from "../deck/DeckEditor";
import { emptyDraft, type DeckDraft } from "../deck/deck-logic";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "../deck/tactics-logic";
import type { TeamTactics } from "../api/v2";
import { MAX_SUBS, validateSubs, type SubPair } from "./match-logic";
import { countdownLabel } from "./live-clock";
import { useCountdown } from "./useCountdown";
import styles from "./HalftimePanel.module.css";

interface HalftimePanelProps {
  match: MatchDetail;
  /** 폴링 때 잡아둔 서버-클라 시각차(live-clock.captureOffsetMs). */
  clockOffsetMs?: number;
}

/**
 * 감독시간 — **덱 화면과 같은 형식**(이슈 #244, hero 확정 2026-07-28).
 *
 * ── 왜 전용 화면을 만들지 않는가 ───────────────────────────────────────────────────────────
 * hero: *"덱에서 셋팅하던 것과 전후반 사이 차이점은 새로운 선수 배치가 안 된다는 것뿐이잖아.
 * 왜 형식을 다르게 가는 거야? 같이 가야 유저도 안 헷갈리지."*
 * 그래서 이 패널은 **덱 화면과 같은 `DeckEditor`** 를 그대로 쓴다. 차이는 플래그 둘뿐이다:
 *   · `placementLocked` — 빈 자리 탭·보유 선수 시트·Auto·초기화·자리 바꾸기·제거가 없다.
 *   · `subsMode` + 교체 요약/모드 탭 — 덱에 없는 **유일한 추가 요소**.
 * (구현 초기엔 감독시간 전용 레이아웃을 따로 만들었는데, 같은 입력이 화면마다 다르게 생기고
 *  프롬프트 블록이 복제돼 드리프트 위험이 생겼다 → 폐기하고 이 구조로 통합.)
 *
 * ── 값이 가는 곳은 덱과 다르다 (중요) ──────────────────────────────────────────────────────
 * 화면은 같아도 **감독시간 입력은 덱을 건드리지 않는다**: 여기서 쓴 문장은 `POST /prompts`
 * (phase=halftime, scope=team|player)로만 가고 `PUT /api/deck` 은 호출하지 않는다. 그래서
 * 에디터 상태를 **로컬 사본**으로 들고(초기값 = 현재 덱), 제출할 때 원본과 달라진 선수만 골라
 * 후반 지시로 보낸다.
 *
 * 팀 전술(라인·압박·템포·폭)은 **후반에도 바꿀 수 있다**(#254 hero 결정 "허용", 서버 V24).
 * 덱 화면과 **같은 ⚙ 자리**를 쓰고, 시작점은 전반 값이며, 만진 경우에만 `POST /halftime` 에 실린다.
 *
 * NOTE: match GET 응답에는 내 로스터가 없어(openapi MatchDetail — opponent만) 선발/벤치를
 * useDeck에서 파생한다. 전반 중 퇴장 등 엔진 내 로스터 변화는 반영 못함 — 서버(AC-M4)가 최종 검증.
 */
export function HalftimePanel({ match, clockOffsetMs = 0 }: HalftimePanelProps) {
  const { data: deck, isError: deckError } = useDeck();
  const { data: players, isError: playersError } = usePlayers();
  const submitPrompt = useSubmitMatchPrompt(match.id);
  const halftime = useHalftime(match.id);
  const resume = useResume(match.id);

  // 감독시간 카운트다운(P4-D2). 0 이 되면 서버가 후반을 자동 시작하므로 화면도 **입력까지** 닫는다 —
  // 눌러봐야 409 가 오는 버튼만 막으면 "냈는데 안 들어갔다"는 오해가 그대로 남는다(#244 검증 지적).
  const remaining = useCountdown(match.clock ?? null, clockOffsetMs);
  const deadlineLabel = countdownLabel(remaining);
  /** 남은 비율(1→0) — 헤더 배너 대신 **줄어드는 앰버 바**가 시간을 말한다(#244 재설계). */
  const remainPct = (() => {
    const total = match.clock?.halftimeMs ?? 0;
    if (!total || remaining == null) return 0;
    return Math.max(0, Math.min(1, remaining / total));
  })();
  const expired = remaining != null && remaining <= 0;

  const [subs, setSubs] = useState<SubPair[]>([]);
  /** 하단 모드 탭 — 기본은 프롬프트("감독의 한마디"). 교체 탭은 **보드의 모드**를 바꾼다(T2). */
  const [mode, setMode] = useState<"say" | "sub">("say");
  const [pendingOut, setPendingOut] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** 덱 사본 — 여기서의 편집은 덱에 저장되지 않는다(위 주석). */
  const [editor, setEditor] = useState<EditorState | null>(null);
  /** 전술을 실제로 만졌는가 — 안 만졌으면 후반 지시에 싣지 않는다(서버가 전반 값을 유지). */
  const [tacticsTouched, setTacticsTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);
  const ownedPlayers = useMemo(() => (players ?? []).filter((p) => p.owned), [players]);

  /** 전반 종료 시점의 라인업 = 초기값. per-player 프롬프트는 **빈 칸에서 시작**한다(후반 지시). */
  const baseDraft: DeckDraft = useMemo(() => {
    if (!deck) return emptyDraft();
    return {
      formation: deck.formation,
      slots: deck.slots.map((s) => ({
        playerId: s.playerId,
        role: s.role,
        slotIndex: s.slotIndex,
        promptText: null,
      })),
    };
  }, [deck]);

  /**
   * 전술의 시작점은 **전반에 쓰던 값**이다(#254). 기본값에서 시작하면 유저가 안 건드린 축까지
   * 후반에 조용히 바뀐다 — 화면이 "지금 값"을 보여주고, 바꾼 것만 서버로 간다.
   */
  const firstHalfTactics: TeamTactics = match.userDeckSnapshot?.teamTactics ?? DEFAULT_TEAM_TACTICS;
  useEffect(() => {
    if (editor === null && deck) {
      setEditor({ draft: baseDraft, tactics: { ...firstHalfTactics }, teamPrompt: "" });
    }
  }, [editor, deck, baseDraft, firstHalfTactics]);

  const nameOf = (id: string) => playersById.get(id)?.name ?? id;
  const posOf = (id: string) => playersById.get(id)?.position;

  const starters = useMemo(
    () => (deck?.slots ?? []).filter((s) => s.role === "starter").map((s) => s.playerId),
    [deck],
  );
  const bench = useMemo(
    () => (deck?.slots ?? []).filter((s) => s.role === "bench").map((s) => s.playerId),
    [deck],
  );
  const usedOuts = new Set(subs.map((s) => s.out));
  const usedIns = new Set(subs.map((s) => s.in));
  const currentIssues = validateSubs(subs, starters, bench, posOf);
  const atLimit = subs.length >= MAX_SUBS;
  const benchAvailable = bench.filter((id) => !usedIns.has(id));

  /**
   * 교체 모드로 들어가면 벤치 줄(87px)이 펴져 프롬프트가 패널 fold 아래로 조금 밀린다.
   * 덱 화면과 **같은 규칙**으로 푼다 — "고르면 화면이 그 자리까지 따라온다"(#244 A′).
   * 화면별 레이아웃 예외를 만드는 대신 이미 쓰는 동작을 재사용한다.
   */
  useEffect(() => {
    if (mode !== "sub") return;
    panelRef.current
      ?.querySelector('[data-testid="editor-team-prompt"], [data-testid="rail-prompt-input"]')
      ?.scrollIntoView?.({ block: "end", behavior: "smooth" });
    // ⚠️ 모드 전환뿐 아니라 **교체를 등록할 때마다** 다시 맞춘다 — 칩 줄이 한 줄 생기면 그만큼
    //    프롬프트가 다시 하단 토글바 밑으로 밀린다(실화면 확인: hit=stage-toggle-log).
  }, [mode, subs.length]);

  /** 교체 지정 — 보드 탭을 DeckEditor 가 그대로 넘겨준다(규칙·전송은 이 패널 소유). */
  function handleSubTap(playerId: string, role: "starter" | "bench") {
    if (expired) return;
    if (role === "starter") {
      if (usedOuts.has(playerId)) {
        // 무음으로 무시하면 "왜 안 되지"가 된다 — 이미 뺀 선수라는 걸 말해준다(3차 검증 m3).
        setNote(`${nameOf(playerId)} 는 이미 교체로 빠집니다 — 취소하려면 위 칩의 × 를 누르세요`);
        return;
      }
      if (atLimit) {
        setNote(`교체 한도(${MAX_SUBS}명)에 도달했습니다`);
        return;
      }
      if (benchAvailable.length === 0) {
        setNote("벤치에 넣을 수 있는 선수가 없습니다 — 교체할 수 없습니다");
        return;
      }
      setPendingOut((cur) => (cur === playerId ? null : playerId));
      setNote(null);
      return;
    }
    // 벤치 = 넣을 선수
    if (!pendingOut) {
      setNote("먼저 보드에서 뺄 선수를 누르세요");
      return;
    }
    if (usedIns.has(playerId)) {
      setNote(`${nameOf(playerId)} 는 이미 교체로 들어갑니다`);
      return;
    }
    const pair = { out: pendingOut, in: playerId };
    const issues = validateSubs([...subs, pair], starters, bench, posOf);
    if (issues.some((i) => i.rule !== "GK_REQUIRED")) {
      setNote(issues[0]?.message ?? "이 조합으로는 교체할 수 없습니다");
      return;
    }
    setSubs((prev) => [...prev, pair]);
    setNote(`${nameOf(pendingOut)} → ${nameOf(playerId)} 교체 등록 (${subs.length + 1}/${MAX_SUBS})`);
    setPendingOut(null);
  }

  async function handleResume() {
    setError(null);
    setSubmitting(true);
    try {
      const teamPrompt = editor?.teamPrompt.trim() ?? "";
      if (teamPrompt) {
        await submitPrompt.mutateAsync({ phase: "halftime", scope: "team", text: teamPrompt });
      }
      // 후반 선수 지시 = 이 화면에서 새로 쓴 문장만(덱에는 쓰지 않는다).
      for (const slot of editor?.draft.slots ?? []) {
        const text = slot.promptText?.trim();
        if (text) {
          await submitPrompt.mutateAsync({
            phase: "halftime", scope: "player", playerId: slot.playerId, text,
          });
        }
      }
      await halftime.mutateAsync(
        tacticsTouched && editor ? { substitutions: subs, teamTactics: editor.tactics } : { substitutions: subs },
      );
      await resume.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "후반 시작에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  const written = (editor?.draft.slots ?? []).filter((s) => s.promptText?.trim()).length;

  /** 보드 위 줄: 카운트다운 · 교체 요약 · 모드 탭 — 덱에 없는 **감독시간만의 추가분**. */
  const boardHeader = (
    <div className={styles.head}>
      {deadlineLabel && (
        /*
         * #244 재설계: 예전엔 두 줄짜리 안내 배너(54px)가 화면 위쪽을 차지했다. 남은 시간은
         * **줄어드는 앰버 바**가 말하고, 글자는 "감독시간 0:46" 한 조각만 남긴다.
         * (만료 문구 "감독시간 종료" 는 계약 AC11 이 재는 값이라 그대로 둔다.)
         */
        <p
          className={`${styles.deadline} ${expired ? styles.deadlineOver : ""}`}
          data-testid="halftime-countdown"
        >
          <b className={styles.deadlineTime}>
            {expired ? "감독시간 종료" : `감독시간 ${deadlineLabel}`}
          </b>
          <span className={styles.deadlineHint}>
            {expired ? "전반 지시 그대로 진행됩니다" : "지나면 전반 지시로 시작됩니다"}
          </span>
          <span className={styles.deadlineBar} aria-hidden="true">
            <i style={{ width: `${Math.round(remainPct * 100)}%` }} />
          </span>
        </p>
      )}
      <div className={styles.subsBar} data-testid="halftime-subs-bar">
        {subs.map((s, i) => (
          <span key={`${s.out}-${s.in}`} className={styles.subChip} data-testid={`sub-chip-${i}`}>
            {nameOf(s.out)} → {nameOf(s.in)}
            <button
              type="button"
              className={styles.subChipX}
              data-testid={`sub-remove-${i}`}
              aria-label={`${nameOf(s.out)} 교체 취소`}
              disabled={expired}
              onClick={() => setSubs((prev) => prev.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className={styles.modeTabs} role="tablist" aria-label="감독시간 모드">
        {(["say", "sub"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? styles.modeTabActive : styles.modeTab}
            data-testid={`halftime-mode-${m}`}
            disabled={expired}
            onClick={() => {
              setMode(m);
              setPendingOut(null);
              setNote(null);
            }}
          >
            {m === "say" ? "감독의 한마디" : `교체 ${subs.length}/${MAX_SUBS}`}
          </button>
        ))}
      </div>
    </div>
  );

  const railNote = (
    <>
      {mode === "sub" && (
        <p className={styles.swapGuide} data-testid="halftime-swap-guide">
          {pendingOut
            ? `${nameOf(pendingOut)}(${posOf(pendingOut) ?? "?"}) 를 뺀다 — 보드의 벤치 줄에서 넣을 선수를 누르세요`
            : benchAvailable.length === 0
              ? "벤치가 비어 있어 교체할 수 없습니다"
              : "보드에서 뺄 선수를 누르세요 · 교체해도 그 선수 지시는 따라갑니다"}
        </p>
      )}
      {note && (
        <p className={styles.note} data-testid="halftime-note">
          {note}
        </p>
      )}
      {currentIssues.map((issue) => (
        <p key={issue.rule} className={styles.issue} data-testid={`sub-issue-${issue.rule}`}>
          {issue.message}
        </p>
      ))}
      <p className={styles.writtenNote} data-testid="halftime-written-count">
        후반 선수 지시 {written}명
      </p>
    </>
  );

  return (
    <div ref={panelRef} className={styles.panel} data-testid="halftime-panel">
      {editor && (
        <DeckEditor
          state={editor}
          onChange={(next) => {
            if (editor && next.tactics !== editor.tactics) setTacticsTouched(true);
            setEditor(next);
          }}
          aiManaged={false}
          onToggleAi={() => {}}
          players={ownedPlayers}
          playersById={playersById}
          conditions={match.conditions}
          /* 감독시간의 두 가지 차이 — 나머지는 덱 화면과 완전히 같다. */
          placementLocked
          subsMode={mode === "sub"}
          onSubTap={handleSubTap}
          subbedOut={subs.map((s) => s.out)}
          pendingOut={pendingOut}
          hideBench
          boardHeader={boardHeader}
          railNote={railNote}
          promptDisabled={expired}
          promptScope="halftime"
        />
      )}

      {(deckError || playersError) && (
        <ErrorToast message="내 로스터를 불러오지 못했습니다 — 새로고침 후 다시 시도하세요" />
      )}
      <ErrorToast message={error} onDismiss={() => setError(null)} />

      <button
        type="button"
        className={styles.resume}
        data-testid="resume-button"
        disabled={submitting || expired || currentIssues.length > 0 || deckError || playersError}
        onClick={handleResume}
      >
        {submitting ? "전송 중…" : expired ? "후반 시작됨" : "후반 시작"}
      </button>
    </div>
  );
}
