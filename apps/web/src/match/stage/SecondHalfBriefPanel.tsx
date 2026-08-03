import { useMemo } from "react";
import { useDeck, usePlayers, type MatchDetail } from "../../api/hooks";
import { PromptBlock } from "../../common/PromptBlock";
import { usePlayerNames } from "../../common/player-names";
import { countdownLabel, halftimeLengthLabel } from "../live-clock";
import { useCountdown } from "../useCountdown";
import { hasText, writtenSummary, type PromptTarget } from "../halftime-draft";
import type { HalftimeDraftHandle } from "../useHalftimeDraft";
import { isHalftimeState } from "./stage-state";
import styles from "./panels.module.css";

export interface SecondHalfBriefPanelProps {
  match: MatchDetail;
  /** 폴링 때 잡아둔 서버-클라 시각차(live-clock.captureOffsetMs). */
  clockOffsetMs?: number;
  /** 셸이 소유하는 초안 — 감독 탭과 **같은 것**을 본다(#284). */
  draft: HalftimeDraftHandle;
  /**
   * 지금 고른 지시 대상(`null` = 팀 전체). **셸이 소유한다**(#406 W9, 요구 5-2 후반) — 같은 값이
   * 피치 하이라이트를 켜기 때문이다(`player-selection.ts` 머리말의 동시 선택 표).
   *
   * ⚠️ **옵셔널로 두지 않았다.** 기본값을 주면 배선을 잊은 호출부가 조용히 하이라이트 없는 화면을
   * 만들고, 그건 이 리포가 반복해서 물린 부류다(*"프롭이 있는데 아무도 안 넘긴다"*). 필수라
   * 배선을 빼면 **컴파일이 깨진다**.
   */
  target: PromptTarget;
  onTarget: (next: PromptTarget) => void;
}

/**
 * 후반 지시를 미리 넣어둘 수 있는 상태 — 서버 허용표 미러(FIRST_HALF 부터, 감독시간까지).
 * 감독시간 판정은 `isHalftimeState` 한 곳에서만 한다(#226 — 상태명이 둘이라 인라인으로 다시 쓰면
 * 한쪽이 빠진 채 조용히 굳는다).
 */
function canSubmitIn(state: string): boolean {
  return state === "FIRST_HALF" || isHalftimeState(state);
}

interface TargetOption {
  /** null = 팀 전체. */
  target: PromptTarget;
  /** 넓은 자리(입력 블록 제목) — 풀네임. */
  label: string;
  /** 대상 칩(가로 스크롤 18칸) — 밀집 UI라 짧은 이름을 쓴다(#406 요구 6). */
  chipLabel: string;
  /** 칩 밑에 붙는 신원 보조(포지션). 팀은 없다. */
  position?: string;
}

/**
 * [D] 후반 사전입력창 — **전반을 보면서 후반 지시를 미리 적어둔다** (P4-E2 #170 W2 / AC-W2-2 → #284 확장).
 *
 * ── #284: 팀 하나가 아니라 **팀 + 선수별** ────────────────────────────────────────────────
 * hero: *"후반 지시 미리작성이 팀 전체 텍스트 하나뿐 — 선수별 지시도 전반 관전 중에 미리 입력할 수
 * 있게 하라."* 서버는 이미 `scope=player` 를 FIRST_HALF 에서 받는다(`MatchService`) — 그래서 서버
 * 변경 없이 대상만 늘렸다.
 *
 * 형태는 **대상 칩 + 프롬프트 칸**이다(hero 확정 A). 감독시간처럼 보드를 통째로 넣는 안(B)은
 * 기각됐다 — 위에서 경기가 도는 시트라 세로가 없고, 이 자리는 한 손으로 쓰는 곳이다.
 * 프롬프트 칸 자체는 덱·감독시간과 **같은 `PromptBlock`** 이라 모양이 갈라지지 않는다.
 *
 * ── 저장 버튼이 없다 (hero 확정 C) ───────────────────────────────────────────────────────
 * 타이핑이 멎으면 조용히 서버로 간다(`useHalftimeDraft`). 예전엔 [저장] 버튼이 있었는데, 대상이
 * 12개가 되면 그만큼 눌러야 하고 안 누른 채 넘어가면 유실이다. **버튼을 되살리지 마라** —
 * 대신 저장 실패는 반드시 화면에 남는다(아래 status).
 *
 * ⚠️ 선수 목록은 **매치 스냅샷**이다(`userDeckSnapshot`). 서버가 `POST /prompts{scope:player}` 의
 * playerId 를 그 스냅샷으로 검증하므로(`snapshotPlayerIds`), 현재 덱에서 목록을 만들면 전반 중
 * 덱을 고친 유저에게 **400 나는 칩**을 보여주게 된다. 스냅샷이 없는 구 매치만 덱으로 폴백한다.
 */
