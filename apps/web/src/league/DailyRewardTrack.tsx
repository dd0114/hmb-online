import { useEffect, useRef } from "react";
import type { DailyRewardSlot, DailyRewardTrack as Track } from "../api/p3";
import { Amount } from "../common/Amount";
import { TeamCrest } from "../common/TeamCrest";
import { isNextSlot, slotState, trackProgress } from "./daily-reward-logic";
import styles from "./DailyRewardTrack.module.css";

/**
 * 오늘의 보상 트랙 — 배틀패스 레일 (#368, hero 채택 시안 A 2026-07-31).
 *
 * 보상 칸이 위, **상대팀 마크가 아래**, 진행선이 칸을 관통하고 다음 칸에 `지금` 깃발이 선다.
 * 칸에 상대가 붙어 트랙이 곧 "오늘의 일정"이 된다.
 *
 * <p>⚠️ **여기엔 규칙이 하나도 없다.** 칸 수·대량 위치·금액·재화·다음 칸·상대까지 전부 서버가 준
 * `slots[]` 를 그리기만 한다(#262 컷 규율). `slotNo % 9` 같은 걸 적는 순간 economy 노브를 돌렸을 때
 * 화면이 서버가 하지 않는 일을 단언한다.
 */
export function DailyRewardTrack({ track }: { track: Track }) {
  const railRef = useRef<HTMLDivElement>(null);
  const { used, total, exhausted } = trackProgress(track);
  const slots = track.slots ?? [];
  const nextSlotNo = track.next?.slotNo ?? null;

  // 다음 칸이 보이게 밀어 둔다 — 18칸이라 기본 위치에서는 화면 밖이다.
  // `scrollIntoView` 는 **문서 전체를 스크롤할 수 있어** 쓰지 않는다(리그 화면이 통째로 튄다).
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || nextSlotNo == null) return;
    const node = rail.querySelector<HTMLElement>(`[data-slot="${nextSlotNo}"]`);
    if (!node) return;
    rail.scrollLeft = Math.max(0, node.offsetLeft - rail.clientWidth / 2 + node.offsetWidth / 2);
  }, [nextSlotNo, slots.length]);

  return (
    <section className={styles.card} data-testid="daily-reward-track">
      <div className={styles.head}>
        <h3 className={styles.title}>오늘의 보상</h3>
        {exhausted ? (
          <span className={[styles.badge, styles.badgeOff].join(" ")} data-testid="daily-reward-exhausted">
            오늘 완료
          </span>
        ) : (
          <span className={styles.badge}>{used === 0 ? "시작 전" : "진행 중"}</span>
        )}
        <span className={styles.count} data-testid="daily-reward-count">
          오늘 <b>{track.awardedCount}회</b> 받음 ·{" "}
          <Amount code={track.currency} value={track.earned} />
        </span>
      </div>

      <div className={styles.rail} ref={railRef} data-testid="daily-reward-rail">
        {slots.map((slot) => (
          <SlotNode key={slot.slotNo} slot={slot} isNext={isNextSlot(track, slot)} />
        ))}
      </div>

      <p className={styles.foot}>
        <span data-testid="daily-reward-progress">
          {used} / {total}
        </span>
        {track.next ? (
          <span className={styles.nextPill} data-testid="daily-reward-next">
            다음 ▶ <Amount code={track.next.currency} value={track.next.amount} />
          </span>
        ) : (
          // 다 쓴 상태를 **말한다**. 구역을 지우면 "보상이 왜 안 들어왔지"가 된다.
          <span className={styles.doneNote}>오늘 칸을 모두 썼습니다 · 자정에 초기화</span>
        )}
      </p>
    </section>
  );
}

const GLYPH: Record<string, string> = { WON: "✓", MISSED: "✗" };
const STATE_LABEL: Record<string, string> = { WON: "수령", MISSED: "소멸", PENDING: "예정" };

function SlotNode({ slot, isNext }: { slot: DailyRewardSlot; isNext: boolean }) {
  const state = slotState(slot);
  const done = state === "WON" || state === "MISSED";
  const label = [
    `${slot.slotNo}번째 칸`,
    slot.big ? "대량" : null,
    slot.opponentName,
    // 색·글리프 단일 채널로 말하지 않는다(#262 적록색약 규율) — 상태를 소리로도 읽힌다.
    isNext ? "다음 보상" : STATE_LABEL[state ?? ""],
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={[
        styles.node,
        slot.big ? styles.big : "",
        state === "WON" ? styles.won : "",
        state === "MISSED" ? styles.missed : "",
        isNext ? styles.next : "",
        done ? styles.past : "",
      ].join(" ")}
      data-slot={slot.slotNo}
      data-state={state ?? ""}
      data-big={slot.big ? "1" : "0"}
      data-next={isNext ? "1" : "0"}
      role="img"
      aria-label={label}
    >
      {isNext && <span className={styles.nowTag}>지금</span>}
      <div className={styles.rewardSlot}>
        <span className={styles.line} aria-hidden="true" />
        <div className={styles.reward}>
          {state && GLYPH[state] && (
            <span className={styles.stamp} aria-hidden="true">
              {GLYPH[state]}
            </span>
          )}
          <Amount className={styles.amount} code={slot.currency} value={slot.amount} />
        </div>
      </div>
      <div className={styles.nodeFoot}>
        <TeamCrest name={slot.opponentName} size="sm" muted={done} />
        <span className={styles.slotNo} aria-hidden="true">
          {slot.slotNo}
        </span>
      </div>
    </div>
  );
}
