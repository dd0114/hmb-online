import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useDeck, usePlayers, useUpdateDeck, type CatalogPlayer, type Deck } from "../api/hooks";
import { useRelations, useTodayConditions } from "../api/hooks-v2";
import { Layout } from "../common/Layout";
import { TeamMoraleWidget } from "../common/RelationBits";
import { CardGrowthDetail } from "../codex/CardGrowthDetail";
import { useNavLocked } from "../common/nav-lock";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { useNavGuardRun, useRegisterNavGuard, type NavGuard } from "../common/NavGuard";
import {
  emptyDraft,
  STARTER_COUNT,
  toUpdateRequest,
  validateDraft,
  type DeckDraft,
} from "./deck-logic";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "./tactics-logic";
import { isDirty, makeBaseline, type EditorBaseline } from "./preset-selector-logic";
import { autoBuildLineup, canAutoBuild } from "./auto-lineup";
import { DeckEditor } from "./DeckEditor";
import styles from "./DeckPage.module.css";

interface ServerDeckError {
  rule: string;
  message: string;
  playerId: string | null;
}

function draftFromDeck(deck: Deck | null): DeckDraft {
  // ⚠️ `!deck` 만으로 부족하다 — 200 `{}` 는 truthy 라 통과하고 `slots.map` 이 던진다
  //    (그러면 덱 화면이 흰 화면이다, #286 독립검증 MAJ-3).
  if (!deck || !Array.isArray(deck.slots)) return emptyDraft();
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
 * 덱 화면 = **팀 시트 하나** (이슈 #106 R1 재설계).
 *
 * ── 프리셋 UI 를 화면에서 내린 이유 (#106) ─────────────────────────────────────────────────
 * #98 은 이 화면을 "프리셋 중심"(3슬롯 선택기 + 선택 프리셋 요약 카드 + 프롬프트 프리셋 패널)으로
 * 조립했으나, hero 실플레이 판정은 **컨셉이 잡히기 전의 프리셋은 시기상조**였다 — 저장/불러오기/
 * 이력이 먼저 들어와 복잡도만 올리고, 무엇이 무엇을 결정하는지(전술보드가 SoT) 인지선을 끊었다.
 * 그래서 R1 은 **세팅 하나만** 편집·저장한다: 이 화면은 항상 활성 덱(PUT /api/deck)을 대상으로 한다.
 *
 * ⚠️ 삭제가 아니라 **화면에서 내린 것**이다 — 컨셉 확정 후 재도입에 대비해
 *   - 컴포넌트 파일: `SlotSelector.tsx` · `PresetSummary.tsx` · `PresetPanel.tsx` (렌더만 중단, 파일 존치)
 *   - 훅/계약: `useTeamPresets`/`useSaveTeamPreset`/`useApplyTeamPreset`(hooks-v2, `/api/presets/team`),
 *     `usePresets`/`useCreatePreset`/`useDeletePreset`(`/api/presets`), 서버 `userDeckSnapshot`
 *   - 순수 로직: `preset-selector-logic.ts`(dirty 추적은 여기서 계속 쓴다) · `tactics-logic` 스냅샷 직렬화
 *   는 전부 그대로 둔다. 되돌리려면 이 파일에서 다시 렌더하면 된다.
 *
 * dirty 가드(요구 5, #98)는 유지한다 — 프리셋 슬롯 개념만 사라지고(slot=null) 미저장 이탈 확인은 그대로.
 */
export function DeckPage() {
  const navigate = useNavigate();
  const runGuard = useNavGuardRun();
  const { data: deck, isLoading: deckLoading, isError: deckError } = useDeck();
  const { data: players, isLoading: playersLoading } = usePlayers();
  const { data: relations } = useRelations();
  // 당일(KST) 컨디션 — 보드 토큰/리스트/레일 헤드에 표시. 실패해도 화면은 그대로.
  const { data: conditions } = useTodayConditions();
  const updateDeck = useUpdateDeck();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [baseline, setBaseline] = useState<EditorBaseline | null>(null);
  const [aiManaged, setAiManaged] = useState(false);
  const [serverError, setServerError] = useState<ServerDeckError | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  /**
   * 강화 시트 (#286 W3) — **페이지가 소유**한다. 에디터가 들고 있으면 보드 상태가 바뀔 때마다
   * 시트가 같이 흔들리고, 무엇보다 선수 탭과 **같은 컴포넌트**를 연다는 사실이 흐려진다.
   */
  const [growthPlayer, setGrowthPlayer] = useState<CatalogPlayer | null>(null);
  /**
   * 경기 중에는 강화만 잠근다(hero 2R).
   *
   * ⚠️ **덱 전체를 잠그면 안 된다** — 하프타임 지시를 쓰러 오는 자리이기 때문이다. 능력치를
   * 바꾸는 것만 막는다: 진행 중인 시뮬이 이미 그 값으로 돌고 있어 도중에 바뀌면 어긋난다.
   */
  const matchLocked = useNavLocked();
  const growthLockedReason = matchLocked ? "경기 중에는 강화할 수 없습니다" : null;

  // 첫 진입: 활성 덱 하나만 로드한다(프리셋 조회/적용 없음 — #106).
  useEffect(() => {
    if (editor !== null || deckLoading || deckError || playersLoading) return;
    const ed: EditorState = {
      draft: draftFromDeck(deck ?? null),
      tactics: { ...DEFAULT_TEAM_TACTICS },
      // 저장된 팀 문장을 다시 채운다(#253) — 이걸 늘 ""로 시작하면 유저가 쓴 문장이 서버에
      // 남아 있어도 화면엔 없고, 그 상태로 저장하면 전체 교체라 실제로 지워진다.
      teamPrompt: deck?.teamPrompt ?? "",
    };
    setEditor(ed);
    setBaseline(makeBaseline(ed, "", null));
  }, [editor, deck, deckLoading, deckError, playersLoading]);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of Array.isArray(players) ? players : []) map.set(p.id, p);
    return map;
  }, [players]);

  const ownedPlayers = useMemo(() => (Array.isArray(players) ? players : []).filter((p) => p.owned), [players]);

  const dirty = editor != null && baseline != null && isDirty(editor, "", baseline);

  // Navigation guard (요구 5): while dirty, defer any in-app navigation to the confirm dialog.
  const guard = useCallback<NavGuard>((commit) => setPendingNav(() => commit), []);
  useRegisterNavGuard(dirty ? guard : null);

  // Best-effort refresh/close guard (browser-native prompt).
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  if (deckLoading || playersLoading || editor === null) {
    return (
      <Layout>
        {deckError ? <ErrorToast message="덱을 불러오지 못했습니다" /> : <p>불러오는 중…</p>}
      </Layout>
    );
  }

  const draft = editor.draft;
  const starterCount = draft.slots.filter((s) => s.role === "starter").length;
  const preIssues = validateDraft(draft, (id) => playersById.get(id)?.position);
  const busy = updateDeck.isPending;

  function mutateEditor(next: EditorState) {
    setEditor(next);
    setSavedNote(false);
    setServerError(null);
  }

  function setServerErrorFrom(err: unknown, fallback: string) {
    if (err instanceof ApiError) {
      const detail = err.detail ?? {};
      setServerError({
        rule: typeof detail.rule === "string" ? detail.rule : err.code,
        message: err.message,
        playerId: typeof detail.playerId === "string" ? detail.playerId : null,
      });
    } else {
      setServerError({ rule: "NETWORK", message: fallback, playerId: null });
    }
  }

  /** "저장" — 활성 덱 하나만 덮어쓴다(PUT /api/deck). 프리셋 슬롯 저장 경로는 화면에서 내렸다(#106). */
  async function handleSave(): Promise<boolean> {
    setServerError(null);
    setSavedNote(false);
    try {
      await updateDeck.mutateAsync(toUpdateRequest(editor!.draft, editor!.teamPrompt));
      setBaseline(makeBaseline(editor!, "", null));
      setSavedNote(true);
      return true;
    } catch (err) {
      setServerErrorFrom(err, "저장에 실패했습니다");
      return false;
    }
  }

  function handleDialogSave() {
    void handleSave().then((ok) => {
      if (!ok) return; // keep dialog open; error shows below
      const go = pendingNav;
      setPendingNav(null);
      go?.();
    });
  }

  function handleDialogDiscard() {
    const go = pendingNav;
    setPendingNav(null);
    go?.();
  }

  const saveDisabled = busy || starterCount !== STARTER_COUNT || preIssues.length > 0;

  const header = (
    <div className={styles.headerRow}>
      <button
        type="button"
        className={styles.back}
        data-testid="deck-back"
        onClick={() => runGuard(() => navigate("/home"))}
      >
        ← 홈
      </button>
      <h1 className={styles.pageTitle}>덱 · 전술보드</h1>
      {dirty && (
        <span className={styles.dirtyBadge} data-testid="deck-dirty-badge">
          미저장
        </span>
      )}
      <button
        type="button"
        className={styles.save}
        data-testid="save-deck"
        disabled={saveDisabled}
        onClick={() => void handleSave()}
      >
        {busy ? "저장 중…" : "저장"}
      </button>
    </div>
  );

  return (
    <Layout header={header} nav>
      {/* 팀 사기 — #286 에서 로비가 없어지며 갈 곳을 잃었다. 설계(§3.1 "덜어낸 것의 행선지")가
          [덱]으로 지정한 자리다: 사기·컨디션은 **라인업을 짤 때 쓰는 값**이라 여기가 맞다.
          ⚠️ 소비처가 0 이 되면 위젯은 정의만 남고 화면에서 조용히 사라진다(독립검증 BL-1 이
          그 상태를 잡았다) — `deck-teamsheet` 계약이 이제 존재를 지킨다. */}
      <TeamMoraleWidget relations={relations} compact />
      <DeckEditor
        onOpenGrowth={(p) => setGrowthPlayer(p)}
        growthLockedReason={growthLockedReason}
        state={editor}
        onChange={mutateEditor}
        aiManaged={aiManaged}
        onToggleAi={setAiManaged}
        players={ownedPlayers}
        playersById={playersById}
        relations={relations}
        conditions={conditions}
        errorPlayerId={serverError?.playerId ?? null}
        onAuto={() => mutateEditor(autoBuildLineup(ownedPlayers))}
        autoDisabled={busy || !canAutoBuild(ownedPlayers)}
        autoHint={
          canAutoBuild(ownedPlayers)
            ? "보유 선수로 최적 포메이션·선발·기본 지시를 자동 배치합니다"
            : `보유 선수 부족 (${ownedPlayers.length}/${STARTER_COUNT})`
        }
      />

      <div className={styles.notes}>
        {preIssues.length > 0 && (
          <ul className={styles.issueList} data-testid="deck-pre-issues">
            {preIssues.map((issue) => (
              <li key={issue.rule + (issue.playerId ?? "")} className={styles.issue}>
                {issue.message}
              </li>
            ))}
          </ul>
        )}
        {serverError && (
          <p className={styles.serverError} data-testid="deck-server-error">
            저장 실패 [{serverError.rule}] {serverError.message}
            {serverError.playerId && playersById.get(serverError.playerId)
              ? ` — ${playersById.get(serverError.playerId)!.name}`
              : ""}
          </p>
        )}
        {savedNote && (
          <p className={styles.savedNote} data-testid="deck-saved-note">
            저장되었습니다
          </p>
        )}
      </div>

      {/* 미저장 이탈 확인(요구 5) — a11y 셸은 공통 Modal 재사용(포커스 트랩·Esc=취소·포커스 복원). */}
      {pendingNav && (
        <Modal
          onClose={() => setPendingNav(null)}
          labelledBy="leave-confirm-title"
          overlayClassName={styles.dialogBackdrop}
          overlayTestId="leave-confirm-backdrop"
          className={styles.dialog}
          testId="leave-confirm-dialog"
        >
          <p id="leave-confirm-title" className={styles.dialogText}>
            저장하지 않은 변경사항이 있습니다. 저장할까요?
          </p>
          <div className={styles.dialogActions}>
            <button
              type="button"
              className={styles.dialogSave}
              data-testid="leave-save"
              disabled={saveDisabled}
              onClick={handleDialogSave}
            >
              저장
            </button>
            <button
              type="button"
              className={styles.dialogDiscard}
              data-testid="leave-discard"
              onClick={handleDialogDiscard}
            >
              버리고 이동
            </button>
            <button
              type="button"
              className={styles.dialogCancel}
              data-testid="leave-cancel"
              onClick={() => setPendingNav(null)}
            >
              취소
            </button>
          </div>
        </Modal>
      )}

      {/* 선수 탭이 여는 것과 **같은 컴포넌트**다 — hero 가 말한 "덱과 싱크"가 문서가 아니라
          구조로 보장된다. 출처만 표시해 두 진입점을 계약이 구분할 수 있게 한다. */}
      {growthPlayer && (
        <CardGrowthDetail
          player={growthPlayer}
          source="deck"
          onClose={() => setGrowthPlayer(null)}
        />
      )}
    </Layout>
  );
}