export function SecondHalfBriefPanel({
  match,
  clockOffsetMs = 0,
  draft,
  target: selected,
  onTarget: setSelected,
}: SecondHalfBriefPanelProps) {
  const { data: deck } = useDeck();
  const { data: players } = usePlayers();

  const clock = match.clock ?? null;
  const remaining = useCountdown(clock, clockOffsetMs);
  // 카운트다운은 감독시간에만 의미가 있다(전반 중에는 아직 마감이 정해지지 않았다).
  const deadlineLabel = clock?.phase === "HALFTIME" ? countdownLabel(remaining) : null;
  // 감독시간 길이는 서버 값 파생(웹에 상수 복제 금지 — AC-W3-2).
  const halftimeLabel = halftimeLengthLabel(clock?.halftimeMs);
  const editable = canSubmitIn(match.state);

  /** 이름은 초크포인트로만(#406 요구 6) — 이 표는 포지션 때문에 남는다. */
  const names = usePlayerNames();
  const playersById = useMemo(() => {
    const map = new Map<string, { position: string }>();
    for (const p of players ?? []) map.set(p.id, { position: p.position });
    return map;
  }, [players]);

  /** 대상 목록 — 팀이 먼저, 그 뒤 선발(자리 순) → 벤치. */
  const options: TargetOption[] = useMemo(() => {
    const out: TargetOption[] = [{ target: null, label: "팀 전체", chipLabel: "팀 전체" }];
    const snap = match.userDeckSnapshot;
    const ids: string[] = snap
      ? [...(snap.starters ?? [])]
          .sort((a, b) => a.slotIndex - b.slotIndex)
          .map((s) => s.playerId)
          .concat([...(snap.bench ?? [])].sort((a, b) => a.slotIndex - b.slotIndex).map((s) => s.playerId))
      : (deck?.slots ?? [])
          .filter((s) => s.role === "starter")
          .map((s) => s.playerId)
          .concat((deck?.slots ?? []).filter((s) => s.role === "bench").map((s) => s.playerId));
    for (const id of ids) {
      out.push({
        target: id,
        label: names.full(id),
        chipLabel: names.short(id),
        position: playersById.get(id)?.position,
      });
    }
    return out;
  }, [match.userDeckSnapshot, deck, playersById, names]);

  const selectedOption = options.find((o) => o.target === selected) ?? options[0]!;
  const text =
    selected === null ? draft.draft.cur.team : (draft.draft.cur.players[selected] ?? "");

  return (
    <div data-testid="stage-panel-brief">
      <div className={styles.briefHead}>
        <p className={styles.briefTitle}>후반 지시 (미리 작성)</p>
        <span className={styles.countdown} data-testid="brief-countdown">
          ⏱ {deadlineLabel ?? (editable ? "전반 진행 중" : "—")}
        </span>
      </div>

      {/* 누구에게 말할지 고르는 줄. 적어둔 대상에는 점이 붙어 "어디까지 했나"가 보인다. */}
      <div className={styles.targets} role="tablist" aria-label="지시 대상" data-testid="brief-targets">
        {options.map((o) => {
          const key = o.target ?? "team";
          const on = o.target === selected;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={on}
              className={`${styles.target} ${on ? styles.targetOn : ""}`}
              data-testid={`brief-target-${key}`}
              data-written={hasText(draft.draft, o.target) ? "true" : "false"}
              disabled={!editable}
              onClick={() => setSelected(o.target)}
            >
              {o.chipLabel}
              {hasText(draft.draft, o.target) && (
                <span className={styles.targetDot} aria-label="적어둠" data-testid={`brief-dot-${key}`}>
                  ●
                </span>
              )}
            </button>
          );
        })}
      </div>

      <PromptBlock
        title={selected === null ? "팀 전체에게 (후반)" : `${selectedOption.label} 에게 (후반)`}
        subtitle={selected === null ? undefined : selectedOption.position}
        value={text}
        onChange={(next) => draft.setText(selected, next)}
        disabled={!editable}
        rows={3}
        placeholder={
          selected === null
            ? "후반 팀 작전 (예: 라인을 내리고 역습 위주로)"
            : "이 선수에게 후반 한마디 (예: 오늘 너만 믿는다, 과감하게 슛 노려)"
        }
        testId="brief-team-prompt"
        targetTestId="brief-prompt-target"
      />

      {/*
        저장 버튼이 없으므로 **상태가 유일한 피드백**이다. 특히 실패를 지우지 마라 — 조용한 저장에서
        조용한 실패는 "적어뒀다고 믿었는데 후반에 없다"가 된다(#284 C 결정의 대가).
      */}
      <p className={styles.saveStatus} data-testid="brief-save-status" data-status={draft.status}>
        {draft.status === "saving" && "저장 중…"}
        {draft.status === "saved" && "✔ 자동 저장됨 — 감독시간에 이어서 고칠 수 있습니다"}
        {draft.status === "error" && (
          <span className={styles.issue} data-testid="brief-error">
            저장하지 못했습니다 — {draft.error} (계속 쓰면 다시 시도합니다)
          </span>
        )}
        {draft.status === "idle" && writtenSummary(draft.draft)}
      </p>

      <p className={styles.pending}>
        경기를 보면서 후반 지시를 미리 적어두는 자리입니다. 교체와 배치는 <b>감독</b> 탭에서
        하프타임에 확정합니다. 감독시간{halftimeLabel && `(${halftimeLabel})`} 안에 아무것도 내지 않으면{" "}
        여기 적어둔 지시가 <b>그대로</b> 반영됩니다.
      </p>
    </div>
  );
}
