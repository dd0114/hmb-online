import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  useCreatePreset,
  useDeck,
  useDeletePreset,
  usePlayers,
  usePresets,
  useUpdateDeck,
  type CatalogPlayer,
  type Deck,
} from "../api/hooks";
import {
  useApplyTeamPreset,
  useRelations,
  useTodayConditions,
  useSaveTeamPreset,
  useTeamPresets,
} from "../api/hooks-v2";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { Modal } from "../common/Modal";
import { TeamMoraleWidget } from "../common/RelationBits";
import { useNavGuardRun, useRegisterNavGuard, type NavGuard } from "../common/NavGuard";
import {
  bulkApplyPreset,
  emptyDraft,
  FORMATION_LAYOUTS,
  STARTER_COUNT,
  toUpdateRequest,
  validateDraft,
  type DeckDraft,
} from "./deck-logic";
import { PresetPanel } from "./PresetPanel";
import {
  DEFAULT_TEAM_TACTICS,
  editorToSaveRequest,
  snapshotSaveable,
  snapshotToEditor,
  type EditorState,
} from "./tactics-logic";
import {
  isDirty,
  makeBaseline,
  nextEmptySlot,
  slotByNumber,
  type EditorBaseline,
} from "./preset-selector-logic";
import { autoBuildLineup, canAutoBuild } from "./auto-lineup";
import { DeckEditor } from "./DeckEditor";
import { SlotSelector } from "./SlotSelector";
import { PresetSummary } from "./PresetSummary";
import styles from "./DeckPage.module.css";

interface ServerDeckError {
  rule: string;
  message: string;
  playerId: string | null;
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
 * Preset-centric deck screen (이슈 #98 W1). Reorganized from "active-deck editor + bottom 3 slots"
 * into "SELECTED preset on top → editor below → compact slot selector".
 *
 * ── 활성덱 ↔ 프리셋 동기화 결정 (요구 3) ──────────────────────────────────────────────────
 * 게임 시작(연습/리그)은 서버 활성 덱(PUT /api/deck)을 읽는다. 이 화면은 프리셋을 편집하되 활성 덱을
 * 항상 최신 상태로 유지한다:
 *   - 슬롯 선택(칩 클릭) → POST /api/presets/team/{slot}/apply 로 활성 덱을 그 스냅샷으로 동기화.
 *   - "저장" → PUT /api/deck(활성 덱) + (슬롯 선택 시) PUT /api/presets/team/{slot}(프리셋). 둘 다 같은
 *     편집 상태에서 직렬화하므로 활성 덱과 프리셋이 일치한다.
 *   - "새 프리셋" → PUT preset + apply → 새 프리셋이 활성 덱이 된다.
 * 결과: 마지막으로 저장/선택한 프리셋이 항상 활성 덱과 일치 → 게임 시작이 보이는 라인업을 그대로 쓴다.
 * (첫 진입/프리셋 미선택 시엔 활성 덱 자체를 편집·저장하므로 연습·리그가 요구하는 "활성 덱" 전제는 유지.)
 */
export function DeckPage() {
  const navigate = useNavigate();
  const runGuard = useNavGuardRun();
  const { data: deck, isLoading: deckLoading, isError: deckError } = useDeck();
  const { data: players, isLoading: playersLoading } = usePlayers();
  const presetsQuery = useTeamPresets();
  const presets = presetsQuery.data;
  const { data: promptPresets } = usePresets();
  const { data: relations } = useRelations();
  // 요구 6: 당일(KST) 컨디션 — 보드 토큰/선수 시트/보유 선수 리스트에 표시. 실패해도 화면은 그대로.
  const { data: conditions } = useTodayConditions();
  const updateDeck = useUpdateDeck();
  const createPreset = useCreatePreset();
  const deletePreset = useDeletePreset();
  const saveTeamPreset = useSaveTeamPreset();
  const applyTeamPreset = useApplyTeamPreset();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorName, setEditorName] = useState("");
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [baseline, setBaseline] = useState<EditorBaseline | null>(null);
  const [aiManaged, setAiManaged] = useState(false);
  const [serverError, setServerError] = useState<ServerDeckError | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);

  const slots = useMemo(() => presets ?? [], [presets]);
  const presetsSettled = presetsQuery.isSuccess || presetsQuery.isError;

