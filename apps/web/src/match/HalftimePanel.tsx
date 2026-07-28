import { useMemo, useState } from "react";
import {
  useDeck,
  useHalftime,
  usePlayers,
  useResume,
  useSubmitMatchPrompt,
  type MatchDetail,
} from "../api/hooks";
import type { TeamTactics } from "../api/v2";
import { ErrorToast } from "../common/ErrorToast";
import { DEFAULT_TEAM_TACTICS, TACTICS_KEYS, TACTICS_LABELS } from "../deck/tactics-logic";
import { STEP_LABELS, stepIndexOf, valueOfStep } from "../deck/tactics-steps";
import { MAX_SUBS, validateSubs, type SubPair } from "./match-logic";
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
 * 하프타임 — 교체(≤3, 벤치↔선발 선택 스왑) + 추가 프롬프트(phase=halftime) + 팀 전술(#254)
 * + [후반 시작].
 * NOTE: match GET 응답에는 내 로스터가 없어(openapi MatchDetail — opponent만) 선발/벤치를
 * useDeck에서 파생한다. 전반 중 퇴장 등 엔진 내 로스터 변화는 반영 못함 — 서버(AC-M4)가 최종 검증.
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

  const [subs, setSubs] = useState<SubPair[]>([]);
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
      await halftime.mutateAsync(
        tactics ? { substitutions: subs, teamTactics: tactics } : { substitutions: subs },
      );
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
