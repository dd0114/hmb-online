import { useMemo, useState } from "react";
import { useMatch, usePlayers, type CatalogPlayer } from "../api/hooks";
import { useSaveTeamPreset, useTeamPresets } from "../api/hooks-v2";
import { Modal } from "../common/Modal";
import { snapshotSummary } from "../deck/preset-selector-logic";
import { TACTICS_KEYS, TACTICS_LABELS } from "../deck/tactics-logic";
import {
  canImportSnapshot,
  defaultImportName,
  defaultImportSlot,
  matchSnapshotToSaveRequest,
  starterIdsInOrder,
} from "./snapshot-import";
import styles from "./MatchSnapshotDialog.module.css";

interface MatchSnapshotDialogProps {
  matchId: string;
  opponentName: string;
  createdAt?: string;
  onClose: () => void;
}

/**
 * "그 경기에 쓴 세팅 보기 → 프리셋으로 저장" 다이얼로그 (이슈 #98 요구 2, W5).
 *
 * 매치 상세(GET /api/matches/{id})의 `userDeckSnapshot`(계약 B, additive)을 요약해 보여주고,
 * 슬롯을 골라 기존 `PUT /api/presets/team/{slot}` 로 저장한다. 직렬화·슬롯 규약은 덱 화면과
 * 동일한 유틸(`snapshot-import` → `snapshotToEditor`/`editorToSaveRequest`/`nextEmptySlot`)을
 * 재사용하므로 덱에서 저장한 프리셋과 저장 포맷이 같다.
 *
 * 스냅샷이 없거나(구 매치·미완) 선발 11이 아니면 저장 버튼을 비활성 + 사유 안내한다.
 */
