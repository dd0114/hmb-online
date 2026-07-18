import { useEffect, useMemo, useState } from "react";
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
  duplicateRequest,
  useApplyTeamPreset,
  useRelations,
  useSaveTeamPreset,
  useTeamPresets,
} from "../api/hooks-v2";
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import { TeamMoraleWidget } from "../common/RelationBits";
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
import { DeckEditor } from "./DeckEditor";
import { TeamPresetSlots } from "./TeamPresetSlots";
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

export function DeckPage() {
  const navigate = useNavigate();
  const { data: deck, isLoading: deckLoading, isError: deckError } = useDeck();
  const { data: players, isLoading: playersLoading } = usePlayers();
  const { data: presets } = useTeamPresets();
  const { data: promptPresets } = usePresets();
  const { data: relations } = useRelations();
  const updateDeck = useUpdateDeck();
  const createPreset = useCreatePreset();
  const deletePreset = useDeletePreset();
  const saveTeamPreset = useSaveTeamPreset();
  const applyTeamPreset = useApplyTeamPreset();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [aiManaged, setAiManaged] = useState(false);
  const [serverError, setServerError] = useState<ServerDeckError | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    if (editor === null && !deckLoading && !deckError) {
      setEditor({ draft: draftFromDeck(deck ?? null), tactics: { ...DEFAULT_TEAM_TACTICS }, teamPrompt: "" });
    }
  }, [editor, deck, deckLoading, deckError]);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);

  const ownedPlayers = useMemo(() => (players ?? []).filter((p) => p.owned), [players]);

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

  function mutateEditor(next: EditorState) {
    setEditor(next);
    setSavedNote(false);
    setServerError(null);
  }

  function handleSave() {
    setServerError(null);
    setSavedNote(false);
    updateDeck.mutate(toUpdateRequest(editor!.draft), {
      onSuccess: (saved) => {
        setEditor((prev) => ({ ...prev!, draft: draftFromDeck(saved) }));
        setSavedNote(true);
      },
      onError: (err) => {
        if (err instanceof ApiError) {
          const detail = err.detail ?? {};
          setServerError({
            rule: typeof detail.rule === "string" ? detail.rule : err.code,
            message: err.message,
            playerId: typeof detail.playerId === "string" ? detail.playerId : null,
          });
        } else {
          setServerError({ rule: "NETWORK", message: "저장에 실패했습니다", playerId: null });
        }
      },
    });
  }

  const slots = presets ?? [];

  async function handleSnapshotSave(slot: number, name: string) {
    if (!snapshotSaveable(editor!.draft)) {
      throw new Error(`선발 ${STARTER_COUNT}명을 채워야 스냅샷을 저장할 수 있습니다`);
    }
    await saveTeamPreset.mutateAsync({ slot, body: editorToSaveRequest(editor!, name) });
  }

  async function handleSnapshotLoad(slot: number) {
    await applyTeamPreset.mutateAsync(slot); // server: snapshot → active deck
    const src = slots.find((s) => s.slot === slot);
    if (src?.snapshot) mutateEditor(snapshotToEditor(src.snapshot));
  }

  async function handleSnapshotRename(slot: number, name: string) {
    const src = slots.find((s) => s.slot === slot);
    if (!src?.snapshot) return;
    await saveTeamPreset.mutateAsync({ slot, body: editorToSaveRequest(snapshotToEditor(src.snapshot), name) });
  }

  async function handleSnapshotDuplicate(from: number, to: number) {
    const src = slots.find((s) => s.slot === from);
    const body = src ? duplicateRequest(src) : null;
    if (!body) throw new Error("복제할 스냅샷이 없습니다");
    await saveTeamPreset.mutateAsync({ slot: to, body });
  }

  const saveDisabled =
    updateDeck.isPending || starterCount !== STARTER_COUNT || preIssues.length > 0;

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle}>덱 · 전술보드</h1>
      <button
        type="button"
        className={styles.save}
        data-testid="save-deck"
        disabled={saveDisabled}
        onClick={handleSave}
      >
        {updateDeck.isPending ? "저장 중…" : "덱 저장"}
      </button>
    </div>
  );

  return (
    <Layout header={header} nav>
      <TeamMoraleWidget relations={relations} />

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

      <DeckEditor
        state={editor}
        onChange={mutateEditor}
        aiManaged={aiManaged}
        onToggleAi={setAiManaged}
        players={ownedPlayers}
        playersById={playersById}
        relations={relations}
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

      <TeamPresetSlots
        slots={slots}
        saving={saveTeamPreset.isPending || applyTeamPreset.isPending}
        onSave={handleSnapshotSave}
        onLoad={handleSnapshotLoad}
        onRename={handleSnapshotRename}
        onDuplicate={handleSnapshotDuplicate}
      />

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
    </Layout>
  );
}
