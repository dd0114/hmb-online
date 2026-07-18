import { useEffect, useMemo, useState } from "react";
import { useDeck, usePlayers, useKickoff, useSubmitMatchPrompt, type MatchDetail } from "../api/hooks";
import { GRADE_COLORS, GRADE_LABELS } from "../common/grades";
import { ErrorToast } from "../common/ErrorToast";
import { PromptFields, type RosterEntry } from "./PromptFields";
import styles from "./BriefingPanel.module.css";

/**
 * 브리핑 타이머 표시 초 (D5: 표시만, 강제 안 함 — 만료돼도 진행 가능).
 * 서버 API는 타이머 설정을 노출하지 않아 표시값은 웹 상수(서버 enforce=false).
 */
const BRIEFING_TIMER_SECONDS = 180;

interface BriefingPanelProps {
  match: MatchDetail;
}

export function BriefingPanel({ match }: BriefingPanelProps) {
  const { data: deck, isLoading: deckLoading, isError: deckError } = useDeck();
  const { data: players, isLoading: playersLoading, isError: playersError } = usePlayers();
  const submitPrompt = useSubmitMatchPrompt(match.id);
  const kickoff = useKickoff(match.id);

  const [teamPrompt, setTeamPrompt] = useState("");
  const [playerPrompts, setPlayerPrompts] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const [remaining, setRemaining] = useState(BRIEFING_TIMER_SECONDS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playersById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof players>[number]>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);

  // 덱의 사전 프롬프트를 기본값으로 프리필 (편집 가능 — pre phase로 전송)
  useEffect(() => {
    if (prefilled || !deck) return;
    const initial: Record<string, string> = {};
    for (const slot of deck.slots) {
      if (slot.promptText) initial[slot.playerId] = slot.promptText;
    }
    setPlayerPrompts(initial);
    setPrefilled(true);
  }, [deck, prefilled]);

  // 타이머 카운트다운 — 표시 전용(D5). 0이 되어도 킥오프 가능.
  useEffect(() => {
    const t = window.setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => window.clearInterval(t);
  }, []);

  const roster: RosterEntry[] = useMemo(
    () =>
      (deck?.slots ?? [])
        .slice()
        .sort((a, b) => (a.role === b.role ? a.slotIndex - b.slotIndex : a.role === "starter" ? -1 : 1))
        .map((s) => ({
          playerId: s.playerId,
          name: playersById.get(s.playerId)?.name ?? s.playerId,
          position: playersById.get(s.playerId)?.position ?? "?",
          role: s.role,
        })),
    [deck, playersById],
  );

  async function handleKickoff() {
    setError(null);
    setSubmitting(true);
    try {
      // 프롬프트 전송(phase=pre, UPSERT) — 비어있지 않은 것만, 순차 전송 후 킥오프
      if (teamPrompt.trim()) {
        await submitPrompt.mutateAsync({ phase: "pre", scope: "team", text: teamPrompt });
      }
      for (const [playerId, text] of Object.entries(playerPrompts)) {
        if (text.trim()) {
          await submitPrompt.mutateAsync({ phase: "pre", scope: "player", playerId, text });
        }
      }
      await kickoff.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "킥오프에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");

  // 로스터를 불러오지 못하면 빈 라인업으로 킥오프되는 것을 막는다(#73 P0).
  // 로딩 중에는 에러 문구를 띄우지 않고 버튼만 막는다(shop 과 동일한 로딩 vs 에러 구분, #73 nit A).
  const rosterLoading = deckLoading || playersLoading;
  const rosterMissing = !rosterLoading && (deckError || playersError || roster.length === 0);
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

      <PromptFields
        roster={roster}
        teamPrompt={teamPrompt}
        onTeamChange={setTeamPrompt}
        playerPrompts={playerPrompts}
        onPlayerChange={(playerId, text) =>
          setPlayerPrompts((prev) => ({ ...prev, [playerId]: text }))
        }
        idPrefix="briefing"
      />

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
