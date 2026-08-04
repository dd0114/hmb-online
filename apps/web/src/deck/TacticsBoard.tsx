import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { CatalogPlayer } from "../api/hooks";
import type { ConditionMap } from "../api/v2";
import { GRADE_COLORS } from "../common/grades";
import { CharAvatar } from "../common/CharAvatar";
import { playerNameOf } from "../common/player-names";
import { BENCH_MAX, getSlot, type DeckDraft, type SlotRole } from "./deck-logic";
import { TOUCH_ACTIVATION_MS, TOUCH_TOLERANCE_PX, vibrateOnGrab } from "./drag-gesture";
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
  /**
   * **투입 대기**(#442 R1) — 목록에서 [투입]을 누른 선수가 갈 자리를 고르는 중이다.
   * 선발·후보 **전 슬롯**이 대상이 된다(빈 자리 = 배치 · 찬 자리 = 교체). `data-assign-target`
   * 으로 노출해 계약이 "활성화됐나"를 DOM 에서 직접 읽는다.
   *
   * ⚠️ 구 의미는 "빈 슬롯만 후보"였고 소비처가 0 이었다(#106 2단계 탭-투-플레이스의 잔존물).
   * 되살리면서 **찬 자리까지** 넓힌 것이 hero 설계의 핵심이다 — 교체가 이 동선의 존재 이유다.
   */
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

/**
 * A draggable player token (used inside both pitch slots and bench cells).
 *
 * **롱프레스 어포던스**(#439 R1, hero Q3=ⓐ): 폰에서 이 토큰은 `TOUCH_ACTIVATION_MS` 를 참아야
 * 잡힌다. 그 사실이 화면에 없어서 "드래그가 안 된다"로 읽혔다(W0 실측: 즉시 밀기 3/3 실패 ·
 * 300ms 홀드 3/3 성공). 그래서 두 단계를 **눈에 보이게** 만든다:
 *   `holding` — 손가락을 댄 순간부터 링이 차오른다(= 얼마나 더 참아야 하나)
 *   `grabbed` — 실제로 잡혔다(링 완성 + 토큰 확대 + 짧은 진동)
 *
 * ⚠️ **dnd-kit 의 터치 리스너를 덮어쓰지 않는다.** `{...listeners}` 를 편 **뒤에** `onTouchStart`
 * 를 다시 선언하면 센서의 핸들러가 조용히 사라져 드래그가 통째로 죽는다 — 그래서 스프레드에서
 * 꺼낸 원래 핸들러를 우리 핸들러 안에서 **먼저 호출**한다.
 * ⚠️ 활성화 임계는 `drag-gesture.ts` 한 곳에서 온다(센서와 같은 값) — 갈라지면 링이 거짓말한다.
 */
