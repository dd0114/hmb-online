import { useEffect, useMemo, useRef, useState } from "react";
import {
  useDeck,
  useHalftime,
  usePlayers,
  useResume,
  type CatalogPlayer,
  type MatchDetail,
} from "../api/hooks";
import { ErrorToast } from "../common/ErrorToast";
import { DeckEditor } from "../deck/DeckEditor";
import { emptyDraft, type DeckDraft } from "../deck/deck-logic";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "../deck/tactics-logic";
import type { TeamTactics } from "../api/v2";
import { MAX_SUBS, validateSubs, type SubPair } from "./match-logic";
import { boardUsable, halftimeShapePayload, snapshotToDraft, swapStarters } from "./halftime-shape";
import { applyDraftPrompts, clearedAfterSave } from "./halftime-draft";
import type { HalftimeDraftHandle } from "./useHalftimeDraft";
import { countdownLabel } from "./live-clock";
import { useCountdown } from "./useCountdown";
import styles from "./HalftimePanel.module.css";

interface HalftimePanelProps {
  match: MatchDetail;
  /** 폴링 때 잡아둔 서버-클라 시각차(live-clock.captureOffsetMs). */
  clockOffsetMs?: number;
  /** 셸이 소유하는 후반 지시 초안 — 전반의 `후반 지시` 탭과 **같은 것**을 본다(#284). */
  draft: HalftimeDraftHandle;
}

/**
 * 감독시간 — **덱 화면과 같은 형식**(이슈 #244, hero 확정 2026-07-28).
 *
 * ── 왜 전용 화면을 만들지 않는가 ───────────────────────────────────────────────────────────
 * hero: *"덱에서 셋팅하던 것과 전후반 사이 차이점은 새로운 선수 배치가 안 된다는 것뿐이잖아.
 * 왜 형식을 다르게 가는 거야? 같이 가야 유저도 안 헷갈리지."*
 * 그래서 이 패널은 **덱 화면과 같은 `DeckEditor`** 를 그대로 쓴다. 차이는 플래그뿐이다:
 *   · `placementLocked` — 빈 자리 탭·보유 선수 시트·Auto·초기화·제거가 없다
 *     (= **스쿼드 밖에서 선수를 데려오지 않는다**. #244 는 여기에 "자리 바꾸기가 없다"까지
 *      묶어 뒀지만 #276 hero 결정으로 그 전제가 뒤집혔다 — 아래 참조).
 *   · `lineupEditable` — **포메이션 변경 + 선발끼리 자리 바꾸기**를 연다(#276).
 *   · `boardMode`(교체/자리) + 교체 요약/모드 탭 — 덱에 없는 **추가 요소**.
 * (구현 초기엔 감독시간 전용 레이아웃을 따로 만들었는데, 같은 입력이 화면마다 다르게 생기고
 *  프롬프트 블록이 복제돼 드리프트 위험이 생겼다 → 폐기하고 이 구조로 통합.)
 *
 * ── 배치는 감독시간에도 바꾼다 (#276, hero 결정) ─────────────────────────────────────────
 * *"덱구성이랑 비슷하게 사용할수있도록 유지해서 가져가. 중요한건 통일성이야."* → 포메이션 문자열만이
 * 아니라 **슬롯 재배치까지** 바꾼다(덱 화면이 그렇게 동작하므로). 못 바꾸는 것은 **경기 스쿼드 밖**
 * 선수를 데려오는 것뿐이라, 잠금을 두 축으로 쪼갰다(`placementLocked` vs `lineupEditable`).
 * 통째로 풀면 보유 선수 시트가 열려 후반에 스쿼드 밖 선수를 세울 수 있게 된다 — 서버는 400 으로
 * 막지만 **화면이 거짓말을 한다**.
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
 * ── 라인업의 시작점 = `match.userDeckSnapshot` (취향이 아니라 서버 계약) ────────────────────
 * #244 는 선발/벤치를 `useDeck()`(**현재 덱**)에서 파생했다. 하지만 서버는 `starters` 를 **매치
 * 스냅샷의 전반 선발 − out + in** 과 대조하므로(`MatchService` ROSTER_MISMATCH), 전반 시작 후
 * 유저가 덱을 고쳤으면 둘이 달라 **400** 이 난다. 그래서 배치를 보내는 경로의 기준은 반드시
 * 스냅샷이다. 스냅샷이 없거나 선발이 11명이 아닌 구 매치(`boardUsable` false)는 배치 필드를 **아예
 * 보내지 않고** #244 의 현행 동작(덱 파생 + 교체만)을 그대로 유지한다 — 기능 소실 금지.
 *
 * ── 프롬프트 칸은 **비어 있지 않다** (#284) ────────────────────────────────────────────────
 * 전반 관전 중 `후반 지시` 탭에서 미리 적어둔 팀·선수 문장이 그대로 채워진 채 열린다(hero 요구:
 * *"미리 적어둔 내용이 감독시간 화면에 그대로 남아 이어서 확정할 수 있어야 한다(다시 타이핑 금지)"*).
 * 원천은 셸이 소유하는 `draft`(로컬 초안 + 서버 자동 저장 2층 — `halftime-draft.ts` 헤더).
 * ⚠️ 프리필은 **playerId** 로 붙는다(슬롯이 아니라) — #276 이 자리 바꾸기를 열었으므로 슬롯 인덱스는
 * 움직인다. 사람에게 한 말이 자리를 따라가면 안 된다.
 */
