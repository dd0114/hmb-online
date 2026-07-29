import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { Modal } from "../common/Modal";
import { findPlayerSlot, removePlayer, setPrompt, type DeckDraft } from "./deck-logic";
import { movePlayerToSlot, type EditorState } from "./tactics-logic";
import { slotPosition } from "./sheet-metrics";
import { teamPower } from "./team-power";
import {
  parseDroppableId,
  playerIdFromDragId,
  slotNumberLabel,
  TacticsBoard,
  type SlotRef,
} from "./TacticsBoard";
import { NO_SELECTION, type TapSelection } from "./tap-place";
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
  /**
   * **배치 잠금**(#244) — 감독시간처럼 "라인업은 그대로, 지시만 손보는" 화면.
   * 빈 슬롯을 눌러도 선수 시트가 열리지 않고 [보유 선수]·[Auto 배치]·[초기화]·[자리 바꾸기]·
   * [덱에서 제거]가 사라진다. hero 확정: *"덱에서 셋팅하던 것과 전후반 사이 차이점은 새로운 선수
   * 배치가 안 된다는 것뿐"* — 그래서 화면 형식은 같게 두고 **이 플래그 하나로** 차이를 만든다.
   */
  placementLocked?: boolean;
  /**
   * **교체 모드**(감독시간 T2) — 보드 탭이 "지시 대상 고르기"가 아니라 "뺄/넣을 선수 지정"이 된다.
   * 지정 자체는 호출부가 한다(교체 규칙·전송은 감독시간 소유) → 여기서는 탭을 넘겨주기만 한다.
   */
  subsMode?: boolean;
  onSubTap?: (playerId: string, role: "starter" | "bench") => void;
  /** 교체로 빠지는 선수 — 보드 토큰에 OUT 표시. */
  subbedOut?: string[];
  /** 지금 "뺄 선수"로 지정된 선수(교체 모드 강조). */
  pendingOut?: string | null;
  /** 팀 세부조정(전술 다이얼) 숨김 — 감독시간은 서버가 후반 전술을 받지 않는다(#254). */
  hideTeamTune?: boolean;
  /** 벤치 줄 숨김 — 감독시간의 한마디 모드(교체 모드에선 자동으로 다시 편다). */
  hideBench?: boolean;
  /** 보드 위에 얹을 줄(감독시간의 교체 요약·모드 탭). */
  boardHeader?: ReactNode;
  /** 프롬프트 블록 아래에 붙일 안내(감독시간 교체 안내 등). */
  railNote?: ReactNode;
  /** 입력 잠금 — 감독시간 만료처럼 "이제 내도 안 들어가는" 상태에서 입력 자체를 닫는다. */
  promptDisabled?: boolean;
  /** 프롬프트 라벨의 맥락(감독시간이면 "(후반)" 을 붙인다). */
  promptScope?: "deck" | "halftime";
}

