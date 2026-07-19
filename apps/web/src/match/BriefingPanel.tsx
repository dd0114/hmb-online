import { useEffect, useMemo, useState } from "react";
import {
  useDeck,
  usePlayers,
  useKickoff,
  useUpdateDeck,
  useSubmitMatchPrompt,
  type CatalogPlayer,
  type Deck,
  type MatchDetail,
} from "../api/hooks";
import { useRelations, useTeamPresets } from "../api/hooks-v2";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { DeckEditor } from "../deck/DeckEditor";
import { emptyDraft, setPrompt, toUpdateRequest, type DeckDraft } from "../deck/deck-logic";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "../deck/tactics-logic";
import { opponentPowerFromGrades } from "../deck/team-power";
import {
  appendDirective,
  autoAssignDefender,
  MARK_DIRECTIVE,
  type DefenderCandidate,
} from "../deck/one-tap-directives";
import { ConditionClock } from "./ConditionClock";
import {
  briefingBaseline,
  briefingPresetChoices,
  hasAnyPreset,
  isMatchEditDirty,
  presetEditorFor,
  selectionOutcome,
} from "./briefing-preset-logic";
import styles from "./BriefingPanel.module.css";

const BRIEFING_TIMER_SECONDS = 180;

interface BriefingPanelProps {
  match: MatchDetail;
}

function draftFromDeck(deck: Deck | null): DeckDraft {
  if (!deck) return emptyDraft();
  return {
    formation: deck.formation,
    slots: deck.slots.map((s) => ({
      playerId: s.playerId,
      role: s.role,
      slotIndex: s.slotIndex,
      promptText: s.promptText ?? null,
    })),
  };
}

/**
 * Briefing (AC-B2): embeds the SAME DeckEditor used on the deck screen so the snapshot can be
 * fully edited before kickoff. On kickoff we persist deck edits (PUT /api/deck) then call kickoff
 * with the final teamTactics — the server re-captures the active deck + tactics as the match
 * snapshot (recaptureSnapshotAtKickoff). The team-level prompt is sent via the prompt UPSERT.
 *
 * IMPORTANT(영속): briefing 편집은 임시가 아니다 — 라인업/프롬프트/마킹(원탭)은 editor.draft 에
 * 들어가고 handleKickoff 의 updateDeck(PUT /api/deck)로 user_deck_json 에 저장된다. 마킹 원탭은
 * 대상 수비수의 per-player promptText 에 "[상대] 막아"를 합성해 그 저장 경로로 함께 영속된다.
 *
 * W6a(이슈 #98 요구 2): 상단에 저장된 팀 프리셋 `[1][2][3]` 칩을 두어 **매치 시작점**을 고를 수 있다.
 * 칩 선택 = 그 스냅샷을 로컬 editor 로 로드하는 것뿐이며(`POST .../apply` 미호출) 그 위에 매치용
 * 수정을 얹은 최종본을 킥오프의 PUT /api/deck 가 영속한다 — 매치 준비 중에 덱 화면의 활성 덱/프리셋을
 * 미리 오염시키지 않는다. 미선택이면 기존대로 활성 덱으로 초기화(회귀 금지).
 */
