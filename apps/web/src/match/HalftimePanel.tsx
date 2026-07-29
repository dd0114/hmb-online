import { useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  useDeck,
  useHalftime,
  usePlayers,
  useResume,
  useSubmitMatchPrompt,
  type CatalogPlayer,
  type HalftimeRequest,
  type MatchDetail,
} from "../api/hooks";
import type { TeamTactics } from "../api/v2";
import { ErrorToast } from "../common/ErrorToast";
import { findPlayerSlot, type DeckDraft } from "../deck/deck-logic";
import { FormationSelect } from "../deck/FormationSelect";
import {
  parseDroppableId,
  playerIdFromDragId,
  TacticsBoard,
  type SlotRef,
} from "../deck/TacticsBoard";
import { NO_SELECTION, tapSlot, type TapSelection } from "../deck/tap-place";
import { DEFAULT_TEAM_TACTICS, movePlayerToSlot, TACTICS_KEYS, TACTICS_LABELS } from "../deck/tactics-logic";
import { STEP_LABELS, stepIndexOf, valueOfStep } from "../deck/tactics-steps";
import { MAX_SUBS, validateSubs, type SubPair } from "./match-logic";
import {
  boardUsable,
  diffSubstitutions,
  halftimeShapePayload,
  lineupIssues,
  revertSub,
  snapshotToDraft,
} from "./halftime-shape";
import { countdownLabel } from "./live-clock";
import { useCountdown } from "./useCountdown";
import { PromptFields, type RosterEntry } from "./PromptFields";
import styles from "./HalftimePanel.module.css";

interface HalftimePanelProps {
  match: MatchDetail;
  /** 폴링 때 잡아둔 서버-클라 시각차(live-clock.captureOffsetMs). */
  clockOffsetMs?: number;
}

/**
 * 하프타임 — 라인업 보드(포메이션·배치·교체) + 추가 프롬프트(phase=halftime) + 팀 전술(#254)
 * + [후반 시작].
 *
 * **덱 화면과 같은 보드·같은 제스처**다(#276, hero: "덱구성이랑 비슷하게 사용할수있도록 유지해서
 * 가져가. 중요한건 통일성이야"). 새로 그리지 않고 덱 컴포넌트를 그대로 import 한다 —
 * `TacticsBoard`(피치+벤치+토큰) · `tap-place`(탭-투-플레이스, #106 계약: 탭이 1급/드래그는 보조) ·
 * `movePlayerToSlot`(swap) · `FormationSelect`. 그전까지 이 자리는 OUT/IN 셀렉트 2개 + [추가]였고,
 * 덱에서 손가락으로 옮기던 사람이 감독시간엔 드롭다운을 뒤졌다.
 *
 * ⚠️ 보드의 시작 상태는 **매치 스냅샷**(`match.userDeckSnapshot`)이지 `useDeck()`(현재 덱)이
 * 아니다 — 전반 시작 후 덱을 고치면 감독 화면이 경기와 다른 라인업을 그리던 자리다(#254 가 전술
 * 시작점을 스냅샷으로 잡은 것과 같은 이유). 스냅샷이 없는 구 매치는 보드를 숨기고 기존 셀렉트
 * 폴백으로 간다(기능 소실 금지) — 그 경로만 `useDeck()` 로 선발/벤치를 파생한다.
 */