/**
 * 팀 시트 — **한 화면 = 배치(보드) + 프롬프트** (이슈 #244, hero 확정 2026-07-28).
 *
 * ── 무엇이 바뀌었나 (#106 R1 → #244) ─────────────────────────────────────────────────────
 * #106 은 골격을 [시트 바 · 전술보드 · 보유 선수 · 컨텍스트 지시 레일] 넷으로 세웠고, 모바일에서
 * 레일은 **접힌 하단 독**이었다. 그 결과 실측(390×844): 덱 진입 시 프롬프트 입력이 **화면에 0px**,
 * 선수를 탭해 독을 열어도 세부조정(역할·칩) 147px 이 프롬프트 69px 보다 **넓고 먼저** 왔다.
 * 이 게임의 차별점(선수별 자연어 프롬프트)이 3단계(토큰 탭 → 독 펼침 → 스크롤) 뒤에 있었다.
 *
 * #244 는 비중을 뒤집는다. 일반 축구게임이 [보드 + 세부조정] 을 두던 자리에 **세부조정 대신
 * 프롬프트**가 앉고, 세부조정은 그 아래 ⚙ 버튼 뒤로 밀린다(DirectiveRail). 규칙 한 줄:
 *
 *     **편집은 인라인, 선택은 시트.**
 *       · 편집(프롬프트 · 세부조정) = 화면에 그대로 — 문장을 보면서 조정한다.
 *       · 선택(누구를 넣나) = 바텀시트 — 고르면 배치되고 **그 선수 프롬프트로 화면이 이어진다**.
 *
 * 그래서 이 파일에서 사라진 것 둘:
 *   ① **모바일 하단 독**(`position:fixed` + `--dock-runway` 실측 보정 + 오토스크롤). 레일이 문서
 *      흐름에 그대로 있으므로 독이 덮을 것도, 런웨이로 밀어낼 것도 없다. (#106 R3a 가 풀던 문제
 *      자체가 없어졌다 — 독을 되살리면 그 보정도 같이 되살려야 한다.)
 *   ② **보유 선수 상시 리스트**. 본문에서 리스트가 빠져야 프롬프트가 첫 화면에 남는다. 리스트는
 *      빈 슬롯 탭 / [보유 선수] 버튼 / 레일의 [이 자리 선수 바꾸기] 로 여는 **시트**가 됐다.
 *
 * 배치 수단: 슬롯 탭 → 시트(1급) + 드래그(@dnd-kit, 보조 — 유지). 계약 = e2e/p244-prompt-first.spec.ts.
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
    placementLocked = false,
    subsMode = false,
    onSubTap,
    subbedOut,
    pendingOut,
    hideTeamTune,
    hideBench,
    boardHeader,
    railNote,
    promptDisabled,
    promptScope = "deck",
  } = props;
  const draft = state.draft;

  const [selection, setSelection] = useState<TapSelection>(NO_SELECTION);
  /**
   * 보유 선수 시트. `slot` 이 있으면 **그 자리에 넣을 선수**를 고르는 맥락이고(포지션 자동 필터),
   * null 이면 목록만 여는 맥락이다(첫 빈 자리에 들어간다).
   */
  const [sheetSlot, setSheetSlot] = useState<SlotRef | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  /** 시트 선택이 배치로 이어지지 못했을 때의 안내(M-2) — 막다른 길을 만들지 않는다. */
  const [pickNote, setPickNote] = useState<string | null>(null);

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

  /**
   * **선수를 고르면 그 입력창까지 화면이 따라온다** (#244 A′).
   *
   * 390×844 에서 [보드 + 프롬프트]를 한 화면에 넣으면 팀 컨텍스트는 들어가지만(여유 +73px)
   * 선수 컨텍스트는 헤드가 붙어 프롬프트 아래쪽이 하단탭에 가린다(실측 −38px). 선택지는 셋이었다:
   *   ① 선수를 고르면 보드를 축소 ② 화면이 프롬프트로 이동(이것) ③ 프롬프트를 하단 고정.
   * ②를 고른 이유 = **보드 크기가 화면마다·상태마다 달라지지 않는다**(덱의 주인공이 보드라는
   * 감각을 안 건드린다). 계약은 이 스크롤 뒤에 **가림·잘림을 다시 잰다**(자동 스크롤로 가림을
   * 숨기지 못하게 — p244 AC4).
   * 되돌리려면: 이 훅을 지우고 ①이나 ③으로 바꾼다.
   */
  useEffect(() => {
    if (!selection.playerId) return;
    // jsdom 에는 scrollIntoView 가 없다 — 유닛 테스트에서 화면 이동은 관심사가 아니므로 조용히 건너뛴다
    // (계약은 실브라우저 e2e 가 잰다: p244 AC4 는 이 스크롤 **뒤에** 가림·잘림을 확인한다).
    railRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [selection.playerId]);

  function mutateDraft(next: DeckDraft) {
    onChange({ ...state, draft: next });
  }

  function selectPlayer(playerId: string | null) {
    setSelection(playerId ? { slot: null, playerId, source: "board" } : NO_SELECTION);
  }

  function handleDragEnd(e: DragEndEvent) {
    if (placementLocked || subsMode) return; // 배치 잠금 화면에서는 드래그도 라인업을 바꾸지 않는다
    if (!e.over) return;
    const playerId = playerIdFromDragId(String(e.active.id));
    const target = parseDroppableId(String(e.over.id));
    // 드래그도 탭과 **같은 결과**로 수렴한다 — 놓은 선수가 곧 지시 대상이 된다.
    mutateDraft(movePlayerToSlot(draft, playerId, target.role, target.slotIndex));
    selectPlayer(playerId);
    closeSheet();
  }

  function openSheet(slot: SlotRef | null) {
    setSheetSlot(slot);
    setSheetOpen(true);
  }
  function closeSheet() {
    setSheetOpen(false);
    setSheetSlot(null);
  }

  /**
   * 보드 슬롯 탭.
   *   · 채워진 슬롯 → **그 선수 지시**로 (프롬프트 자리가 그 선수로 바뀐다)
   *   · 빈 슬롯     → **그 자리에 넣을 선수 시트**
   * (#106 의 탭-투-플레이스 2단계 — "슬롯 고르고 리스트에서 고르기" — 는 시트가 흡수했다.
   *  선수끼리 자리를 맞바꾸는 경로는 레일의 [이 자리 선수 바꾸기] + 드래그가 담당한다.)
   */
  function handleSlotTap(slot: SlotRef) {
    const occupant = draft.slots.find((s) => s.role === slot.role && s.slotIndex === slot.slotIndex);
    // 교체 모드: 탭은 전부 호출부(감독시간)로 넘긴다 — 규칙·전송은 그쪽이 소유한다.
    if (subsMode) {
      if (occupant) onSubTap?.(occupant.playerId, slot.role);
      return;
    }
    if (occupant) {
      selectPlayer(occupant.playerId);
      return;
    }
    // 배치 잠금이면 빈 자리는 아무 일도 하지 않는다(새 선수를 넣는 화면이 아니다).
    if (placementLocked) return;
    openSheet(slot);
  }

  /**
   * 시트에서 선수 선택 → 배치하고 **그 선수 프롬프트로 이어진다**(이 에픽의 핵심 동선).
   *
   * 자리 맥락이 없는 시트([보유 선수] 버튼)에서의 동작을 명시한다 — 안 정하면 두 사고가 난다
   * (독립 검증 M-1/M-2):
   *   · **이미 배치된 선수**를 고르면 "첫 빈 자리로 이동"시켜 **라인업이 조용히 흐트러졌다**
   *     (DF 가 FW 자리로 가고 원래 자리는 공석, 되돌리기 없음). → 이동하지 않고 **지시 대상만** 바꾼다.
   *     자리를 바꾸려는 사람은 그 자리에서 열거나(빈 슬롯 탭) 레일의 [이 자리 선수 바꾸기]를 쓴다.
   *   · **덱이 꽉 찬 상태**에서 미배치 선수를 고르면 아무 일도 안 일어나는데 레일만 그 선수로 바뀌어
   *     "배치할 슬롯을 고르세요"라는 **따를 수 없는 안내**가 떴다. → 무엇을 해야 하는지 말해준다.
   */
  function handleSheetPick(playerId: string) {
    const alreadyPlaced = Boolean(findPlayerSlot(draft, playerId));
    const target = sheetSlot ?? (alreadyPlaced ? null : firstEmptySlot);
    if (target) {
      mutateDraft(movePlayerToSlot(draft, playerId, target.role, target.slotIndex));
      setPickNote(null);
    } else if (!alreadyPlaced) {
      setPickNote(
        `빈 자리가 없습니다 — 바꿀 자리의 선수를 누른 뒤 [이 자리 선수 바꾸기]로 교체하세요`,
      );
    } else {
      setPickNote(null);
    }
    selectPlayer(playerId);
    closeSheet();
  }

  const starterSlots = draft.slots.filter((s) => s.role === "starter");

  /** 자리 지정 없이 시트를 열었을 때 들어갈 자리 — 첫 빈 선발, 없으면 첫 빈 벤치. */
  const firstEmptySlot: SlotRef | null = useMemo(() => {
    const taken = (role: "starter" | "bench", i: number) =>
      draft.slots.some((s) => s.role === role && s.slotIndex === i);
    for (let i = 0; i < 11; i += 1) if (!taken("starter", i)) return { role: "starter", slotIndex: i };
    for (let i = 0; i < 7; i += 1) if (!taken("bench", i)) return { role: "bench", slotIndex: i };
    return null;
  }, [draft.slots]);

  const power = useMemo(() => {
    const attrs = starterSlots
      .map((s) => playersById.get(s.playerId)?.attributes)
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    return teamPower(attrs);
  }, [starterSlots, playersById]);

  const selectedPlayer = selection.playerId ? playersById.get(selection.playerId) : undefined;
  const selectedSlotData = selection.playerId ? findPlayerSlot(draft, selection.playerId) : undefined;
  const railRelation = selectedPlayer ? relationOf(relations, selectedPlayer.id) : undefined;

  /** 시트의 포지션 자동 필터 — 자리에서 열었으면 그 자리 포지션. */
  const sheetFilter = sheetSlot
    ? (slotPosition(draft.formation, sheetSlot.role, sheetSlot.slotIndex) ?? "ALL")
    : "ALL";
  const sheetTitle = sheetSlot
    ? `${slotNumberLabel(sheetSlot.role, sheetSlot.slotIndex)}번 ${sheetFilter === "ALL" ? "" : `${sheetFilter} `}자리에 넣을 선수`
    : "보유 선수";

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className={styles.sheet} data-testid="deck-editor">
        {/* ① 시트 바 — 포메이션 · 전력 · 3지표 · Auto */}
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
          placementLocked={placementLocked}
        />

        <div className={styles.wrap}>
          {/* ② 배치(보드) — 벤치는 이 카드 안 */}
          <section className={styles.boardCol}>
            {boardHeader}
            <TacticsBoard
              draft={draft}
              playersById={playersById}
              conditions={conditions}
              selectedSlot={null}
              /* 교체 모드에서는 "뺄 선수"가 강조 대상이다(지시 대상이 아니라). */
              selectedPlayerId={subsMode ? (pendingOut ?? null) : selection.playerId}
              subbedOut={subbedOut}
              swapMode={subsMode}
              hideBench={hideBench && !subsMode}
              onSlotTap={handleSlotTap}
              /* 빈 상태(#106 R3b A): 선발 0/11 로 처음 들어오면 피치가 "+" 11개짜리 무언의 격자라
                 무엇부터 해야 하는지가 없었다.

                 ⚠️ 이 오버레이는 **완전히 비대화형**이다(텍스트만). R3b 1차 구현은 여기에 Auto CTA
                 버튼을 넣었다가 그 버튼이 선발 슬롯 2·3 을 가로챘다(실측, 실클릭 무반응).
                 CTA 는 피치 밖 보드 하단 바에 있다 — 오버레이 안에 포커스 가능한 요소를 넣지 말 것. */
              emptyOverlay={
                <>
                  <b className={styles.emptyTitle}>선발이 비어 있습니다</b>
                  <span className={styles.emptyHint} data-testid="board-empty-hint">
                    슬롯을 눌러 선수를 고르거나, 아래 [Auto 배치로 시작]을 누르세요
                  </span>
                  {autoDisabled && autoHint && (
                    <span className={styles.emptyNote} data-testid="board-empty-note">
                      {autoHint} · 슬롯을 눌러 직접 배치할 수 있습니다
                    </span>
                  )}
                </>
              }
              /* 배치 잠금(감독시간)이면 하단 바를 아예 그리지 않는다 — 버튼은 전부 숨겨졌고
                 힌트("빈 자리 = 선수 고르기")는 **틀린 말**이 된다. 35px 도 같이 돌려받는다. */
              footer={placementLocked ? undefined : (
                <>
                  {/* 힌트는 한 줄로 — 세 줄로 접히면 보드 카드가 그만큼 커져 프롬프트를 밀어낸다. */}
                  <span className={styles.boardHint}>
                    {selectedPlayer
                      ? `${selectedPlayer.name} 편집 중`
                      : "선수 = 프롬프트 · 빈 자리 = 선수 고르기"}
                  </span>
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
                  {!placementLocked && onAuto && starterSlots.length === 0 && (
                    <button
                      type="button"
                      className={styles.emptyCta}
                      data-testid="board-empty-auto"
                      disabled={autoDisabled}
                      onClick={onAuto}
                    >
                      Auto 배치로 시작
                    </button>
                  )}
                  {!placementLocked && (
                    <button
                      type="button"
                      className={styles.boardBtn}
                      data-testid="pool-sheet-open"
                      onClick={() => openSheet(null)}
                    >
                      보유 선수 ({players.length})
                    </button>
                  )}
                  {!placementLocked && (
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
                  )}
                  {!placementLocked && onAuto && (
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
              )}
            />
            {onAuto && autoHint && (
              <span className={styles.autoHint} data-testid="auto-hint">
                {autoHint}
              </span>
            )}
            {pickNote && (
              <p className={styles.pickNote} data-testid="deck-pick-note">
                {pickNote}
              </p>
            )}
            {errorPlayerId && playersById.get(errorPlayerId) && (
              <p className={styles.errorNote} data-testid="editor-error-player">
                문제 선수: {playersById.get(errorPlayerId)!.name}
              </p>
            )}
          </section>

          {/* ③ 프롬프트(1급) + 세부조정(⚙ 뒤) — 모바일도 **문서 흐름 그대로**(독 없음) */}
          <section ref={railRef} className={styles.railCol} data-testid="directive-col">
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
              hideTeamTune={hideTeamTune}
              lockRoster={placementLocked}
              note={railNote}
              promptDisabled={promptDisabled}
              promptScope={promptScope}
              onSwapPlayer={
                !placementLocked && selectedSlotData
                  ? () =>
                      openSheet({
                        role: selectedSlotData.role,
                        slotIndex: selectedSlotData.slotIndex,
                      })
                  : undefined
              }
              onClose={() => setSelection(NO_SELECTION)}
            />
          </section>
        </div>
      </div>

      {/* 선택 = 시트. 포커스 트랩·Esc·포커스 복원은 공용 Modal 이 준다(#73 P1). */}
      {sheetOpen && (
        <Modal
          onClose={closeSheet}
          labelledBy="pool-sheet-title"
          overlayClassName={styles.sheetBackdrop}
          overlayTestId="pool-sheet-backdrop"
          className={styles.sheetBox}
          testId="pool-sheet"
        >
          <div className={styles.sheetHead}>
            <b id="pool-sheet-title" className={styles.sheetTitle}>
              {sheetTitle}
            </b>
            <button
              type="button"
              className={styles.sheetClose}
              data-testid="pool-sheet-close"
              onClick={closeSheet}
            >
              닫기 ×
            </button>
          </div>
          <PlayerPicker
            players={players}
            draft={draft}
            onPick={handleSheetPick}
            conditions={conditions}
            autoFilter={sheetFilter}
            inSheet
          />
        </Modal>
      )}
    </DndContext>
  );
}