export function HalftimePanel({ match, clockOffsetMs = 0, draft }: HalftimePanelProps) {
  const { data: deck, isError: deckError } = useDeck();
  const { data: players, isError: playersError } = usePlayers();
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
  /**
   * 하단 모드 탭 — 기본은 프롬프트("감독의 한마디"). 교체·자리 탭은 **보드의 모드**를 바꾼다
   * (T2 / #276). 두 보드 모드는 **같은 두 번 탭 제스처**다: 첫 탭이 대상, 두 번째 탭이 상대.
   */
  const [mode, setMode] = useState<"say" | "sub" | "move">("say");
  const [pendingOut, setPendingOut] = useState<string | null>(null);
  /** 자리 바꾸기에서 먼저 고른 선발. */
  const [pendingMove, setPendingMove] = useState<string | null>(null);
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

  /**
   * **배치를 보낼 수 있는 매치인가**(#276). true 면 라인업의 기준이 매치 스냅샷이고 `/halftime` 에
   * `formation`+`starters` 를 싣는다. false(구 매치)면 #244 현행 동작 그대로 — 덱 파생 + 교체만.
   */
  const snapshot = match.userDeckSnapshot;
  const shapeMode = boardUsable(snapshot);

  /**
   * 전반 종료 시점의 라인업 = 초기값.
   * per-player 프롬프트는 **덱의 사전 지시가 아니라** 후반 초안에서 온다(#284) — 덱 문장을 끌고 오면
   * 유저가 안 쓴 후반 지시가 저절로 생긴다. 초안이 비어 있으면 예전처럼 빈 칸이다.
   */
  const baseDraft: DeckDraft = useMemo(() => {
    // 배치를 보내는 경로의 기준은 **매치 스냅샷**이다(위 주석 — 서버 ROSTER_MISMATCH 계약).
    if (shapeMode) return snapshotToDraft(snapshot!);
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
  }, [deck, shapeMode, snapshot]);

  /**
   * 전술의 시작점은 **전반에 쓰던 값**이다(#254). 기본값에서 시작하면 유저가 안 건드린 축까지
   * 후반에 조용히 바뀐다 — 화면이 "지금 값"을 보여주고, 바꾼 것만 서버로 간다.
   */
  const firstHalfTactics: TeamTactics = snapshot?.teamTactics ?? DEFAULT_TEAM_TACTICS;
  useEffect(() => {
    // 스냅샷 경로는 덱을 기다릴 이유가 없다(라인업이 이미 매치 응답 안에 있다).
    if (editor === null && (shapeMode || deck)) {
      // #284: 전반에 미리 적어둔 문장으로 **채워서** 연다(빈 칸이 아니다). 초안이 비었으면 예전과 같다.
      setEditor({
        draft: applyDraftPrompts(baseDraft, draft.draft),
        tactics: { ...firstHalfTactics },
        teamPrompt: draft.draft.cur.team,
      });
    }
  }, [editor, deck, shapeMode, baseDraft, firstHalfTactics, draft.draft]);

  const nameOf = (id: string) => playersById.get(id)?.name ?? id;
  const posOf = (id: string) => playersById.get(id)?.position;

  /**
   * 교체 규칙(≤3 · out∈선발 · in∈벤치 · GK≥1)이 보는 로스터는 **전반 라인업**이다 — 자리를 바꿔도
   * 집합은 그대로이므로 `baseDraft` 기준이면 충분하고, 서버가 대조하는 기준과도 같아진다.
   */
  const starters = useMemo(
    () => baseDraft.slots.filter((s) => s.role === "starter").map((s) => s.playerId),
    [baseDraft],
  );
  const bench = useMemo(
    () => baseDraft.slots.filter((s) => s.role === "bench").map((s) => s.playerId),
    [baseDraft],
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

  /** 보드 탭 — DeckEditor 가 그대로 넘겨준다(규칙·전송은 이 패널 소유). 모드별로 갈린다. */
  function handleBoardTap(playerId: string, role: "starter" | "bench") {
    if (mode === "move") return handleMoveTap(playerId, role);
    handleSubTap(playerId, role);
  }

  /**
   * 자리 바꾸기(#276) — 교체와 **같은 두 번 탭**: 첫 탭이 옮길 선수, 두 번째 탭이 자리를 내줄 선수.
   * **선발끼리만**이다. 벤치는 이 모드에서 아예 접혀 있고(넣을 선수를 고를 일이 없다) 벤치 ↔ 선발은
   * 교체라 규칙(≤3·GK≥1)을 가진 교체 모드가 소유한다 — 같은 일을 하는 손잡이를 두 개 만들지 않는다.
   */
  function handleMoveTap(playerId: string, role: "starter" | "bench") {
    if (expired || !shapeMode || !editor) return;
    if (role !== "starter") return;
    if (!pendingMove) {
      setPendingMove(playerId);
      setNote(null);
      return;
    }
    if (pendingMove === playerId) {
      setPendingMove(null);
      return;
    }
    setEditor({ ...editor, draft: swapStarters(editor.draft, pendingMove, playerId) });
    setNote(`${nameOf(pendingMove)} ↔ ${nameOf(playerId)} 자리를 바꿨습니다`);
    setPendingMove(null);
  }

  /** 교체 지정(#244) — 확정 교체는 `subs` 목록이 SoT다(보드는 OUT 뱃지만 붙는다). */
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

  /**
   * 에디터의 문장을 **초안으로 흘려보낸다** (#284). 초안이 자동 저장을 소유하므로, 감독시간에
   * 타이핑한 것도 [후반 시작] 을 안 눌러도 저장된다(만료로 화면이 닫혀도 후반에 반영).
   * 방향은 **한쪽뿐**이다 — 에디터 → 초안. 되돌려 받으면 프리필 effect 와 맞물려 순환한다.
   */
  function syncPromptsToDraft(prev: EditorState | null, next: EditorState) {
    if (prev?.teamPrompt !== next.teamPrompt) draft.setText(null, next.teamPrompt);
    const before = new Map((prev?.draft.slots ?? []).map((s) => [s.playerId, s.promptText ?? ""]));
    for (const slot of next.draft.slots) {
      const text = slot.promptText ?? "";
      if (before.get(slot.playerId) !== text) draft.setText(slot.playerId, text);
    }
  }

  async function handleResume() {
    setError(null);
    setSubmitting(true);
    try {
      /*
       * 후반 지시(팀·선수)는 **초안이 보낸다** — 전반에 이미 자동 저장된 것과 대조해 **달라진 것만**
       * 나간다(`pendingSaves`). 예전엔 화면의 문장 전부를 순차 POST 했는데, 미리작성이 생기고 나면
       * 팀+선수 12건이 매번 [후반 시작] 앞에 붙는다(같은 값이라 서버는 UPSERT 로 무해하지만 느리다).
       *
       * ⚠️ 저장 실패는 여기서 **던진다** — 잡아서 후반만 시작하면 유저가 방금 쓴 지시가 조용히
       *    사라진 채 후반이 돈다.
       */
      await draft.flush();
      /*
       * 세 필드(교체 · 배치 · 전술)를 **한 번의** `/halftime` 에 함께 싣는다.
       *
       * 📌 **`#215` 콜0 의 본질은 "필드를 안 보낸다"가 아니라 "AI 콜이 0이다"** 이고, 그 판정은
       *    **서버**(`MatchService.secondHalfShapeChanged`)가 한다 — 전반과 같은 배치를 보내도
       *    콜0이다(서버 계약 `HalftimeShapeTest.resubmittingTheSameShapeIsNotAChange`).
       *    그러니 보드 모드에서 배치는 **조건 없이** 보낸다. "안 바뀌었으면 안 보낸다"로 아끼면
       *    1R 독립검증이 실행으로 재현한 blocker 2건이 그대로 돌아온다(재제출 400 고착 ·
       *    취소한 배치가 조용히 반영) — 상세는 `halftime-shape.ts` 헤더 ③.
       *    전술만 규칙이 다르다: 만진 경우에만 싣는다(#254 — 배치와 달리 "지금 값"이 화면에
       *    상시로 떠 있지 않아 미첨부가 곧 "전반 값 유지"로 읽힌다).
       */
      const shape = halftimeShapePayload(editor?.draft ?? baseDraft, subs, shapeMode);
      await halftime.mutateAsync(
        tacticsTouched && editor ? { ...shape, teamTactics: editor.tactics } : shape,
      );
      await resume.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "후반 시작에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  const written = (editor?.draft.slots ?? []).filter((s) => s.promptText?.trim()).length;
  /** 저장했다가 비운 대상 — 서버에 값이 남아 있어 화면이 그 사실을 말해야 한다(아래 railNote). */
  const cleared = clearedAfterSave(draft.draft);

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
        {/* 자리 탭은 **배치를 보낼 수 있는 매치에서만** 나온다 — 구 매치에서 띄우면 만져도 아무
            데도 안 가는 손잡이가 된다(#276). */}
        {(shapeMode ? (["say", "sub", "move"] as const) : (["say", "sub"] as const)).map((m) => (
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
              setPendingMove(null);
              setNote(null);
            }}
          >
            {m === "say" ? "감독의 한마디" : m === "sub" ? `교체 ${subs.length}/${MAX_SUBS}` : "자리"}
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
      {mode === "move" && (
        <p className={styles.swapGuide} data-testid="halftime-move-guide">
          {pendingMove
            ? `${nameOf(pendingMove)} 를 옮긴다 — 자리를 바꿀 선발을 누르세요`
            : "자리를 바꿀 선발 두 명을 차례로 누르세요 · 포메이션은 위에서 바꿉니다"}
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
      {/*
        ⚠️ **자동 저장 실패는 여기서도 말해야 한다** (#284 C 결정의 대가).
        전반의 `후반 지시` 탭엔 상태 줄이 있는데 이 화면엔 없어서, 감독시간에 타이핑한 것이 저장에
        실패하면 **아무 말 없이** 넘어갔다. [후반 시작] 을 누르면 그때는 막히지만(`flush()` 가 던진다),
        **감독시간 3분이 그냥 지나가면 조용히 날아간다** — 만료는 서버가 처리하므로 이 화면이 마지막
        경고 지점이다. 조용한 저장에서 조용한 실패가 제일 위험하다.
      */}
      {draft.status === "error" && (
        <p className={styles.issue} data-testid="halftime-autosave-error">
          후반 지시가 <b>저장되지 않았습니다</b> — {draft.error}. 그대로 두면 이 지시 없이 후반이
          시작됩니다. <b>[후반 시작]</b> 을 누르면 다시 시도합니다.
        </p>
      )}

      {/*
        저장했던 지시를 **지운** 경우 (#284). 서버가 빈 문자열을 400 으로 막아서(`text.isBlank`)
        삭제를 표현할 수단이 없다 → 화면이 말해주지 않으면 "지웠는데 후반에 그대로 나온다"가 된다.
        server-java 에 "빈 값 = 삭제" 를 요청한 뒤 이 안내를 걷어낸다.
      */}
      {cleared.length > 0 && (
        <p className={styles.issue} data-testid="halftime-cleared-warning">
          지운 지시 {cleared.length}건은 <b>후반에 그대로 반영됩니다</b> — 비우는 것으로는 취소되지
          않습니다. 필요 없으면 <b>다른 문장으로 덮어써</b> 주세요.
        </p>
      )}
      <p className={styles.writtenNote} data-testid="halftime-written-count">
        후반 선수 지시 {written}명
      </p>
    </>
  );

  return (
    <div ref={panelRef} className={styles.panel} data-testid="halftime-panel">
      <div className={styles.scroll}>
      {editor && (
        <DeckEditor
          state={editor}
          onChange={(next) => {
            if (editor && next.tactics !== editor.tactics) setTacticsTouched(true);
            syncPromptsToDraft(editor, next); // #284 — 여기 타이핑한 것도 자동 저장된다
            setEditor(next);
          }}
          aiManaged={false}
          onToggleAi={() => {}}
          players={ownedPlayers}
          playersById={playersById}
          conditions={match.conditions}
          /* 감독시간의 차이 — 나머지는 덱 화면과 완전히 같다.
             ⚠️ `placementLocked` 는 **스쿼드 밖에서 선수를 데려오는 것**만 막는다. 포메이션·자리
             바꾸기는 `lineupEditable` 이 연다(#276) — 통째로 풀면 보유 선수 시트가 열려 경기
             스쿼드 밖 선수를 후반에 세울 수 있게 된다. */
          placementLocked
          lineupEditable={shapeMode}
          lineupDisabled={expired}
          boardMode={mode === "sub" ? "subs" : mode === "move" ? "move" : undefined}
          onBoardTap={handleBoardTap}
          subbedOut={subs.map((s) => s.out)}
          pendingPlayerId={mode === "move" ? pendingMove : pendingOut}
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
      </div>

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
