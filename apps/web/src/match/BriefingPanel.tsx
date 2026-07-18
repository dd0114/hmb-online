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
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { ErrorToast } from "../common/ErrorToast";
import { DeckEditor } from "../deck/DeckEditor";
import { emptyDraft, toUpdateRequest, type DeckDraft } from "../deck/deck-logic";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "../deck/tactics-logic";
import { opponentPowerFromGrades } from "../deck/team-power";
import { ConditionClock } from "./ConditionClock";
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
 */
export function BriefingPanel({ match }: BriefingPanelProps) {
  const { data: deck, isLoading: deckLoading, isError: deckError } = useDeck();
  const { data: players, isLoading: playersLoading, isError: playersError } = usePlayers();
  const updateDeck = useUpdateDeck();
  const submitPrompt = useSubmitMatchPrompt(match.id);
  const kickoff = useKickoff(match.id);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [aiManaged, setAiManaged] = useState(false);
  const [remaining, setRemaining] = useState(BRIEFING_TIMER_SECONDS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);
  const ownedPlayers = useMemo(() => (players ?? []).filter((p) => p.owned), [players]);

  // initialize the editor from the active deck once (snapshot to fully edit — AC-B2)
  useEffect(() => {
    if (editor === null && !deckLoading && !deckError) {
      setEditor({ draft: draftFromDeck(deck ?? null), tactics: { ...DEFAULT_TEAM_TACTICS }, teamPrompt: "" });
    }
  }, [editor, deck, deckLoading, deckError]);

  useEffect(() => {
    const t = window.setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => window.clearInterval(t);
  }, []);

  const starters = useMemo(
    () => (editor?.draft.slots ?? []).filter((s) => s.role === "starter"),
    [editor],
  );

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
              </tr>
            </thead>
            <tbody>
              {match.opponent.deck.map((p, i) => (
                <tr key={`${p.name}-${i}`}>
                  <td>{p.position}</td>
                  <td>{p.name}</td>
                  <td style={{ color: GRADE_COLORS[p.grade] }}>{GRADE_LABELS[p.grade]}</td>
                  <td>{p.hasPrompt ? "●" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
        <DeckEditor
          state={editor}
          onChange={setEditor}
          aiManaged={aiManaged}
          onToggleAi={setAiManaged}
          players={ownedPlayers}
          playersById={playersById}
          conditions={match.conditions}
          opponentPower={opponentPower}
          opponentName={match.opponent?.name}
          opponentApprox
        />
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
    </div>
  );
}