export function BriefingPanel({ match }: BriefingPanelProps) {
  const { data: deck, isLoading: deckLoading, isError: deckError } = useDeck();
  const { data: players, isLoading: playersLoading, isError: playersError } = usePlayers();
  const { data: relations } = useRelations();
  const { data: presetSlots } = useTeamPresets();
  const updateDeck = useUpdateDeck();
  const submitPrompt = useSubmitMatchPrompt(match.id);
  const kickoff = useKickoff(match.id);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [aiManaged, setAiManaged] = useState(false);
  const [remaining, setRemaining] = useState(BRIEFING_TIMER_SECONDS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 마킹 원탭(AC-C4): 상대 선수 탭 → 대상, 내 수비수 배정(빈값=자동), 확인 시 프롬프트 합성.
  const [markTarget, setMarkTarget] = useState<string | null>(null);
  const [markDefenderId, setMarkDefenderId] = useState<string>("");
  const [markNote, setMarkNote] = useState<string | null>(null);
  // 프리셋 시작점 선택(W6a, 요구 2): 선택 슬롯 · 로드 시점 지문(매치용 수정 감지) · 덮어쓰기 확인 대상.
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [pendingPreset, setPendingPreset] = useState<number | null>(null);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);
  const ownedPlayers = useMemo(() => (players ?? []).filter((p) => p.owned), [players]);

  // initialize the editor from the active deck once (snapshot to fully edit — AC-B2).
  // 프리셋 미선택 시의 기본 시작점 = 활성 덱(현행 동작 유지, W6a 회귀 금지).
  useEffect(() => {
    if (editor === null && !deckLoading && !deckError) {
      const ed: EditorState = {
        draft: draftFromDeck(deck ?? null),
        tactics: { ...DEFAULT_TEAM_TACTICS },
        teamPrompt: "",
      };
      setEditor(ed);
      setBaseline(briefingBaseline(ed));
    }
  }, [editor, deck, deckLoading, deckError]);

  const presetChoices = useMemo(() => briefingPresetChoices(presetSlots), [presetSlots]);
  const matchEditsDirty =
    editor != null && baseline != null && isMatchEditDirty(editor, baseline);

  /** 프리셋 스냅샷을 매치 작업사본으로 로드(활성 덱/프리셋은 건드리지 않는다 — apply 미호출). */
  function loadPreset(slot: number) {
    const ed = presetEditorFor(presetSlots, slot);
    if (!ed) return;
    setEditor(ed);
    setBaseline(briefingBaseline(ed));
    setSelectedPreset(slot);
    setPendingPreset(null);
    setMarkNote(null);
  }

  /** 칩 탭: 매치용 수정이 있으면 덮어쓰기 확인을 먼저 띄운다(요구 2 데이터손실 방지). */
  function handleSelectPreset(slot: number) {
    const outcome = selectionOutcome({
      slots: presetSlots,
      slot,
      selectedSlot: selectedPreset,
      dirty: matchEditsDirty,
    });
    if (outcome === "ignore") return;
    if (outcome === "confirm") {
      setPendingPreset(slot);
      return;
    }
    loadPreset(slot);
  }

  useEffect(() => {
    const t = window.setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => window.clearInterval(t);
  }, []);

  const starters = useMemo(
    () => (editor?.draft.slots ?? []).filter((s) => s.role === "starter"),
    [editor],
  );

  // 내 선발 = 마킹 배정 후보(수비수 우선). autoAssignDefender 가 DF→MF→필드 순으로 고른다.
  const myDefenders: DefenderCandidate[] = useMemo(
    () =>
      starters.map((s) => ({
        playerId: s.playerId,
        name: playersById.get(s.playerId)?.name ?? s.playerId,
        position: playersById.get(s.playerId)?.position ?? "?",
      })),
    [starters, playersById],
  );

  /** 마킹 원탭 확정 — 대상 상대에게 붙일 수비수(선택/자동)의 프롬프트에 "[상대] 막아" 합성. */
  function confirmMarking() {
    if (!markTarget || !editor) return;
    const chosen = markDefenderId
      ? myDefenders.find((d) => d.playerId === markDefenderId)
      : autoAssignDefender(myDefenders);
    if (!chosen) {
      setMarkNote("배정할 수비수가 없습니다 — 선발을 먼저 구성하세요");
      return;
    }
    const slot = editor.draft.slots.find((s) => s.playerId === chosen.playerId);
    const fragment = MARK_DIRECTIVE.synthesize(markTarget);
    const nextText = appendDirective(slot?.promptText, fragment);
    setEditor({ ...editor, draft: setPrompt(editor.draft, chosen.playerId, nextText) });
    const auto = markDefenderId ? "" : "자동 배정 — ";
    setMarkNote(`${auto}${chosen.name} 에게 "${fragment}" 지시를 추가했습니다 (덱에 저장됨)`);
    setMarkTarget(null);
    setMarkDefenderId("");
  }

  // opponent power ≈ grade-based (briefing opponent deck exposes only grade). First 11 = XI.
  const opponentPower = useMemo(() => {
    const grades = (match.opponent?.deck ?? []).slice(0, 11).map((p) => p.grade);
    return grades.length ? opponentPowerFromGrades(grades) : undefined;
  }, [match.opponent]);

  async function handleKickoff() {
    setError(null);
    setSubmitting(true);
    try {
      // 1) persist deck edits so the server recapture reads them (per-player prompts included)
      await updateDeck.mutateAsync(toUpdateRequest(editor!.draft));
      // 2) team-level prompt (orthogonal to the deck snapshot) via UPSERT
      if (editor!.teamPrompt.trim()) {
        await submitPrompt.mutateAsync({ phase: "pre", scope: "team", text: editor!.teamPrompt });
      }
      // 3) kickoff → server recaptures active deck + teamTactics as the match snapshot
      await kickoff.mutateAsync(aiManaged ? undefined : { teamTactics: editor!.tactics });
    } catch (err) {
      setError(err instanceof Error ? err.message : "킥오프에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");

  const rosterLoading = deckLoading || playersLoading || editor === null;
  const rosterMissing = !rosterLoading && (deckError || playersError || starters.length === 0);
  const rosterUnavailable = rosterLoading || rosterMissing;

  return (
    <div className={styles.panel} data-testid="briefing-panel">
      <div className={styles.timerRow}>
        <span className={remaining === 0 ? styles.timerExpired : styles.timer} data-testid="briefing-timer">
          입력 시간 {mm}:{ss}
        </span>
        <span className={styles.timerNote}>만료돼도 진행 가능</span>
      </div>

      {/* 프리셋 시작점 선택(요구 2) — 컴팩트 칩 [1][2][3]. 채워진 슬롯만 선택 가능.
          저장된 프리셋이 하나도 없으면(신규 유저) 행 자체를 숨긴다 — 서버는 항상 3슬롯을 준다. */}
      {hasAnyPreset(presetChoices) && (
        <section className={styles.presetRow} data-testid="briefing-presets">
          <div className={styles.presetChips}>
            {presetChoices.map((c) => (
              <button
                key={c.slot}
                type="button"
                className={[
                  styles.presetChip,
                  c.filled ? styles.presetChipFilled : styles.presetChipEmpty,
                  selectedPreset === c.slot ? styles.presetChipSelected : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-testid={`briefing-preset-chip-${c.slot}`}
                data-filled={c.filled ? "true" : "false"}
                data-selected={selectedPreset === c.slot ? "true" : "false"}
                /* 칩 이름은 ellipsis 로 잘릴 수 있다 — 전체 이름을 툴팁으로 노출. */
                title={c.filled ? `${c.slot}. ${c.name}` : "비어 있음"}
                disabled={!c.filled || submitting}
                onClick={() => handleSelectPreset(c.slot)}
              >
                <span className={styles.presetChipNo}>{c.slot}</span>
                <span className={styles.presetChipName}>{c.name}</span>
              </button>
            ))}
          </div>
          <p className={styles.presetHint} data-testid="briefing-preset-hint">
            프리셋을 고르면 그걸로 시작합니다 — 고르지 않으면 현재 덱으로 진행합니다.
          </p>
        </section>
      )}

      {match.opponent && (
        <section className={styles.opponent} data-testid="opponent-analysis">
          <h3 className={styles.opponentName}>상대: {match.opponent.name}</h3>
          <p className={styles.analysisText}>{match.opponent.analysisText}</p>
          <table className={styles.deckTable}>
            <thead>
              <tr>
                <th>포지션</th>
                <th>이름</th>
                <th>등급</th>
                <th>지시</th>
                <th>마크</th>
              </tr>
            </thead>
            <tbody>
              {match.opponent.deck.map((p, i) => (
                <tr key={`${p.name}-${i}`}>
                  <td>{p.position}</td>
                  <td>{p.name}</td>
                  <td style={{ color: GRADE_COLORS[p.grade] }}>{GRADE_LABELS[p.grade]}</td>
                  <td>{p.hasPrompt ? "●" : "—"}</td>
                  <td>
                    <button
                      type="button"
                      className={styles.markTrigger}
                      data-testid={`mark-opp-${i}`}
                      aria-pressed={markTarget === p.name}
                      onClick={() => {
                        setMarkNote(null);
                        setMarkTarget((cur) => (cur === p.name ? null : p.name));
                        setMarkDefenderId("");
                      }}
                    >
                      마크
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 마킹 원탭 칩(AC-C4) — "이 선수 마크" → 내 수비수 배정(빈값=자동) → 프롬프트 합성 */}
          {markTarget && (
            <div className={styles.markPanel} data-testid="mark-panel">
              <span className={styles.markChip} data-testid="mark-chip">
                {MARK_DIRECTIVE.label(markTarget)}
              </span>
              <label className={styles.markLabel} htmlFor="mark-defender">
                맡길 수비수
              </label>
              <select
                id="mark-defender"
                className={styles.markSelect}
                data-testid="mark-defender-select"
                value={markDefenderId}
                onChange={(e) => setMarkDefenderId(e.target.value)}
              >
                <option value="">자동 배정(수비수 우선)</option>
                {myDefenders.map((d) => (
                  <option key={d.playerId} value={d.playerId}>
                    {d.position} {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.markConfirm}
                data-testid="mark-confirm"
                onClick={confirmMarking}
              >
                이 선수 마크
              </button>
            </div>
          )}
          {markNote && (
            <p className={styles.markNote} data-testid="mark-note">
              {markNote}
            </p>
          )}
        </section>
      )}

      {/* 라인업 컨디션 시계 요약 (AC-C1) */}
      {match.conditions && starters.length > 0 && (
        <section className={styles.conditions} data-testid="briefing-conditions">
          <h4 className={styles.condTitle}>선발 컨디션</h4>
          <ul className={styles.condList}>
            {starters.map((s) => (
              <li key={s.playerId} className={styles.condItem} data-testid={`cond-${s.playerId}`}>
                <ConditionClock value={match.conditions![s.playerId] ?? 0.5} size={26} testId={`cond-clock-${s.playerId}`} />
                <span className={styles.condName}>{playersById.get(s.playerId)?.name ?? s.playerId}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editor && (
        <>
          <p className={styles.persistNote} data-testid="briefing-persist-note">
            여기서의 편집(라인업·전술·프롬프트·마킹)은 임시가 아니라 내 덱에 저장됩니다 — 킥오프 시 반영됩니다.
          </p>
          <DeckEditor
            state={editor}
            onChange={setEditor}
            aiManaged={aiManaged}
            onToggleAi={setAiManaged}
            players={ownedPlayers}
            playersById={playersById}
            conditions={match.conditions}
            relations={relations}
            opponentPower={opponentPower}
            opponentName={match.opponent?.name}
            opponentApprox
          />
        </>
      )}

      {rosterMissing && (
        <ErrorToast message="내 로스터를 불러오지 못했습니다 — 새로고침 후 다시 시도하세요" />
      )}
      <ErrorToast message={error} onDismiss={() => setError(null)} />

      <button
        type="button"
        className={styles.kickoff}
        data-testid="kickoff-button"
        disabled={submitting || rosterUnavailable}
        onClick={handleKickoff}
      >
        {submitting ? "전송 중…" : "킥오프"}
      </button>

      {/* 덮어쓰기 확인(요구 2): 매치용 수정이 있는 상태에서 프리셋을 다시 고르면 그 수정이 사라진다. */}
      {pendingPreset != null && (
        <Modal
          onClose={() => setPendingPreset(null)}
          labelledBy="briefing-preset-confirm-title"
          overlayClassName={styles.confirmBackdrop}
          overlayTestId="briefing-preset-confirm-backdrop"
          className={styles.confirmDialog}
          testId="briefing-preset-confirm"
        >
          <p id="briefing-preset-confirm-title" className={styles.confirmText}>
            현재 매치 수정사항이 사라집니다. 불러올까요?
          </p>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={styles.confirmLoad}
              data-testid="briefing-preset-confirm-load"
              onClick={() => loadPreset(pendingPreset)}
            >
              불러오기
            </button>
            <button
              type="button"
              className={styles.confirmCancel}
              data-testid="briefing-preset-confirm-cancel"
              onClick={() => setPendingPreset(null)}
            >
              취소
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
