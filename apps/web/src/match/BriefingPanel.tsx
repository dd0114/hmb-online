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
import { useRelations } from "../api/hooks-v2";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { ErrorToast } from "../common/ErrorToast";
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
 */
export function BriefingPanel({ match }: BriefingPanelProps) {
  const { data: deck, isLoading: deckLoading, isError: deckError } = useDeck();
  const { data: players, isLoading: playersLoading, isError: playersError } = usePlayers();
  const { data: relations } = useRelations();
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
    </div>
  );
}
