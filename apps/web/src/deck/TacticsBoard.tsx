import { useMemo, type ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { CatalogPlayer } from "../api/hooks";
import type { ConditionMap } from "../api/v2";
import { GRADE_COLORS } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import { BENCH_MAX, getSlot, type DeckDraft, type SlotRole } from "./deck-logic";
import { starterCoords } from "./tactics-logic";
import { conditionColor, conditionLabel, conditionTier } from "../match/condition-clock";
import styles from "./TacticsBoard.module.css";

export interface SlotRef {
  role: SlotRole;
  slotIndex: number;
}

interface TacticsBoardProps {
  draft: DeckDraft;
  playersById: Map<string, CatalogPlayer>;
  /** optional per-player condition (briefing) → clock badge on each token (AC-C1). */
  conditions?: ConditionMap;
  /** tap-to-place target (배치 대기 슬롯) — 강조된다. */
  selectedSlot: SlotRef | null;
  /** 레일이 현재 보고 있는 선수(선택 토큰). */
  selectedPlayerId: string | null;
  /** 배치 대기 중인(리스트에서 집어든) 선수가 있으면 빈 슬롯을 후보로 강조한다. */
  pendingPlace?: boolean;
  onSlotTap: (slot: SlotRef) => void;
  /** 보드 카드 하단 바(초기화 / Auto 배치) — 벤치와 같은 카드 안에 붙는다. */
  footer?: ReactNode;
  /**
   * 선발 0/11 첫 진입 안내(#106 R3b A) — 피치 **위**에 얹힌다. 슬롯 자체는 계속 눌려야 하므로
   * 오버레이는 `pointer-events:none` 이고 그 안의 CTA 만 다시 켠다(TacticsBoard.module.css).
   */
  emptyOverlay?: ReactNode;
  /** 교체로 빠지는 선수 — 토큰에 OUT 뱃지(#244 감독시간). */
  subbedOut?: string[];
  /** 교체 모드 — 보드가 스스로 "지금은 교체 중"임을 말한다(테두리 + 토큰 톤). */
  swapMode?: boolean;
  /**
   * 벤치 줄 감추기 — 감독시간의 "한마디" 모드처럼 **넣을 선수를 고를 일이 없는** 상태.
   * (교체 모드에서는 다시 편다. 세로가 빡빡한 화면에서 82px 를 그냥 두면 프롬프트가 밀린다.)
   */
  hideBench?: boolean;
}

function slotDroppableId(role: SlotRole, slotIndex: number): string {
  return `${role}:${slotIndex}`;
}

/**
 * Parse a slot droppable id (`${role}:${slotIndex}`) back to a SlotRef. Exported so the
 * DeckEditor-level DndContext (which also hosts the pool-list drag source) can resolve drop targets.
 */
export function parseDroppableId(id: string): SlotRef {
  const [role, idx] = id.split(":");
  return { role: role as SlotRole, slotIndex: Number(idx) };
}

/**
 * Drag-source id convention (single DndContext at DeckEditor):
 *   - board token  → the raw `playerId` (a player already placed on the board/bench),
 *   - pool list item → `pool:${playerId}` (a player being dragged in FROM the owned-player list).
 */
export const POOL_DRAG_PREFIX = "pool:";

export function poolDraggableId(playerId: string): string {
  return `${POOL_DRAG_PREFIX}${playerId}`;
}

/** Resolve a drag active.id to the underlying playerId (strips the pool: prefix if present). */
export function playerIdFromDragId(activeId: string): string {
  return activeId.startsWith(POOL_DRAG_PREFIX) ? activeId.slice(POOL_DRAG_PREFIX.length) : activeId;
}

/** 토큰 디스크에 찍히는 번호 표기 — 선발은 슬롯 번호(1..11), 벤치는 B1.. (결정론, 추가 데이터 없음). */
export function slotNumberLabel(role: SlotRole, slotIndex: number): string {
  return role === "starter" ? String(slotIndex + 1) : `B${slotIndex + 1}`;
}

interface TokenProps {
  out?: boolean;
  playerId: string;
  player: CatalogPlayer | undefined;
  hasPrompt: boolean;
  condition?: number;
  selected: boolean;
  numberLabel: string;
  compact?: boolean;
}

/** A draggable player token (used inside both pitch slots and bench cells). */
function PlayerToken({ playerId, player, hasPrompt, condition, selected, numberLabel, compact, out }: TokenProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: playerId });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.token} ${selected ? styles.tokenSelected : ""} ${isDragging ? styles.tokenDragging : ""} ${out ? styles.tokenOut : ""}`}
      data-testid={`token-${playerId}`}
      data-out={out ? "true" : undefined}
      {...listeners}
      {...attributes}
    >
      <span className={styles.disc}>
        {/* 컨디션 = 디스크를 **감싸는 링의 채움 비율**(#244 재설계). 그전에는 14px 시계 뱃지가
            얼굴 위 모서리에 겹쳐 있어서, 11개가 붙는 피치에서 얼굴·번호·시계가 서로를 갉아먹었다.
            색각 대응(#106 R3b B)은 그대로다 — 색이 아니라 **채움 각도**가 1차 축이고
            `data-condition-tier` 로 노출한다(글자 축은 리스트 행·레일 헤드가 담당). */}
        {condition != null && (
          <span
            className={styles.condRing}
            data-testid={`token-clock-${playerId}`}
            data-condition={condition.toFixed(2)}
            data-condition-tier={conditionTier(condition)}
            title={`컨디션 ${Math.round(Math.max(0, Math.min(1, condition)) * 100)}% (${conditionLabel(condition)})`}
            style={
              {
                "--cond": `${Math.round(Math.max(0, Math.min(1, condition)) * 100)}%`,
                "--cond-color": conditionColor(condition),
              } as React.CSSProperties
            }
          />
        )}
        {/* 캐릭터 얼굴은 디스크 **배경 층**(#145). 번호는 그 위 모서리 알약으로 남는다 —
            정보를 빼지 않고 겹침만 푼다. */}
        {player && (
          <CharAvatar
            playerId={player.id}
            name={player.name}
            grade={player.grade}
            size={38}
            className={styles.tokenFace}
          />
        )}
        <span className={styles.discNum}>{numberLabel}</span>
        {/* 지시(프롬프트) 있음 = 말풍선 점. 이름 옆 5px 점은 이름 말줄임에 같이 잘려 안 보였다. */}
        {hasPrompt ? <span className={styles.sayDot} title="지시 있음" /> : null}
      </span>
      <span className={styles.tokenName}>{player?.name ?? playerId}</span>
      {/* 교체로 빠지는 선수 — 60초 안에 "누굴 뺐더라"를 보드에서 바로 읽어야 한다(#244). */}
      {out && (
        <span className={styles.outBadge} data-testid={`token-out-${playerId}`}>
          OUT
        </span>
      )}
      {!compact && (
        <span className={styles.tokenMeta} style={{ color: player ? GRADE_COLORS[player.grade] : undefined }}>
          {player?.position ?? "?"}
        </span>
      )}
    </div>
  );
}

interface SlotCellProps {
  draft: DeckDraft;
  playersById: Map<string, CatalogPlayer>;
  conditions?: ConditionMap;
  selectedSlot: SlotRef | null;
  selectedPlayerId: string | null;
  pendingPlace?: boolean;
  subbedOut?: string[];
  onSlotTap: (slot: SlotRef) => void;
  role: SlotRole;
  slotIndex: number;
  style?: React.CSSProperties;
  className: string;
  compact?: boolean;
}

/** A droppable slot on the pitch or bench. Tap = 탭-투-플레이스(선택/배치/교체, tap-place.ts). */
function SlotCell(props: SlotCellProps) {
  const {
    draft, playersById, conditions, selectedSlot, selectedPlayerId, pendingPlace, subbedOut,
    onSlotTap, role, slotIndex, style, className, compact,
  } = props;
  const { setNodeRef, isOver } = useDroppable({ id: slotDroppableId(role, slotIndex) });
  const slot = getSlot(draft, role, slotIndex);
  const player = slot ? playersById.get(slot.playerId) : undefined;
  const isTapTarget = selectedSlot?.role === role && selectedSlot.slotIndex === slotIndex;
  // 교체로 빠지는 선수는 **슬롯 자체를** 위로 올린다 — OUT 뱃지에 z-index 를 줘도 가리는 것이
  // 자식이 아니라 아랫줄 **형제 토큰**이라 소용없다(360×740 에서 뱃지가 덮였다, 독립 검증 minor).
  const isOut = Boolean(slot && subbedOut?.includes(slot.playerId));
  const isCandidate = Boolean(pendingPlace) && !slot;

  return (
    <button
      type="button"
      ref={setNodeRef}
      className={[
        className,
        isOver ? styles.cellOver : "",
        isTapTarget ? styles.cellSelected : "",
        isOut ? styles.cellOut : "",
        isCandidate ? styles.cellCandidate : "",
        slot ? styles.cellFilled : styles.cellEmpty,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      data-testid={`board-slot-${role}-${slotIndex}`}
      data-filled={slot ? "true" : "false"}
      aria-label={player ? `${player.name} — ${role === "starter" ? "선발" : "벤치"}` : "빈 슬롯"}
      onClick={() => onSlotTap({ role, slotIndex })}
    >
      {slot ? (
        <PlayerToken
          playerId={slot.playerId}
          player={player}
          hasPrompt={Boolean(slot.promptText?.trim())}
          condition={conditions?.[slot.playerId]}
          selected={selectedPlayerId === slot.playerId}
          numberLabel={slotNumberLabel(role, slotIndex)}
          compact={compact}
          out={subbedOut?.includes(slot.playerId)}
        />
      ) : (
        <span className={styles.emptyMark}>+</span>
      )}
    </button>
  );
}

/**
 * ② 전술보드 = SoT (이슈 #106 R1).
 *
 * #106: 보드는 여러 입력 중 하나가 아니라 **배치가 시작되고 수렴하는 자리**다. 그래서 R1에서
 * **벤치 스트립을 보드 카드 *안*으로** 넣었다 — 별도 블록이 아니라 같은 토큰 언어·같은 탭 규칙을
 * 쓰는 한 덩어리다(목업 deck-a-skin.html `.board > .pitch + .bench + .boardbar`).
 * 배치 수단: 탭-투-플레이스(1급, tap-place.ts) + 드래그(보조, @dnd-kit — 센서는 DeckEditor 소유).
 */
export function TacticsBoard(props: TacticsBoardProps) {
  const { draft, footer, emptyOverlay } = props;
  const coords = useMemo(() => starterCoords(draft.formation), [draft.formation]);
  const benchCount = draft.slots.filter((s) => s.role === "bench").length;
  // 선발이 하나도 없으면 "무엇부터 해야 하는지"를 보드가 직접 말한다(벤치만 채운 상태는 제외).
  const noStarters = !draft.slots.some((s) => s.role === "starter");
  const cellProps = {
    draft: props.draft,
    playersById: props.playersById,
    conditions: props.conditions,
    selectedSlot: props.selectedSlot,
    selectedPlayerId: props.selectedPlayerId,
    pendingPlace: props.pendingPlace,
    subbedOut: props.subbedOut,
    onSlotTap: props.onSlotTap,
  };

  return (
    <div
      className={props.swapMode ? `${styles.card} ${styles.cardSwap}` : styles.card}
      data-testid="board-card"
      data-empty={noStarters ? "true" : "false"}
      data-swap={props.swapMode ? "true" : undefined}
    >
      <div className={styles.pitch} data-testid="tactics-board">
        {/*
         * 피치 라인 — 우리 골대가 **아래(남)** 다(hero 확정). 페널티박스·골에어리어·골문·페널티스팟을
         * 실제로 그린다. 그전에는 하프라인·센터서클만 있어 "초록 사각형"으로 읽혔다.
         * ⚠️ 이 레이어는 **절대 클릭을 먹지 않는다** — 센터서클이 4-3-3 중앙 MF 탭을 삼킨 적이 있다(BL-1).
         */}
        <span className={styles.lines} aria-hidden="true">
          <span className={`${styles.pbox} ${styles.pboxUs}`} />
          <span className={`${styles.pbox} ${styles.pboxThem}`} />
          <span className={`${styles.gbox} ${styles.gboxUs}`} />
          <span className={`${styles.gbox} ${styles.gboxThem}`} />
          <span className={`${styles.goal} ${styles.goalUs}`} />
          <span className={`${styles.goal} ${styles.goalThem}`} />
          <span className={`${styles.spot} ${styles.spotUs}`} />
          <span className={`${styles.spot} ${styles.spotThem}`} />
        </span>
        {/* 토큰 레이어를 피치 안쪽으로 인셋한다 — 안 그러면 최전방/GK 토큰이 피치 경계에서 잘린다. */}
        <div className={styles.tokens}>
          {coords.map((c) => (
            <SlotCell
              key={`starter-${c.slotIndex}`}
              {...cellProps}
              role="starter"
              slotIndex={c.slotIndex}
              className={styles.pitchSlot!}
              style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
            />
          ))}
        </div>
        {noStarters && emptyOverlay && (
          <div className={styles.empty} data-testid="board-empty">
            {emptyOverlay}
          </div>
        )}
      </div>

      {/* 벤치 = 보드 카드의 일부 (#106: 별도 블록 금지) */}
      {!props.hideBench && (
      <div className={styles.benchSection} data-testid="board-bench-section">
        <span className={styles.benchLabel}>
          벤치 {benchCount} / {BENCH_MAX}
        </span>
        <div className={styles.benchRow} data-testid="board-bench">
          {Array.from({ length: BENCH_MAX }, (_, i) => (
            <SlotCell
              key={`bench-${i}`}
              {...cellProps}
              role="bench"
              slotIndex={i}
              className={styles.benchCell!}
              compact
            />
          ))}
        </div>
      </div>
      )}

      {footer && <div className={styles.boardBar}>{footer}</div>}
    </div>
  );
}