function PlayerToken({ playerId, player, hasPrompt, condition, selected, numberLabel, compact, out }: TokenProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: playerId });
  const [holding, setHolding] = useState(false);
  const originRef = useRef<{ x: number; y: number } | null>(null);

  const endHold = useCallback(() => {
    originRef.current = null;
    setHolding(false);
  }, []);

  // 잡히는 순간(센서 활성화)에만 햅틱 — 대기 중에는 울리지 않는다(아직 아무 일도 안 일어났다).
  useEffect(() => {
    if (isDragging) vibrateOnGrab();
  }, [isDragging]);
  // 드래그가 시작되면 대기 표시는 역할이 끝난다(그 자리는 `grabbed` 가 이어받는다).
  useEffect(() => {
    if (isDragging) setHolding(false);
  }, [isDragging]);

  const dndTouchStart = (listeners as Record<string, ((e: React.TouchEvent) => void) | undefined> | undefined)
    ?.onTouchStart;

  const phase = isDragging ? "grabbed" : holding ? "holding" : null;

  return (
    <div
      ref={setNodeRef}
      className={`${styles.token} ${selected ? styles.tokenSelected : ""} ${isDragging ? styles.tokenDragging : ""} ${out ? styles.tokenOut : ""} ${holding ? styles.tokenHolding : ""}`}
      data-testid={`token-${playerId}`}
      data-out={out ? "true" : undefined}
      data-grabbed={isDragging ? "true" : "false"}
      data-holding={holding ? "true" : "false"}
      {...listeners}
      {...attributes}
      onTouchStart={(e) => {
        dndTouchStart?.(e); // ⚠️ 먼저 센서에게 준다 — 우리 표시가 드래그를 가로채면 안 된다
        const t = e.touches[0];
        originRef.current = t ? { x: t.clientX, y: t.clientY } : null;
        setHolding(true);
      }}
      onTouchMove={(e) => {
        // 센서가 tolerance 를 넘겨 대기를 포기하는 것과 **같은 판정**으로 표시도 내린다.
        const o = originRef.current;
        const t = e.touches[0];
        if (!o || !t) return;
        if (Math.hypot(t.clientX - o.x, t.clientY - o.y) > TOUCH_TOLERANCE_PX) endHold();
      }}
      onTouchEnd={endHold}
      onTouchCancel={endHold}
    >
      {phase && (
        <span
          className={styles.holdRing}
          data-testid={`token-hold-${playerId}`}
          data-phase={phase}
          aria-hidden="true"
          style={{ "--hold-ms": `${TOUCH_ACTIVATION_MS}ms` } as React.CSSProperties}
        />
      )}
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
            /* 이니셜 폴백도 초크포인트를 지난다(#406 요구 6). 여긴 넓은 자리가 아니지만 축은
               **풀네임**이다 — `initialsOf` 의 한글 규칙이 성(마지막 어절) 기준이라 풀네임을
               전제로 설계됐고, 다른 CharAvatar 호출부도 같은 축을 넘긴다. */
            name={playerNameOf(player, "full")}
            grade={player.grade}
            size={38}
            className={styles.tokenFace}
          />
        )}
        <span className={styles.discNum}>{numberLabel}</span>
        {/* 지시(프롬프트) 있음 = 말풍선 점. 이름 옆 5px 점은 이름 말줄임에 같이 잘려 안 보였다. */}
        {hasPrompt ? <span className={styles.sayDot} title="지시 있음" /> : null}
      </span>
      {/* 보드 토큰 = 밀집 UI(390px 에 11칸) → 짧은 이름 축(#406 요구 6). 선수를 못 찾으면
          `미상 선수` — 구 동작은 여기에 **playerId 를 그대로 찍었다**(`P077`). */}
      <span className={styles.tokenName}>{playerNameOf(player, "short")}</span>
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
  /** 투입 대기 중이면 **모든** 자리가 대상이다 — 빈 자리는 배치, 찬 자리는 교체(#442 R1). */
  const isAssignTarget = Boolean(pendingPlace);
  const isCandidate = isAssignTarget && !slot;

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
        isAssignTarget && slot ? styles.cellSwapTarget : "",
        slot ? styles.cellFilled : styles.cellEmpty,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      data-testid={`board-slot-${role}-${slotIndex}`}
      data-filled={slot ? "true" : "false"}
      data-assign-target={isAssignTarget ? "true" : undefined}
      /* ⚠️ 분기 조건은 **`slot`**(자리가 찼나)이지 `player`(카탈로그가 아나)가 아니다.
         `player` 로 가르면 카탈로그 미상 선수가 앉은 자리에서 화면(`styles.tokenName`)은 `미상 선수` 인데
         스크린리더만 "빈 슬롯"이라고 말한다 — `data-filled="true"` 인데도. 같은 상태를 두
         가지로 말하지 않는다. 축도 보이는 이름과 **같은 short** 로 맞춘다(접근가능 이름 ⊇
         보이는 라벨). */
      aria-label={
        slot ? `${playerNameOf(player, "short")} — ${role === "starter" ? "선발" : "벤치"}` : "빈 슬롯"
      }
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
