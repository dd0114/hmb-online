import { useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { CatalogPlayer } from "../api/hooks";
import type { ConditionMap, RelationsResponse } from "../api/v2";
import { relationOf } from "../common/relations";
import { findPlayerSlot, removePlayer, setPrompt, type DeckDraft } from "./deck-logic";
import { movePlayerToSlot, type EditorState } from "./tactics-logic";
import { teamPower } from "./team-power";
import {
  parseDroppableId,
  playerIdFromDragId,
  slotNumberLabel,
  TacticsBoard,
  type SlotRef,
} from "./TacticsBoard";
import { autoFilterFor, NO_SELECTION, tapPoolPlayer, tapSlot, type TapSelection } from "./tap-place";
import { TeamSheetBar } from "./TeamSheetBar";
import { DirectiveRail } from "./DirectiveRail";
import { PlayerPicker } from "./PlayerPicker";
import styles from "./DeckEditor.module.css";

export interface DeckEditorProps {
  state: EditorState;
  onChange: (state: EditorState) => void;
  /** "AI에 맡기기" — when true, team tactics are managed by AI (sliders disabled/omitted). */
  aiManaged: boolean;
  onToggleAi: (aiManaged: boolean) => void;
  /** owned players (pool). */
  players: CatalogPlayer[];
  playersById: Map<string, CatalogPlayer>;
  /** 컨디션 {playerId: 0..1} — 보드 토큰 + 리스트 행 + 레일 헤드에 쓰인다. */
  conditions?: ConditionMap;
  /** relations (AC-C4) — feeds the rail head trust gauge + personality badge. */
  relations?: RelationsResponse;
  opponentPower?: number;
  opponentName?: string;
  opponentApprox?: boolean;
  errorPlayerId?: string | null;
  /** Auto 배치(결정론 auto-lineup) — 덱 화면만 넘긴다. */
  onAuto?: () => void;
  autoDisabled?: boolean;
  autoHint?: string;
}

/**
 * 팀 시트 (이슈 #106 R1) — 덱 화면의 **유일한** 화면 단위.
 *
 * #98 의 "여러 입력 블록(프리셋/보드/시트/슬라이더/프롬프트/리스트)" 구성을 hero 가 실플레이에서
 * 기각했다(#106): 전술보드가 SoT 가 아니고 인지선이 끊긴다. R1 은 골격을 세 덩어리로 재편한다:
 *
 *   ① 시트 바(sticky)  — 포메이션 · 전력 게이지 · 선발/벤치/지시 3지표          (TeamSheetBar)
 *   ② 전술보드(SoT)    — 피치 + 벤치 + 하단 바가 **한 카드**                     (TacticsBoard)
 *   ③ 컨텍스트 지시 레일 — 선택 없으면 팀 지시 / 선수 탭하면 그 선수 지시        (DirectiveRail)
 *
 * 보유 선수 리스트는 ②의 공급원으로 붙는다(데스크탑 좌측 / 모바일 보드 아래).
 * 선수정보 시트(PlayerSheet)는 없앴다 — 신원은 레일 헤드 한 줄로 끝난다(#106 요구 2).
 * 배치는 탭-투-플레이스가 1급(tap-place.ts), 드래그(@dnd-kit)는 보조로 유지한다.
 */
export function DeckEditor(props: DeckEditorProps) {
  const {
    state,
    onChange,
    aiManaged,
    onToggleAi,
    players,
    playersById,
    conditions,
    relations,
    opponentPower,
    opponentName,
    opponentApprox,
    errorPlayerId,
    onAuto,
    autoDisabled,
    autoHint,
  } = props;
  const draft = state.draft;

  const [selection, setSelection] = useState<TapSelection>(NO_SELECTION);
  /** 모바일 하단 독 펼침 상태 (데스크탑은 항상 펼침). */
  const [dockOpen, setDockOpen] = useState(false);

  // Single DndContext spans the board slots + bench (token sources) AND the owned-player pool list.
  // MouseSensor(터치 아님) + TouchSensor 로 분리한다 — PointerSensor 를 쓰면 터치에서도
  // pointerdown 이 먼저 잡혀 TouchSensor 의 delay(롱프레스) 활성화가 영영 안 걸리고,
  // 거리 기반(distance) 활성화라 손가락이 6px 움직이는 순간 브라우저가 네이티브 스크롤을
  // 시작해 pointercancel 로 드래그가 죽는다(실측, #106 결함). 분리하면 터치는 롱프레스 150ms 로만
  // 드래그가 시작되고, 짧은 스와이프는 리스트 스크롤로 남는다(스크롤·드래그 양립).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  function mutateDraft(next: DeckDraft) {
    onChange({ ...state, draft: next });
  }

  function handleDragEnd(e: DragEndEvent) {
    if (!e.over) return;
    const playerId = playerIdFromDragId(String(e.active.id));
    const target = parseDroppableId(String(e.over.id));
    // 드래그 배치도 탭 배치와 **동일한 경로**로 레일 컨텍스트/독 상태를 갱신한다(m4) —
    // 안 그러면 드래그로 놓은 선수만 지시 입력으로 이어지지 않는다.
    const wasOnBoard = Boolean(findPlayerSlot(draft, playerId));
    mutateDraft(movePlayerToSlot(draft, playerId, target.role, target.slotIndex));
    const next: TapSelection = { slot: null, playerId, source: "board" };
    setSelection(next);
    syncDock(next, wasOnBoard);
  }

  /**
   * 모바일 하단 독 펼침 규칙 — **배치 중에는 접고, 이미 배치된 선수를 고를 때만 편다.**
   *   · 펼친 독이 피치 하단(GK 슬롯)이나 보유 선수 리스트를 덮어 다음 탭을 막는다(실측 2회).
   *   · 그래서 "리스트에서 집어듦 / 리스트→보드 배치(탭·드래그 무관)" 는 독을 열지 않는다.
   *   · 이미 보드에 있는 선수를 탭/드래그해 고른 경우 = 지시를 손볼 차례 → 펼친다.
   * 탭 경로와 드래그 경로가 같은 함수를 쓰므로 둘의 동작이 어긋나지 않는다.
   */
  function syncDock(next: TapSelection, wasOnBoard: boolean) {
    setDockOpen(Boolean(next.playerId) && wasOnBoard);
  }

  /** 보드 슬롯 탭 — 선택/배치/이동/교체는 tap-place 가 결정한다(순수). */
  function handleSlotTap(slot: SlotRef) {
    const r = tapSlot(draft, selection, slot);
    const wasOnBoard = Boolean(r.selection.playerId && findPlayerSlot(draft, r.selection.playerId));
    if (r.draft !== draft) mutateDraft(r.draft);
    setSelection(r.selection);
    syncDock(r.selection, wasOnBoard);
  }

  /** 리스트 행 탭 — 타깃 슬롯이 있으면 배치, 없으면 집어든다(역방향). */
  function handlePick(playerId: string) {
    const r = tapPoolPlayer(draft, selection, playerId);
    const wasOnBoard = Boolean(r.selection.playerId && findPlayerSlot(draft, r.selection.playerId));
    if (r.draft !== draft) mutateDraft(r.draft);
    setSelection(r.selection);
    syncDock(r.selection, wasOnBoard);
  }

  const starterSlots = draft.slots.filter((s) => s.role === "starter");

  const power = useMemo(() => {
    const attrs = starterSlots
      .map((s) => playersById.get(s.playerId)?.attributes)
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    return teamPower(attrs);
  }, [starterSlots, playersById]);

  const selectedPlayer = selection.playerId ? playersById.get(selection.playerId) : undefined;
  /** 리스트에서 집어들어 배치를 기다리는 선수(보드 바에 취소 어피던스를 띄운다). */
  const pendingPlayer = selection.source === "pool" ? selectedPlayer : undefined;
  const selectedSlotData = selection.playerId ? findPlayerSlot(draft, selection.playerId) : undefined;
  const railRelation = selectedPlayer ? relationOf(relations, selectedPlayer.id) : undefined;
  const autoFilter = autoFilterFor(draft, selection);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div
        className={dockOpen ? `${styles.sheet} ${styles.sheetDockOpen}` : styles.sheet}
        data-testid="deck-editor"
        data-dock-open={dockOpen ? "true" : "false"}
      >
        {/* ① 시트 바 */}
        <TeamSheetBar
          draft={draft}
          onFormationChange={(formation) => mutateDraft({ ...draft, formation })}
          power={power}
          opponentPower={opponentPower}
          opponentName={opponentName}
          opponentApprox={opponentApprox}
          autoDisabled={autoDisabled}
          autoHint={autoHint}
          onAuto={onAuto}
        />

        <div className={styles.wrap}>
          {/* ② 전술보드(SoT) — 벤치는 이 카드 안에 있다 */}
          <section className={styles.boardCol}>
            <TacticsBoard
              draft={draft}
              playersById={playersById}
              conditions={conditions}
              selectedSlot={selection.slot}
              selectedPlayerId={selection.playerId}
              pendingPlace={selection.source === "pool"}
              onSlotTap={handleSlotTap}
              footer={
                <>
                  {pendingPlayer ? (
                    /* 배치 대기(리스트에서 집어든 상태)일 때는 보드 바가 **명시적 취소**를 준다 —
                       모바일은 독이 접혀 레일 × 가 안 보이므로 취소 어피던스가 여기 있어야 한다. */
                    <>
                      <span className={styles.pendingHint} data-testid="place-pending-hint">
                        {pendingPlayer.name} 배치할 슬롯을 누르세요
                      </span>
                      <button
                        type="button"
                        className={styles.boardBtn}
                        data-testid="place-cancel"
                        onClick={() => setSelection(NO_SELECTION)}
                      >
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={styles.boardHint}>
                        {selectedPlayer
                          ? `${selectedPlayer.name} 지시 편집 중 — 다른 슬롯을 누르면 이동`
                          : "슬롯 → 선수 순서로 누르면 배치. 선수끼리 누르면 자리 교체."}
                      </span>
                      {/* r1 로 토큰 재탭이 해제가 아니게 됐으므로(그 선수 지시 유지),
                          해제 어피던스를 보드 바에 명시적으로 둔다(레일 × 와 동치). */}
                      {selectedPlayer && (
                        <button
                          type="button"
                          className={styles.boardBtn}
                          data-testid="select-clear"
                          onClick={() => setSelection(NO_SELECTION)}
                        >
                          선택 해제
                        </button>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className={styles.boardBtn}
                    data-testid="board-reset"
                    onClick={() => {
                      mutateDraft({ ...draft, slots: [] });
                      setSelection(NO_SELECTION);
                    }}
                  >
                    초기화
                  </button>
                  {onAuto && (
                    <button
                      type="button"
                      className={styles.boardBtnPrimary}
                      data-testid="auto-fill"
                      disabled={autoDisabled}
                      onClick={onAuto}
                    >
                      Auto 배치
                    </button>
                  )}
                </>
              }
            />
            {onAuto && autoHint && (
              <span className={styles.autoHint} data-testid="auto-hint">
                {autoHint}
              </span>
            )}
            {errorPlayerId && playersById.get(errorPlayerId) && (
              <p className={styles.errorNote} data-testid="editor-error-player">
                문제 선수: {playersById.get(errorPlayerId)!.name}
              </p>
            )}
          </section>

          {/* 보드의 공급원 */}
          <section className={styles.poolCol}>
            <PlayerPicker
              players={players}
              draft={draft}
              onPick={handlePick}
              conditions={conditions}
              autoFilter={autoFilter}
              pendingPlayerId={selection.source === "pool" ? selection.playerId : null}
            />
          </section>

          {/* ③ 컨텍스트 지시 레일 (데스크탑=우측 고정 컬럼 / 모바일=하단 독) */}
          <section className={styles.railCol} data-testid="rail-dock" data-open={dockOpen ? "true" : "false"}>
            <button
              type="button"
              className={styles.grab}
              data-testid="rail-dock-toggle"
              aria-expanded={dockOpen}
              aria-label={dockOpen ? "지시 접기" : "지시 펼치기"}
              onClick={() => setDockOpen((v) => !v)}
            />
            <DirectiveRail
              player={selectedPlayer}
              slot={selectedSlotData}
              slotNumber={
                selectedSlotData
                  ? slotNumberLabel(selectedSlotData.role, selectedSlotData.slotIndex)
                  : undefined
              }
              condition={selectedPlayer ? conditions?.[selectedPlayer.id] : undefined}
              trust={railRelation?.trust}
              personality={railRelation?.personality}
              tactics={state.tactics}
              teamPrompt={state.teamPrompt}
              aiManaged={aiManaged}
              onTacticsChange={(tactics) => onChange({ ...state, tactics })}
              onTeamPromptChange={(text) => onChange({ ...state, teamPrompt: text })}
              onToggleAi={onToggleAi}
              onPlayerPromptChange={(playerId, text) => mutateDraft(setPrompt(draft, playerId, text))}
              onRemovePlayer={(playerId) => {
                mutateDraft(removePlayer(draft, playerId));
                setSelection(NO_SELECTION);
              }}
              onClose={() => setSelection(NO_SELECTION)}
            />
          </section>
        </div>
      </div>
    </DndContext>
  );
}
