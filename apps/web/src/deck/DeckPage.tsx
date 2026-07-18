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
import { Layout } from "../common/Layout";
import { ErrorToast } from "../common/ErrorToast";
import {
  assignPlayer,
  bulkApplyPreset,
  emptyDraft,
  findPlayerSlot,
  firstEmptySlot,
  FORMATION_LAYOUTS,
  getSlot,
  removePlayer,
  setPrompt,
  STARTER_COUNT,
  toUpdateRequest,
  validateDraft,
  type DeckDraft,
} from "./deck-logic";
import { SlotGrid, type SlotRef } from "./SlotGrid";
import { PlayerPicker } from "./PlayerPicker";
import { PromptEditor } from "./PromptEditor";
import { PresetPanel } from "./PresetPanel";
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
  const { data: presets } = usePresets();
  const updateDeck = useUpdateDeck();
  const createPreset = useCreatePreset();
  const deletePreset = useDeletePreset();

  const [draft, setDraft] = useState<DeckDraft | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<SlotRef | null>(null);
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [serverError, setServerError] = useState<ServerDeckError | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  // initialize draft once from the server deck (404 → empty deck state)
  useEffect(() => {
    if (draft === null && !deckLoading && !deckError) {
      setDraft(draftFromDeck(deck ?? null));
    }
  }, [draft, deck, deckLoading, deckError]);

  const playersById = useMemo(() => {
    const map = new Map<string, CatalogPlayer>();
    for (const p of players ?? []) map.set(p.id, p);
    return map;
  }, [players]);

  const ownedPlayers = useMemo(() => (players ?? []).filter((p) => p.owned), [players]);

  if (deckLoading || playersLoading || draft === null) {
    return (
      <Layout>
        {deckError ? <ErrorToast message="덱을 불러오지 못했습니다" /> : <p>불러오는 중…</p>}
      </Layout>
    );
  }

  const starterCount = draft.slots.filter((s) => s.role === "starter").length;
  const preIssues = validateDraft(draft, (id) => playersById.get(id)?.position);
  const editingPlayer = editingPlayerId ? playersById.get(editingPlayerId) : undefined;
  const editingSlot = editingPlayerId ? findPlayerSlot(draft, editingPlayerId) : undefined;

  function mutateDraft(next: DeckDraft) {
    setDraft(next);
    setSavedNote(false);
    setServerError(null);
  }

  function handleSlotTap(slot: SlotRef) {
    const occupant = getSlot(draft!, slot.role, slot.slotIndex);
    if (occupant) {
      setEditingPlayerId(occupant.playerId);
      setSelectedSlot(slot);
    } else {
      setSelectedSlot((prev) =>
        prev?.role === slot.role && prev.slotIndex === slot.slotIndex ? null : slot,
      );
      setEditingPlayerId(null);
    }
  }

  function handlePick(playerId: string) {
    const target = selectedSlot ?? firstEmptySlot(draft!);
    if (!target) return; // deck full
    mutateDraft(assignPlayer(draft!, target.role, target.slotIndex, playerId));
    setSelectedSlot(null);
  }

  function handleSave() {
    setServerError(null);
    setSavedNote(false);
    updateDeck.mutate(toUpdateRequest(draft!), {
      onSuccess: (saved) => {
        setDraft(draftFromDeck(saved));
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

  // 클라 사전검증(preIssues)에서 걸린 덱은 서버 왕복 전에 저장을 막는다(#73 P2).
  const saveDisabled =
    updateDeck.isPending || starterCount !== STARTER_COUNT || preIssues.length > 0;

  const header = (
    <div className={styles.headerRow}>
      <button type="button" className={styles.back} onClick={() => navigate("/lobby")}>
        ← 로비
      </button>
      <h1 className={styles.pageTitle}>덱 구성</h1>
      <button
        type="button"
        className={styles.save}
        data-testid="save-deck"
        disabled={saveDisabled}
        onClick={handleSave}
      >
        {updateDeck.isPending ? "저장 중…" : "저장"}
      </button>
    </div>
  );

  return (
    <Layout header={header}>
      <div className={styles.formationRow}>
        <label htmlFor="formation" className={styles.formationLabel}>
          포메이션
        </label>
        <select
          id="formation"
          data-testid="formation-select"
          className={styles.formationSelect}
          value={draft.formation}
          onChange={(e) => mutateDraft({ ...draft, formation: e.target.value })}
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

      <SlotGrid
        draft={draft}
        playersById={playersById}
        selectedSlot={selectedSlot}
        errorPlayerId={serverError?.playerId ?? null}
        onSlotTap={handleSlotTap}
      />

      {/* inline validation: client pre-check + server 400 DECK_INVALID detail (AC-W2) */}
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

      {editingPlayer && editingSlot && (
        <PromptEditor
          player={editingPlayer}
          promptText={editingSlot.promptText ?? ""}
          presets={presets ?? []}
          onChange={(text) => mutateDraft(setPrompt(draft, editingPlayer.id, text))}
          onRemoveFromDeck={() => {
            mutateDraft(removePlayer(draft, editingPlayer.id));
            setEditingPlayerId(null);
            setSelectedSlot(null);
          }}
          onClose={() => setEditingPlayerId(null)}
        />
      )}

      <PlayerPicker players={ownedPlayers} draft={draft} onPick={handlePick} />

      <PresetPanel
        presets={presets ?? []}
        draft={draft}
        playersById={playersById}
        creating={createPreset.isPending}
        onCreate={(name, promptText) =>
          createPreset.mutateAsync({ name, promptText }).then(() => undefined)
        }
        onDelete={(id) => deletePreset.mutateAsync(id).then(() => undefined)}
        onBulkApply={(playerIds, text) => mutateDraft(bulkApplyPreset(draft, playerIds, text))}
      />
    </Layout>
  );
}
