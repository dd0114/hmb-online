import { useMemo, useState } from "react";
import {
  useDeck,
  useHalftime,
  usePlayers,
  useResume,
  useSubmitMatchPrompt,
  type MatchDetail,
} from "../api/hooks";
import { ErrorToast } from "../common/ErrorToast";
import { MAX_SUBS, validateSubs, type SubPair } from "./match-logic";
import { PromptFields, type RosterEntry } from "./PromptFields";
import styles from "./HalftimePanel.module.css";

interface HalftimePanelProps {
  match: MatchDetail;
}

/**
 * 하프타임 — 교체(≤3, 벤치↔선발 선택 스왑) + 추가 프롬프트(phase=halftime) + [후반 시작].
 * NOTE: match GET 응답에는 내 로스터가 없어(openapi MatchDetail — opponent만) 선발/벤치를
 * useDeck에서 파생한다. 전반 중 퇴장 등 엔진 내 로스터 변화는 반영 못함 — 서버(AC-M4)가 최종 검증.
 */
export function HalftimePanel({ match }: HalftimePanelProps) {
  const { data: deck } = useDeck();
  const { data: players } = usePlayers();
  const submitPrompt = useSubmitMatchPrompt(match.id);
  const halftime = useHalftime(match.id);
  const resume = useResume(match.id);

  const [subs, setSubs] = useState<SubPair[]>([]);
  const [outPick, setOutPick] = useState("");
  const [inPick, setInPick] = useState("");
  const [teamPrompt, setTeamPrompt] = useState("");
  const [playerPrompts, setPlayerPrompts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playersById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof players>[number]>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);

  const starters = useMemo(
    () => (deck?.slots ?? []).filter((s) => s.role === "starter").map((s) => s.playerId),
    [deck],
  );
  const bench = useMemo(
    () => (deck?.slots ?? []).filter((s) => s.role === "bench").map((s) => s.playerId),
    [deck],
  );

  const nameOf = (id: string) => playersById.get(id)?.name ?? id;
  const posOf = (id: string) => playersById.get(id)?.position;

  const usedOuts = new Set(subs.map((s) => s.out));
  const usedIns = new Set(subs.map((s) => s.in));

  const pendingPair: SubPair | null = outPick && inPick ? { out: outPick, in: inPick } : null;
  const issuesIfAdded = pendingPair
    ? validateSubs([...subs, pendingPair], starters, bench, posOf)
    : [];
  const currentIssues = validateSubs(subs, starters, bench, posOf);
  const addDisabled =
    !pendingPair || subs.length >= MAX_SUBS || issuesIfAdded.some((i) => i.rule !== "GK_REQUIRED");

  const roster: RosterEntry[] = useMemo(
    () =>
      (deck?.slots ?? [])
        .slice()
        .sort((a, b) => (a.role === b.role ? a.slotIndex - b.slotIndex : a.role === "starter" ? -1 : 1))
        .map((s) => ({
          playerId: s.playerId,
          name: nameOf(s.playerId),
          position: posOf(s.playerId) ?? "?",
          role: s.role,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deck, playersById],
  );

  function addSub() {
    if (!pendingPair || addDisabled) return;
    setSubs((prev) => [...prev, pendingPair]);
    setOutPick("");
    setInPick("");
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
      await halftime.mutateAsync({ substitutions: subs });
      await resume.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "후반 시작에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.panel} data-testid="halftime-panel">
      <section className={styles.subsSection}>
        <h3 className={styles.subTitle}>
          선수 교체 ({subs.length}/{MAX_SUBS})
        </h3>

        <div className={styles.pickRow}>
          <select
            className={styles.pick}
            data-testid="sub-out-select"
            value={outPick}
            onChange={(e) => setOutPick(e.target.value)}
          >
            <option value="">OUT (선발)</option>
            {starters
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
            {bench
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
            disabled={addDisabled}
            onClick={addSub}
          >
            추가
          </button>
        </div>
        {subs.length >= MAX_SUBS && (
          <p className={styles.limitNote} data-testid="sub-limit-note">
            교체 한도({MAX_SUBS}명)에 도달했습니다
          </p>
        )}

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
                onClick={() => setSubs((prev) => prev.filter((_, j) => j !== i))}
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

      <ErrorToast message={error} onDismiss={() => setError(null)} />

      <button
        type="button"
        className={styles.resume}
        data-testid="resume-button"
        disabled={submitting || currentIssues.length > 0}
        onClick={handleResume}
      >
        {submitting ? "전송 중…" : "후반 시작"}
      </button>
    </div>
  );
}