export function MatchSnapshotDialog({ matchId, opponentName, createdAt, onClose }: MatchSnapshotDialogProps) {
  const { data: detail, isLoading, isError } = useMatch(matchId);
  const { data: presets } = useTeamPresets();
  const { data: players } = usePlayers();
  const savePreset = useSaveTeamPreset();

  const [slotOverride, setSlotOverride] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [savedSlot, setSavedSlot] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const snapshot = detail?.userDeckSnapshot ?? null;
  const importable = canImportSnapshot(snapshot);
  const slots = presets ?? [];
  /**
   * 저장 대상 = 유저 선택 > 빈 슬롯 기본값. 전 슬롯이 차 있으면 **기본 선택 없음(null)** — 파괴적
   * 덮어쓰기는 슬롯을 명시적으로 탭해야만 가능하다(모바일엔 hover 툴팁 경고가 안 보인다).
   */
  const targetSlot = slotOverride ?? (slots.length > 0 ? defaultImportSlot(slots) : null);
  const targetIsFilled = Boolean(slots.find((s) => s.slot === targetSlot)?.snapshot);
  const name = nameDraft ?? defaultImportName(opponentName, createdAt);

  const playersById = useMemo(
    () => new Map<string, CatalogPlayer>((players ?? []).map((p) => [p.id, p])),
    [players],
  );
  const summary = useMemo(
    () => (snapshot ? snapshotSummary(snapshot, playersById) : null),
    [snapshot, playersById],
  );

  async function onSave() {
    if (!snapshot || !importable || targetSlot == null) return;
    setError(null);
    try {
      await savePreset.mutateAsync({
        slot: targetSlot,
        body: matchSnapshotToSaveRequest(snapshot, name.trim() || defaultImportName(opponentName, createdAt)),
      });
      setSavedSlot(targetSlot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "프리셋 저장에 실패했습니다");
    }
  }

  return (
    <Modal
      onClose={onClose}
      labelledBy="match-snapshot-title"
      overlayClassName={styles.overlay}
      className={styles.dialog}
      testId="match-snapshot-dialog"
    >
      <h2 className={styles.title} id="match-snapshot-title">
        이 경기에 쓴 세팅
      </h2>
      <p className={styles.sub}>vs {opponentName}</p>

      {isLoading && <p className={styles.pending}>불러오는 중…</p>}
      {isError && (
        <p className={styles.notice} data-testid="match-snapshot-error">
          세팅을 불러오지 못했습니다.
        </p>
      )}

      {!isLoading && !isError && !snapshot && (
        <p className={styles.notice} data-testid="match-snapshot-none">
          이 경기에는 저장된 세팅이 없습니다(예전 경기). 프리셋으로 가져올 수 없습니다.
        </p>
      )}

      {snapshot && summary && (
        <div data-testid="match-snapshot-summary">
          <div className={styles.metaRow}>
            <span className={styles.formation} data-testid="snapshot-formation">
              {summary.formation}
            </span>
            <span className={styles.power} data-testid="snapshot-power">
              팀 파워 {summary.power}
            </span>
            <span className={styles.count} data-testid="snapshot-starter-count">
              선발 {summary.starterCount}
            </span>
          </div>

          <ul className={styles.starters} data-testid="snapshot-starters">
            {starterIdsInOrder(snapshot).map((playerId) => (
              <li key={playerId} className={styles.starter} data-testid={`snapshot-starter-${playerId}`}>
                {playersById.get(playerId)?.name ?? playerId}
              </li>
            ))}
          </ul>

          {summary.tactics && (
            <ul className={styles.tactics} data-testid="snapshot-tactics">
              {TACTICS_KEYS.map((key) => (
                <li key={key} className={styles.tactic}>
                  <span className={styles.tacticLabel}>{TACTICS_LABELS[key]}</span>
                  <span className={styles.tacticValue} data-testid={`snapshot-tactic-${key}`}>
                    {summary.tactics?.[key]?.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* 서버 snapshotDeck 은 현재 teamPrompt 를 매치 스냅샷에 저장하지 않는다 → 로그→프리셋
              경로에서는 사실상 항상 빈 값(저장 포맷이 확장되면 자동으로 표시되는 방어 분기). */}
          {summary.teamPrompt && (
            <p className={styles.teamPrompt} data-testid="snapshot-team-prompt">
              “{summary.teamPrompt}”
            </p>
          )}

          {!importable && (
            <p className={styles.notice} data-testid="match-snapshot-incomplete">
              선발 11명이 채워지지 않은 세팅이라 프리셋으로 저장할 수 없습니다.
            </p>
          )}
        </div>
      )}

      {snapshot && importable && (
        <div className={styles.saveBox}>
          <span className={styles.saveLabel}>프리셋으로 저장</span>
          <div className={styles.slotRow} role="group" aria-label="저장할 슬롯">
            {[...slots].sort((a, b) => a.slot - b.slot).map((s) => {
              const filled = Boolean(s.snapshot);
              return (
                <button
                  key={s.slot}
                  type="button"
                  className={[styles.slotChip, targetSlot === s.slot ? styles.slotChipActive : ""]
                    .filter(Boolean)
                    .join(" ")}
                  data-testid={`snapshot-slot-${s.slot}`}
                  data-selected={targetSlot === s.slot ? "true" : "false"}
                  data-filled={filled ? "true" : "false"}
                  title={filled ? `${s.slot}. ${s.name ?? "프리셋"} (덮어쓰기)` : `슬롯 ${s.slot} — 빈 슬롯`}
                  onClick={() => {
                    setSlotOverride(s.slot);
                    setSavedSlot(null);
                  }}
                >
                  <span className={styles.slotNo}>{s.slot}</span>
                  <span className={styles.slotName}>{filled ? (s.name ?? "프리셋") : "빈 슬롯"}</span>
                </button>
              );
            })}
          </div>

          <input
            className={styles.nameInput}
            data-testid="snapshot-name-input"
            aria-label="프리셋 이름"
            maxLength={16}
            value={name}
            onChange={(e) => {
              setNameDraft(e.target.value);
              setSavedSlot(null);
            }}
          />

          <button
            type="button"
            className={styles.saveButton}
            data-testid="snapshot-save"
            disabled={savePreset.isPending || !name.trim() || targetSlot == null}
            data-target-slot={targetSlot ?? ""}
            onClick={onSave}
          >
            {/* 파괴성은 툴팁이 아니라 버튼 라벨로 드러낸다(모바일엔 hover 가 없다). */}
            {savePreset.isPending
              ? "저장 중…"
              : targetSlot == null
                ? "저장할 슬롯을 선택하세요"
                : targetIsFilled
                  ? `슬롯 ${targetSlot} 덮어쓰기`
                  : `슬롯 ${targetSlot}에 저장`}
          </button>

          {savedSlot != null && (
            <p className={styles.saved} data-testid="snapshot-saved" role="status">
              슬롯 {savedSlot}에 저장했습니다.
            </p>
          )}
          {error && (
            <p className={styles.notice} data-testid="snapshot-save-error">
              {error}
            </p>
          )}
        </div>
      )}

      <button type="button" className={styles.close} data-testid="match-snapshot-close" onClick={onClose}>
        닫기
      </button>
    </Modal>
  );
}
