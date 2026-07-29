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
// briefing-preset-logic(프리셋 시작점 선택)은 #106 으로 화면에서 내렸다 — 모듈·테스트는 존치.
import styles from "./BriefingPanel.module.css";

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
  const updateDeck = useUpdateDeck();
  const submitPrompt = useSubmitMatchPrompt(match.id);
  const kickoff = useKickoff(match.id);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [aiManaged, setAiManaged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 마킹 원탭(AC-C4): 상대 선수 탭 → 대상, 내 수비수 배정(빈값=자동), 확인 시 프롬프트 합성.
  const [markTarget, setMarkTarget] = useState<string | null>(null);
  const [markDefenderId, setMarkDefenderId] = useState<string>("");
  const [markNote, setMarkNote] = useState<string | null>(null);
  // #244: 상대 정보(표·컨디션·마크 지정)는 시트 뒤. #285 로 진입점만 팀시트 전력 줄로 옮겼다.
  const [oppOpen, setOppOpen] = useState(false);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);
  const ownedPlayers = useMemo(() => (players ?? []).filter((p) => p.owned), [players]);

  // initialize the editor from the active deck once (snapshot to fully edit — AC-B2).
  // 시작점은 항상 활성 덱이다 — 프리셋 시작점 선택은 #106 으로 화면에서 내렸다.
  useEffect(() => {
    if (editor === null && !deckLoading && !deckError) {
      const ed: EditorState = {
        draft: draftFromDeck(deck ?? null),
        tactics: { ...DEFAULT_TEAM_TACTICS },
        // 덱에 써 둔 팀 문장이 이 경기의 시작점이다(#253) — 서버에서도 덱 문장이 pre 지시의
        // 기본값이므로, 화면이 빈칸으로 시작하면 "왜 내가 쓴 지시가 없지"가 된다.
        teamPrompt: deck?.teamPrompt ?? "",
      };
      setEditor(ed);
    }
  }, [editor, deck, deckLoading, deckError]);

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
      // 1) persist deck edits so the server recapture reads them (per-player + team prompts)
      await updateDeck.mutateAsync(toUpdateRequest(editor!.draft, editor!.teamPrompt));
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

  const rosterLoading = deckLoading || playersLoading || editor === null;
  const rosterMissing = !rosterLoading && (deckError || playersError || starters.length === 0);
  const rosterUnavailable = rosterLoading || rosterMissing;

  return (
    <div className={styles.panel} data-testid="briefing-panel">
      {/*
        #285 — **상단 메타 줄을 걷어냈다**(hero 실관전 제보 "깨진 디자인·불필요").
        #244 W2 가 상대표(244px)+컨디션(209px)을 시트 뒤로 보내며 남은 것을 한 줄로 압축했는데,
        그 줄에 다섯 가지가 겹쳐 앉아 있었다. 하나씩 왜 없앴나:

        · **타이머**(`briefing-timer`, 180초) — PRD-v2 `D5` 로 "표시만, 강제 안 함"이었다. 그런데
          클라 로컬 카운트다운이라 새로고침하면 리셋되고, 0 이 돼도 아무 일도 일어나지 않는다.
          정보가치가 0인데 압박만 준다. D5 가 말한 "config 플래그로 강제 전환"은 구현된 적이 없고,
          진짜 강제 타이머는 하프타임 감독시간(60초·서버 권위·만료 시 입력잠금 D6)이 따로 있다.
          ⚠️ 되살리려면 **서버 권위 마감**부터다 — 로컬 카운트다운을 다시 그리지 마라.
        · **"만료돼도 진행 가능"** — 타이머가 없으면 설명할 대상이 없다.
        · **`vs {상대명}`** — 바로 아래 팀시트 전력 줄이 이미 `≈690 {상대명}` 을 말한다(중복).
        · **`analysisText`** — 봇 매칭 안내문. 한 줄에 밀어 넣어 잘리고 있었고, 원문은 상대 정보
          시트 안에 그대로 있다(`opponent-analysis`) = 지운 게 아니라 한 곳으로 모았다.
        · **[상대 정보 ↗]** — **이것만 필수**다. 지우지 않고 상대 이름·전력이 이미 있는
          팀시트 전력 줄로 옮겼다(`TeamSheetBar.onOpponentInfo`). 계약 = `p285-icon-policy.spec.ts`.
      */}

      {/* 프리셋 시작점 선택(#98 W6a)은 **화면에서 내렸다** — 이슈 #106: 컨셉이 잡히기 전의 프리셋은
          시기상조라 세팅 하나(활성 덱)로 축소한다. 삭제가 아니라 렌더 중단이며,
          `briefing-preset-logic.ts`(순수 로직·단위테스트)·`useTeamPresets`·서버 `/api/presets/team`
          계약은 그대로 둔다 — 컨셉 확정 후 이 자리에 다시 붙이면 된다. */}

      {/* #244: 상대 정보는 **요약 한 줄 + 시트**. 표(244px)+컨디션(209px)이 상단 453px 을 먹으면
          정작 프롬프트가 화면 밖으로 밀린다(개편 전 실측). 마크 원탭도 시트 안에서 한다 —
          "상대를 보고 → 붙일 수비수를 정한다"는 한 흐름이라 갈라놓을 이유가 없다. */}
      {match.opponent && oppOpen && (
        <Modal
          onClose={() => setOppOpen(false)}
          labelledBy="opp-sheet-title"
          overlayClassName={styles.sheetBackdrop}
          overlayTestId="opp-sheet-backdrop"
          className={styles.sheetBox}
          testId="opp-sheet"
        >
          <div className={styles.sheetHead}>
            <b id="opp-sheet-title" className={styles.sheetTitle}>
              상대: {match.opponent.name}
            </b>
            <button
              type="button"
              className={styles.sheetClose}
              data-testid="opp-sheet-close"
              onClick={() => setOppOpen(false)}
            >
              닫기 ×
            </button>
          </div>
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

          {/* 라인업 컨디션 시계 요약 (AC-C1) — 상대 시트 안에 같이 둔다(경기 전 "판을 읽는" 정보 묶음).
              보드 토큰에도 컨디션 시계가 그대로 있으므로 본문에서 접근 경로가 끊기지 않는다. */}
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
        </Modal>
      )}

      {/* 상대 정보가 없는 매치(스키마상 opponent 는 optional)면 시트 진입점 자체가 없다 →
          선발 컨디션 요약이 도달 불가가 되지 않게 본문에 남긴다(독립 검증 M-3). */}
      {!match.opponent && match.conditions && starters.length > 0 && (
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
            onOpponentInfo={match.opponent ? () => setOppOpen(true) : undefined}
            opponentApprox
          />
        </>
      )}

      {rosterMissing && (
        <ErrorToast message="내 로스터를 불러오지 못했습니다 — 새로고침 후 다시 시도하세요" />
      )}
      <ErrorToast message={error} onDismiss={() => setError(null)} />

      <p className={styles.persistNote} data-testid="briefing-persist-note">
        여기서의 편집(라인업·전술·프롬프트·마킹)은 임시가 아니라 내 덱에 저장됩니다 — 킥오프 시 반영됩니다.
      </p>

      <button
        type="button"
        className={styles.kickoff}
        data-testid="kickoff-button"
        disabled={submitting || rosterUnavailable}
        onClick={handleKickoff}
      >
        {submitting ? "전송 중…" : "킥오프"}
      </button>

      {/* 프리셋 덮어쓰기 확인 다이얼로그도 함께 내렸다(#106) — 프리셋 선택 자체가 없으므로 불필요.
          CSS(.confirm*)·공용 Modal 은 그대로 있어 재도입 시 이 자리에 복원하면 된다. */}
    </div>
  );
}