export function HalftimePanel({ match, clockOffsetMs = 0 }: HalftimePanelProps) {
  const { data: deck, isError: deckError } = useDeck();
  const { data: players, isError: playersError } = usePlayers();
  const submitPrompt = useSubmitMatchPrompt(match.id);
  const halftime = useHalftime(match.id);
  const resume = useResume(match.id);

  // 감독시간 카운트다운(P4-D2). 0 이 되면 서버가 후반을 자동 시작하므로 화면도 제출을 닫는다 —
  // 눌러봐야 409 가 오는 버튼을 열어두면 "냈는데 안 들어갔다"는 오해가 된다.
  const remaining = useCountdown(match.clock ?? null, clockOffsetMs);
  const deadlineLabel = countdownLabel(remaining);
  const expired = remaining != null && remaining <= 0;

  /** 폴백(스냅샷 없는 구 매치) 전용 교체 상태 — 보드 모드에서는 draft diff 가 SoT 다. */
  const [selectSubs, setSelectSubs] = useState<SubPair[]>([]);
  const [outPick, setOutPick] = useState("");
  const [inPick, setInPick] = useState("");
  const [teamPrompt, setTeamPrompt] = useState("");
  const [playerPrompts, setPlayerPrompts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 팀 전술(#254) — 시작점은 **전반에 실제로 쓴 값**이다(매치 스냅샷). 중립값에서 시작하면 다이얼을
  // 건드리지 않은 유저가 후반에 전술을 리셋해 버린다. 스냅샷이 없는 구 매치는 중립.
  const firstHalfTactics = match.userDeckSnapshot?.teamTactics ?? DEFAULT_TEAM_TACTICS;
  const [tactics, setTactics] = useState<TeamTactics | null>(null);
  const effectiveTactics = tactics ?? firstHalfTactics;
  // 안 건드렸으면 아예 보내지 않는다 — 서버는 미첨부를 "손대지 않음"으로 읽어 후반 인풋을
  // 재생성하지 않는다(콜0 유지, 예산 가드 P2-D8). 보내도 같은 값이면 무변경으로 처리되지만,
  // "안 만졌으면 안 보낸다"가 의도를 그대로 옮기는 표현이다.

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);

  // ── 라인업 보드 (#276) ─────────────────────────────────────────────────────
  // 시작 상태 = 매치 스냅샷. 보드는 여기서 출발해 여기로 수렴하고, 서버로 나가는 두 필드
  // (substitutions / formation+starters)는 이 base 와의 diff 로만 결정된다(halftime-shape).
  const baseDraft = useMemo(
    () => (boardUsable(match.userDeckSnapshot) ? snapshotToDraft(match.userDeckSnapshot) : null),
    [match.userDeckSnapshot],
  );
  const [boardDraft, setBoardDraft] = useState<DeckDraft | null>(null);
  const [selection, setSelection] = useState<TapSelection>(NO_SELECTION);
  const draft = boardDraft ?? baseDraft;
  const boardMode = baseDraft != null && draft != null;

  // 드래그는 **보조** 수단(탭이 1급, #106) — 센서 구성은 덱(DeckEditor)과 같다. MouseSensor +
  // TouchSensor 분리도 그대로 유지한다(PointerSensor 를 쓰면 터치 드래그가 죽는 실측 이력).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const nameOf = (id: string) => playersById.get(id)?.name ?? id;
  const posOf = (id: string) => playersById.get(id)?.position;

  // 폴백 경로(스냅샷 없는 구 매치)의 선발/벤치는 종전대로 현재 덱에서 파생한다.
  const deckStarters = useMemo(
    () => (deck?.slots ?? []).filter((s) => s.role === "starter").map((s) => s.playerId),
    [deck],
  );
  const deckBench = useMemo(
    () => (deck?.slots ?? []).filter((s) => s.role === "bench").map((s) => s.playerId),
    [deck],
  );

  /** 서버로 나갈 교체 목록 — 보드 모드면 제스처 diff, 폴백이면 셀렉트로 쌓은 목록. */
  const subs: SubPair[] = boardMode ? diffSubstitutions(baseDraft!, draft!) : selectSubs;
  const currentIssues = boardMode
    ? lineupIssues(baseDraft!, draft!, posOf)
    : validateSubs(selectSubs, deckStarters, deckBench, posOf);

  const usedOuts = new Set(selectSubs.map((s) => s.out));
  const usedIns = new Set(selectSubs.map((s) => s.in));

  const pendingPair: SubPair | null = outPick && inPick ? { out: outPick, in: inPick } : null;
  const issuesIfAdded = pendingPair
    ? validateSubs([...selectSubs, pendingPair], deckStarters, deckBench, posOf)
    : [];
  const addDisabled =
    !pendingPair ||
    selectSubs.length >= MAX_SUBS ||
    issuesIfAdded.some((i) => i.rule !== "GK_REQUIRED");

  /**
   * 프롬프트 대상 로스터 — 보드 모드면 **지금 보드 위 구성**(교체 반영)에서 뽑는다. 현재 덱에서
   * 뽑으면 방금 투입한 선수에게 지시를 못 남기고, 경기에 없는 선수가 목록에 뜬다.
   */
  const roster: RosterEntry[] = useMemo(() => {
    const source = boardMode
      ? draft!.slots
      : (deck?.slots ?? []).map((s) => ({ playerId: s.playerId, role: s.role, slotIndex: s.slotIndex }));
    return source
      .slice()
      .sort((a, b) => (a.role === b.role ? a.slotIndex - b.slotIndex : a.role === "starter" ? -1 : 1))
      .map((s) => ({
        playerId: s.playerId,
        name: nameOf(s.playerId),
        position: posOf(s.playerId) ?? "?",
        role: s.role,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardMode, draft, deck, playersById]);

  function addSub() {
    if (!pendingPair || addDisabled) return;
    setSelectSubs((prev) => [...prev, pendingPair]);
    setOutPick("");
    setInPick("");
  }

  /** 보드 슬롯 탭 — 선택/배치/이동/교체 판단은 덱과 **같은** tap-place(순수)가 한다. */
  function handleSlotTap(slot: SlotRef) {
    if (expired || !draft) return;
    const r = tapSlot(draft, selection, slot);
    if (r.draft !== draft) setBoardDraft(r.draft);
    setSelection(r.selection);
  }

  function handleDragEnd(e: DragEndEvent) {
    if (expired || !e.over || !draft) return;
    const playerId = playerIdFromDragId(String(e.active.id));
    const target = parseDroppableId(String(e.over.id));
    if (!findPlayerSlot(draft, playerId)) return;
    setBoardDraft(movePlayerToSlot(draft, playerId, target.role, target.slotIndex));
    setSelection({ slot: null, playerId, source: "board" });
  }

  /** 덱 조회 실패가 치명적인가 — 폴백 경로에서만 그렇다(보드 모드의 로스터는 스냅샷이 준다). */
  const rosterError = deckError && !boardMode;

  /**
   * 확정된 교체 취소 — 보드도 같이 되돌린다(텍스트 목록과 보드가 갈라지면 안 된다).
   * 되돌림의 기준은 **스냅샷(baseDraft)**이다: 투입 선수를 다른 자리로 옮긴 뒤 취소해도 선발
   * 두 명이 뒤바뀐 채 남지 않게(halftime-shape.revertSub 주석).
   */
  function cancelSub(pair: SubPair, index: number) {
    if (boardMode && draft) {
      setBoardDraft(revertSub(baseDraft!, draft, pair));
      setSelection(NO_SELECTION);
      return;
    }
    setSelectSubs((prev) => prev.filter((_, j) => j !== index));
  }

  async function handleResume() {
    setError(null);
    setSubmitting(true);
    try {
      if (teamPrompt.trim()) {
        await submitPrompt.mutateAsync({ phase: "halftime", scope: "team", text: teamPrompt });
      }
      for (const [playerId, text] of Object.entries(playerPrompts)) {
        if (text.trim()) {
          await submitPrompt.mutateAsync({ phase: "halftime", scope: "player", playerId, text });
        }
      }
      // 세 필드(교체·전술·배치)를 **한 요청**에 싣는다 — 서로 독립이고 미첨부 = 손대지 않음이라
      // 왕복을 나눌 이유가 없다.
      // ⚠️ 보드 모드에서 배치는 **항상** 실린다(무변경이어도). 조건부로 빼지 마라 —
      // 그게 #276 1R 검증이 잡은 blocker 2건의 원인이었다: `substitutions` 는 항상 싣는데
      // 배치만 조건부라, ①재마운트 후 제출이 저장된 배치와 어긋나 400 고착 ②원상복구를
      // 표현할 값이 없어 COALESCE 가 취소된 배치를 살렸다. 상세 = halftime-shape.ts 헤더.
      // #215 콜0 은 "안 보낸다"가 아니라 "**AI 콜이 0이다**"가 본질이고, 그 판정은 서버가
      // 한다(secondHalfShapeChanged — 전반과 같은 배치면 무변경 → 콜0).
      const body: HalftimeRequest = boardMode
        ? halftimeShapePayload(baseDraft!, draft!)
        : { substitutions: selectSubs };
      if (tactics) body.teamTactics = tactics;
      await halftime.mutateAsync(body);
      await resume.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "후반 시작에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.panel} data-testid="halftime-panel">
      {deadlineLabel && (
        <p
          className={`${styles.deadline} ${expired ? styles.deadlineOver : ""}`}
          data-testid="halftime-countdown"
        >
          {expired
            ? "감독시간 종료 — 전반 지시 그대로 후반이 진행됩니다"
            : `감독시간 ${deadlineLabel} 남음 — 시간이 지나면 전반 지시로 후반이 시작됩니다`}
        </p>
      )}

      <section className={styles.subsSection} data-testid="halftime-lineup">
        <h3 className={styles.subTitle}>
          라인업 · 교체 ({subs.length}/{MAX_SUBS})
        </h3>

        {boardMode ? (
          /* 덱과 같은 보드 — 새로 그리지 않고 그대로 가져다 쓴다(#276). 탭이 1급이고 드래그는
             DndContext 로 보조한다(덱과 같은 배선). 감독시간이 끝나면(expired) 전술 스텝과 같은
             규칙으로 잠근다 — 눌러봐야 409 가 오는 손잡이를 열어두지 않는다. */
          <div
            className={expired ? `${styles.board} ${styles.boardLocked}` : styles.board}
            data-testid="halftime-board"
            data-locked={expired ? "true" : "false"}
          >
            <div className={styles.boardHead}>
              <FormationSelect
                value={draft!.formation}
                onChange={(formation) => setBoardDraft({ ...draft!, formation })}
                disabled={expired}
                testId="halftime-formation-select"
                id="halftime-formation"
                classNames={{ label: styles.formationLabel, srOnly: styles.srOnly, select: styles.formation }}
              />
              <span className={styles.boardHint}>
                벤치 선수를 눌러 선발 자리에 놓으면 교체, 선발끼리 누르면 자리 교체
              </span>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <TacticsBoard
                draft={draft!}
                playersById={playersById}
                conditions={match.conditions}
                selectedSlot={selection.slot}
                selectedPlayerId={selection.playerId}
                onSlotTap={handleSlotTap}
              />
            </DndContext>
          </div>
        ) : (
          /* 폴백 — 스냅샷이 없는 구 매치(서버가 형상 미충족 시 필드를 생략한다). 보드를 열면
             빈 피치가 뜨고 교체 수단이 통째로 사라지므로 기존 OUT/IN 셀렉트를 그대로 남긴다. */
          <div className={styles.pickRow} data-testid="halftime-subs-fallback">
            <select
              className={styles.pick}
              data-testid="sub-out-select"
              value={outPick}
              onChange={(e) => setOutPick(e.target.value)}
            >
              <option value="">OUT (선발)</option>
              {deckStarters
                .filter((id) => !usedOuts.has(id))
                .map((id) => (
                  <option key={id} value={id}>
                    {posOf(id)} {nameOf(id)}
                  </option>
                ))}
            </select>
            <span className={styles.arrow} aria-hidden="true">
              ⇄
            </span>
            <select
              className={styles.pick}
              data-testid="sub-in-select"
              value={inPick}
              onChange={(e) => setInPick(e.target.value)}
            >
              <option value="">IN (벤치)</option>
              {deckBench
                .filter((id) => !usedIns.has(id))
                .map((id) => (
                  <option key={id} value={id}>
                    {posOf(id)} {nameOf(id)}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className={styles.add}
              data-testid="sub-add"
              disabled={addDisabled || expired}
              onClick={addSub}
            >
              추가
            </button>
          </div>
        )}
        {subs.length >= MAX_SUBS && (
          <p className={styles.limitNote} data-testid="sub-limit-note">
            교체 한도({MAX_SUBS}명)에 도달했습니다
          </p>
        )}

        {/* 확정된 교체는 계속 **텍스트로** 보여준다 — 보드만 보면 무엇이 교체로 잡혔는지
            (자리 이동인지 로스터 변경인지) 알 수 없다. */}
        <ul className={styles.subList} data-testid="sub-list">
          {subs.map((s, i) => (
            <li key={`${s.out}-${s.in}`} className={styles.subItem}>
              <span className={styles.subText}>
                OUT {nameOf(s.out)} → IN {nameOf(s.in)}
              </span>
              <button
                type="button"
                className={styles.remove}
                data-testid={`sub-remove-${i}`}
                disabled={expired}
                onClick={() => cancelSub(s, i)}
              >
                취소
              </button>
            </li>
          ))}
        </ul>

        {currentIssues.map((issue) => (
          <p key={issue.rule} className={styles.issue} data-testid={`sub-issue-${issue.rule}`}>
            {issue.message}
          </p>
        ))}
      </section>

      {/* 팀 전술(#254) — hero 결정 "허용". 그전까지 이 자리는 **비어 있었다**: 전술을 실을 계약이
          없어 다이얼을 감췄고, 유저에겐 "왜 없지"로 남았다. 5스텝 매핑은 덱 화면과 같은 순수 로직
          (tactics-steps)을 쓴다 — 두 화면이 다른 값을 만들면 같은 손잡이가 다른 뜻이 된다. */}
      <section className={styles.tacticsSection} data-testid="halftime-tactics">
        <h3 className={styles.subTitle}>팀 전술</h3>
        {TACTICS_KEYS.map((key) => {
          const index = stepIndexOf(effectiveTactics[key] ?? 0.5);
          return (
            <div key={key} className={styles.tacticRow}>
              <span className={styles.tacticLabel}>{TACTICS_LABELS[key]}</span>
              <div
                className={styles.tacticSteps}
                role="radiogroup"
                aria-label={TACTICS_LABELS[key]}
                data-testid={`halftime-tactics-${key}`}
                data-value={effectiveTactics[key]}
                data-step={index}
              >
                {STEP_LABELS[key].map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={i === index}
                    disabled={expired}
                    data-testid={`halftime-tactics-${key}-step-${i}`}
                    className={i === index ? styles.tacticStepOn : undefined}
                    onClick={() =>
                      setTactics({ ...effectiveTactics, [key]: valueOfStep(i) })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <PromptFields
        roster={roster}
        teamPrompt={teamPrompt}
        onTeamChange={setTeamPrompt}
        playerPrompts={playerPrompts}
        onPlayerChange={(playerId, text) =>
          setPlayerPrompts((prev) => ({ ...prev, [playerId]: text }))
        }
        idPrefix="halftime"
      />

      {/* 보드 모드에서는 로스터가 **매치 스냅샷**에서 오므로 덱 조회 실패가 후반 시작을 막지
          않는다(막으면 스냅샷이 멀쩡한데도 유저가 감독시간을 통째로 잃는다). 폴백 경로만 덱이 필수. */}
      {(rosterError || playersError) && (
        <ErrorToast message="내 로스터를 불러오지 못했습니다 — 새로고침 후 다시 시도하세요" />
      )}
      <ErrorToast message={error} onDismiss={() => setError(null)} />

      <button
        type="button"
        className={styles.resume}
        data-testid="resume-button"
        disabled={submitting || expired || currentIssues.length > 0 || rosterError || playersError}
        onClick={handleResume}
      >
        {submitting ? "전송 중…" : expired ? "후반 시작됨" : "후반 시작"}
      </button>
    </div>
  );
}