  // Initial load: display the lowest saved preset (game-start SoT already persisted server-side, so
  // this is display-only — no apply). No presets yet → fall back to the active deck (first entry).
  useEffect(() => {
    if (editor !== null || deckLoading || deckError || playersLoading || !presetsSettled) return;
    const filled = [...slots].sort((a, b) => a.slot - b.slot).find((s) => s.snapshot);
    if (filled?.snapshot) {
      const ed = snapshotToEditor(filled.snapshot);
      const name = filled.name ?? `프리셋 ${filled.slot}`;
      setEditor(ed);
      setEditorName(name);
      setSelectedSlot(filled.slot);
      setBaseline(makeBaseline(ed, name, filled.slot));
    } else {
      const ed: EditorState = {
        draft: draftFromDeck(deck ?? null),
        tactics: { ...DEFAULT_TEAM_TACTICS },
        teamPrompt: "",
      };
      setEditor(ed);
      setEditorName("");
      setSelectedSlot(null);
      setBaseline(makeBaseline(ed, "", null));
    }
  }, [editor, deck, deckLoading, deckError, playersLoading, presetsSettled, slots]);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);

  const ownedPlayers = useMemo(() => (players ?? []).filter((p) => p.owned), [players]);

  const dirty = editor != null && baseline != null && isDirty(editor, editorName, baseline);

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

  if (deckLoading || playersLoading || !presetsSettled || editor === null) {
    return (
      <Layout>
        {deckError ? <ErrorToast message="덱을 불러오지 못했습니다" /> : <p>불러오는 중…</p>}
      </Layout>
    );
  }

  const draft = editor.draft;
  const starterCount = draft.slots.filter((s) => s.role === "starter").length;
  const preIssues = validateDraft(draft, (id) => playersById.get(id)?.position);
  const saveable = snapshotSaveable(draft);
  const selectedSlotData = slotByNumber(slots, selectedSlot);
  const busy = updateDeck.isPending || saveTeamPreset.isPending || applyTeamPreset.isPending;

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

  /** "저장" — overwrite: active deck (always) + the selected preset slot (if any). Returns success. */
  async function handleSave(): Promise<boolean> {
    setServerError(null);
    setSavedNote(false);
    try {
      await updateDeck.mutateAsync(toUpdateRequest(editor!.draft));
      if (selectedSlot != null && snapshotSaveable(editor!.draft)) {
        await saveTeamPreset.mutateAsync({
          slot: selectedSlot,
          body: editorToSaveRequest(editor!, editorName || `프리셋 ${selectedSlot}`),
        });
      }
      setBaseline(makeBaseline(editor!, editorName, selectedSlot));
      setSavedNote(true);
      return true;
    } catch (err) {
      setServerErrorFrom(err, "저장에 실패했습니다");
      return false;
    }
  }

  /** "새 프리셋" — save into the next empty slot under `name`, then apply → active deck (요구 2·4). */
  async function handleSaveNew(name: string) {
    const target = nextEmptySlot(slots);
    if (target == null) throw new Error("빈 슬롯이 없습니다");
    if (!snapshotSaveable(editor!.draft)) {
      throw new Error(`선발 ${STARTER_COUNT}명을 채워야 저장할 수 있습니다`);
    }
    await saveTeamPreset.mutateAsync({ slot: target, body: editorToSaveRequest(editor!, name) });
    await applyTeamPreset.mutateAsync(target); // active deck = 새 프리셋
    setSelectedSlot(target);
    setEditorName(name);
    setBaseline(makeBaseline(editor!, name, target));
    setSavedNote(true);
    setServerError(null);
  }

  /** Actually load a slot: filled → snapshot into editor + apply to active deck; empty → target only. */
  function performSelectSlot(slot: number) {
    setSavedNote(false);
    setSelectedSlot(slot);
    const src = slotByNumber(slots, slot);
    if (!src?.snapshot) return; // empty slot: just the target; keep current editor
    const ed = snapshotToEditor(src.snapshot);
    const name = src.name ?? `프리셋 ${slot}`;
    setEditor(ed);
    setEditorName(name);
    setBaseline(makeBaseline(ed, name, slot));
    setServerError(null);
    applyTeamPreset.mutate(slot, {
      onError: (err) => setServerErrorFrom(err, "프리셋 적용에 실패했습니다"),
    });
  }

  /**
   * Slot select entry (N1 데이터손실 방지): loading a FILLED slot replaces the editor, so when the
   * current editor is dirty we route it through the same nav guard → confirm dialog (저장 후 전환 /
   * 버리고 전환 / 취소). Selecting an EMPTY slot only sets the save target (no editor loss) → immediate.
   */
  function handleSelectSlot(slot: number) {
    const src = slotByNumber(slots, slot);
    if (!src?.snapshot) {
      performSelectSlot(slot);
      return;
    }
    runGuard(() => performSelectSlot(slot));
  }

  /** Inline rename of the selected filled slot (요구 2 이름 저장): re-save the SAVED snapshot under a
   * new name (content unchanged), then sync the local name so dirty tracking stays consistent. */
  async function handleRename(newName: string) {
    if (selectedSlot == null) return;
    const src = slotByNumber(slots, selectedSlot);
    if (!src?.snapshot) return;
    await saveTeamPreset.mutateAsync({
      slot: selectedSlot,
      body: editorToSaveRequest(snapshotToEditor(src.snapshot), newName),
    });
    setEditorName(newName);
    setBaseline((b) => (b ? { ...b, name: newName } : b));
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

  const saveDisabled =
    busy || starterCount !== STARTER_COUNT || preIssues.length > 0;

  const header = (
    <div className={styles.headerRow}>
      <button
        type="button"
        className={styles.back}
        data-testid="deck-back"
        onClick={() => runGuard(() => navigate("/lobby"))}
      >
        ← 로비
      </button>
      <h1 className={styles.pageTitle}>덱 · 전술보드</h1>
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
      {/* ≥1024px: 페이지 전체를 DeckEditor 2컬럼(940px)과 같은 폭으로 정렬한다(W6b-1). */}
      <div className={styles.page}>
      <div className={styles.topGrid}>
        <PresetSummary
          slot={selectedSlotData}
          playersById={playersById}
          dirty={dirty}
          busy={busy}
          onRename={handleRename}
        />

        <SlotSelector
          slots={slots}
          selectedSlot={selectedSlot}
          busy={busy}
          saveable={saveable}
          onSelect={handleSelectSlot}
          onNew={handleSaveNew}
        />
      </div>

      <TeamMoraleWidget relations={relations} />

      <div className={styles.controlsRow}>
      <div className={styles.formationRow}>
        <label htmlFor="formation" className={styles.formationLabel}>
          포메이션
        </label>
        <select
          id="formation"
          data-testid="formation-select"
          className={styles.formationSelect}
          value={draft.formation}
          onChange={(e) => mutateEditor({ ...editor, draft: { ...draft, formation: e.target.value } })}
        >
          {Object.keys(FORMATION_LAYOUTS).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <span className={styles.starterCount} data-testid="starter-count">
          선발 {starterCount}/{STARTER_COUNT}
        </span>
      </div>

      {/* 요구 3 — Auto 구성: 보유 선수만으로 결정론적 최적 스쿼드 자동 구성(RNG·AI 콜 없음). */}
      <div className={styles.autoRow}>
        <button
          type="button"
          className={styles.autoBtn}
          data-testid="auto-fill"
          disabled={busy || !canAutoBuild(ownedPlayers)}
          onClick={() => mutateEditor(autoBuildLineup(ownedPlayers))}
        >
          Auto 구성
        </button>
        <span className={styles.autoHint}>
          {canAutoBuild(ownedPlayers)
            ? "보유 선수로 최적 포메이션·선발·기본 지시를 자동 배치합니다"
            : `보유 선수 부족 (${ownedPlayers.length}/${STARTER_COUNT})`}
        </span>
      </div>
      </div>

      <DeckEditor
        state={editor}
        onChange={mutateEditor}
        aiManaged={aiManaged}
        onToggleAi={setAiManaged}
        players={ownedPlayers}
        playersById={playersById}
        relations={relations}
        conditions={conditions}
        errorPlayerId={serverError?.playerId ?? null}
      />

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

      {/* 프롬프트 프리셋 일괄 적용(AC-W2, phase1) — 팀 스냅샷과 별개의 선수-프롬프트 도구 */}
      <PresetPanel
        presets={promptPresets ?? []}
        draft={draft}
        playersById={playersById}
        creating={createPreset.isPending}
        onCreate={(name, promptText) =>
          createPreset.mutateAsync({ name, promptText }).then(() => undefined)
        }
        onDelete={(id) => deletePreset.mutateAsync(id).then(() => undefined)}
        onBulkApply={(playerIds, text) =>
          mutateEditor({ ...editor, draft: bulkApplyPreset(draft, playerIds, text) })
        }
      />
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
    </Layout>
  );
}
