import { useMemo, useState } from "react";
import { Modal } from "../common/Modal";
import { CharAvatar, initialsOf } from "../common/CharAvatar";
import { GRADE_COLORS, GRADE_LABELS, GRADE_ORDER, type Grade } from "../common/grades";
import { usePlayerNames } from "../common/player-names";
import { useCardEffective, usePendingChoices } from "../api/growth-hooks";
import type { ChoiceResult, PendingChoice } from "../api/growth";
import { ChoiceCandidates, candidateView } from "../growth/ChoiceCards";
import { STAT_LABEL_MAP } from "../growth/growth-config";
import { presentSections, unclaimedIn } from "./registry";
import { useAckReward } from "./rewards-hooks";
import {
  bundleChoicesOf,
  growthEntriesOf,
  openChoicesOf,
  SECTION_GROWTH,
  type RewardBundle,
  type RewardGrowthEntry,
} from "./types";
import styles from "./RewardSheet.module.css";

/**
 * **보상 시트** — 경기 종료 → 이 오버레이 → `[확인]` → 결과 화면 (#405 §2.9, 목업 화면 ①~④).
 *
 * 매치 전용이 아니라 **봉투 셸**이다: 탭·스크롤·`[확인]`·ack 만 갖고, 무엇이 들어가는지는
 * `registry.ts` 가 정한다(§2.9.1). 미션(#408)·리그·우편이 섹션 하나만 등록하면 그대로 붙는다.
 *
 * ── 규율 ────────────────────────────────────────────────────────────────────────────────
 * · **문서 스크롤 0**: 오버레이는 `position: fixed` + `svh`, 스크롤은 `.panel` 안에만 있다.
 *   `.sheet`/`.panel` 의 `min-width: 0` 은 장식이 아니다 — 없으면 긴 이름 한 줄이 시트를 밀어
 *   탭바가 화면 밖으로 나가는데 셸이 `overflow:hidden` 이라 **문서 스크롤 계약은 green** 이다
 *   (#284 에서 실제로 당했고 실화면 캡처로만 보였다).
 * · **`[확인]` 은 스크롤 밖 고정**: 성장 목록은 기용 선수 수만큼 길어져 상한이 없다. 어떤 높이를
 *   골라도 언젠가 CTA 가 화면 밖으로 나간다 — 그게 #355 의 형태였다. 그래서 두 층(스크롤 + 바닥).
 * · **탭 뱃지 = 선택 "횟수"**(선수 수가 아니다, 목업 확정). 유저가 해야 할 액션 수가 뱃지다.
 * · 🚨 **`[확인]`(ack)은 "받았다"가 아니라 "봤다"** 다. 미션(#408)처럼 `[받기]` 를 눌러야 지급되는
 *   섹션이 섞이면, 그냥 ack 하고 넘기는 순간 유저는 *"확인 눌렀으니 다 받았겠지"* 하고 **실제로
 *   손해를 본다**. 그래서 `confirm()` 이 `unclaimedIn` 을 먼저 본다 — 아래 주석이 SoT.
 */

export interface RewardSheetProps {
  bundle: RewardBundle;
  matchId?: string;
  /**
   * 봉투가 실려 온 응답 전체. 봉투 밖 additive 블록을 읽는 섹션(미션 #408)이 있어서 필요하다 —
   * **셸은 그 안을 들여다보지 않고** 레지스트리에 그대로 넘긴다(`RewardSectionContext.result`).
   */
  result?: unknown;
  /** 헤더 우측 한 줄(예: `2 : 1 · 리그 R7`). 없으면 안 그린다. */
  subtitle?: string | null;
  /** 헤더 뱃지(예: `승리`). 승패 색은 호출부가 `tone` 으로 정한다. */
  badge?: string | null;
  badgeTone?: "WIN" | "DRAW" | "LOSS" | null;
  /**
   * 시트를 닫는다. 아직 확인 전 봉투면 그 전에 ack 를 친다 — **실패해도 닫는다**(확인은 서버
   * 상태 정리이지 결과를 보기 위한 관문이 아니다).
   */
  onClose: () => void;
}

/** 등급을 아는 행만 아바타를 그린다(#285 fail-closed, `CharAvatar.grade` 는 필수 prop). */
function isGrade(g: string | null | undefined): g is Grade {
  return typeof g === "string" && (GRADE_ORDER as readonly string[]).includes(g);
}

/**
 * ⚠️ **이름을 프롭으로 받는다 — `entry.name` 을 읽지 마라**(#406 요구 6, W8).
 * `entry.name` 은 서버가 정산 시점에 실어 보낸 값이라 카탈로그 개명(#411 스위치·어드민 개명)을
 * 따라오지 않는다. 축은 **`full`** 이다: `initialsOf` 는 풀네임 전제이고(apps/web CLAUDE.md
 * 두 축 표) `CharAvatar.name` 은 `aria-label`·이니셜로 쓰인다.
 */
function PickAvatar({ entry, name }: { entry: RewardGrowthEntry; name: string }) {
  if (!isGrade(entry.grade)) {
    return (
      <span className={styles.pickAvatarFallback} data-art-policy="hidden" aria-hidden="true">
        {initialsOf(name)}
      </span>
    );
  }
  return <CharAvatar playerId={entry.playerId} name={name} grade={entry.grade} size={46} />;
}

/*
 * ⚠️ **선택 헤드의 `천장 N` · `★n` 은 은퇴했다** (#456 S4-W2 AC4 — hero 정보 감량 지시).
 * 그 값을 만들던 `ceilingOf` 도 같이 없앴다: 소비처 0 인 헬퍼를 남기면 다음 사람이 "이미 있으니"
 * 하고 줄을 되살린다. 되살릴 때 재작성할 규칙은 한 줄이다 — **서버 `caps` 의 최대값을 그대로**
 * 쓴다(클라가 밴드+★보너스로 재구성하면 무배포 조정에 조용히 어긋난다, §2.8).
 * 천장 분해 라벨(`천장 73 = 72 + ★2 보너스 1`)은 **강화탭에 그대로 살아 있다**(`growth-ceil-legend`).
 */

const BADGE_CLASS: Record<string, string> = {
  WIN: styles.badgeWin!,
  DRAW: styles.badgeDraw!,
  LOSS: styles.badgeLoss!,
};

export function RewardSheet({
  bundle,
  matchId,
  result,
  subtitle,
  badge,
  badgeTone,
  onClose,
}: RewardSheetProps) {
  const sections = useMemo(() => presentSections(bundle, result), [bundle, result]);
  const [activeKind, setActiveKind] = useState<string | null>(null);
  const [pick, setPick] = useState<PendingChoice | null>(null);
  const [applied, setApplied] = useState<{ stat: string; gain: number; from: number | null; to: number | null } | null>(
    null,
  );

  const ack = useAckReward();
  const pending = bundle.acknowledgedAt == null;

  // "지금 남은 것"의 권위는 봉투 스냅샷이 아니라 이 조회다(types.openChoicesOf 주석).
  const { data: openChoices } = usePendingChoices(undefined, true);
  const openIds = useMemo(
    () => (openChoices ? new Set(openChoices.map((c) => c.choiceId)) : undefined),
    [openChoices],
  );
  const openInBundle = useMemo(
    () => openChoicesOf(bundleChoicesOf(bundle), openChoices),
    [bundle, openChoices],
  );

  const active = sections.find((s) => s.kind === activeKind) ?? sections[0] ?? null;
  const growthEntries = growthEntriesOf(bundle);
  const pickedPlayer = pick ? growthEntries.find((e) => e.playerId === pick.playerId) : undefined;
  const { data: card } = useCardEffective(pick?.playerId);

  /**
   * 선수명 초크포인트(#406 요구 6). **축 = `full`** — 선택 헤드의 이름은 `.pickName`
   * (`display:block`)이라 한 줄을 통째로 쓰고, 포지션·등급·★ 는 아랫줄(`.pickMeta`)에 앉는다.
   * 성장 목록 행은 밀집이라 `short` 다(`sections/GrowthSection`) — 한 시트가 두 축을 쓰는 것이
   * 정상이다(축은 파일이 아니라 그 조각이 앉은 자리가 정한다).
   *
   * 서버가 실어 보낸 `entry.name` 은 **사다리 2단**으로만 넘긴다 — 카탈로그가 아는 선수면
   * 카탈로그 이름이 이긴다(W0 결정: 저장은 고치지 않고 조회 시 덮는다).
   */
  const names = usePlayerNames();
  /**
   * ⚠️ **이 한 줄이 이 파일에서 예외표(`player-names.test.ts` EXEMPT)에 등록된 유일한 표현이다.** 우회 스캐너는
   * "조회 결과의 `.name` 을 꺼내는 것"을 금지하는데, 여기서 꺼낸 값은 화면으로 가는 게 아니라
   * **사다리 2단 인자로 초크포인트에 들어간다**(= 금지하려는 것의 반대). 이름을 따로 뽑아 두는
   * 이유는 표현을 예외표에서 **구별 가능하게** 만드는 것이기도 하다 — 예외 키가 `pickedPlayer.name`
   * 이면 나중에 누가 그 값을 **직접 렌더**해도 같은 키로 조용히 면제된다.
   */
  const pickedGiven = pickedPlayer?.name;
  const pickedName = pickedPlayer ? names.full(pickedPlayer.playerId, pickedGiven) : "";

  /**
   * 🚨 **아직 받지 않은 것** — `[확인]` 이 이걸 삼키면 안 된다 (#405 ↔ #408 통합의 본체).
   *
   * `ack` 는 *"봤다"* 이고 미션의 `[받기]` 는 *"받았다"* 라 **축이 다르다**. 둘을 한 시트에 넣으면
   * 유저는 `[확인]` 하나로 둘 다 끝났다고 읽는데, 그 순간 미수령분은 **지급되지 않은 채** 화면에서
   * 사라진다. 그래서 셸이 확인 단계를 하나 더 둔다.
   *
   * ⚠️ **셸은 이게 무슨 보상인지 모른다** — "미션"이라는 단어가 이 파일에 없다. 건수 판정은
   * 레지스트리의 `unclaimed`(§2.9.1 경계), 여기서는 **집행만** 한다. 새 섹션이 "눌러야 지급"이면
   * 등록 줄에 `unclaimed` 를 다는 것만으로 이 가드가 저절로 걸린다.
   */
  const unclaimed = useMemo(() => unclaimedIn(sections, bundle, result), [sections, bundle, result]);
  const unclaimedTotal = unclaimed.reduce((n, u) => n + u.count, 0);
  /** 한 번 경고했나. **받고 나면 0 이 되므로 이 래치는 스스로 무의미해진다**(리셋 불필요). */
  const [warned, setWarned] = useState(false);
  const blocking = unclaimedTotal > 0;

  function confirm() {
    /*
     * 첫 `[확인]` 은 ack 를 **치지 않는다**: 미수령 섹션 탭으로 데려가고(무엇을 놓치는지 눈으로
     * 보게) 경고를 무장한다. 두 번째 눌림은 "알고 넘어간다"는 뜻이라 그대로 진행한다 — 막지는
     * 않는다(받는 것은 유저의 선택이고, 놓쳐도 기한 없이 남는다).
     */
    if (blocking && !warned) {
      setWarned(true);
      const first = unclaimed[0];
      if (first) setActiveKind(first.section.kind);
      return;
    }
    if (pending) {
      // 실패해도 진행한다 — onSettled 가 아니라 양쪽 콜백에서 같은 일을 한다.
      ack.mutate(bundle.bundleId, { onSuccess: onClose, onError: onClose });
      return;
    }
    onClose();
  }

  function onApplied(res: ChoiceResult) {
    const view = candidateView({ stat: res.stat, gain: res.gain }, card);
    setApplied({ stat: res.stat, gain: res.gain, from: view.from, to: view.to });
  }

  /** 아직 안 고른 다음 선택권 — 방금 고른 것은 `openChoices` 갱신으로 빠진다. */
  const remaining = openInBundle.filter((c) => c.choiceId !== pick?.choiceId);

  const titleId = "reward-sheet-title";
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      // 확인 전에는 백드롭·Escape 로 못 닫는다 — [확인]이 ack 를 치는 유일한 문이라
      // 밖으로 새 나가면 다음 진입에서 같은 오버레이가 또 뜬다.
      dismissable={!pending}
      overlayClassName={styles.overlay}
      overlayTestId="reward-overlay"
      className={styles.sheet}
      testId="reward-sheet"
      dataAttrs={{ "data-bundle": bundle.bundleId, "data-acknowledged": pending ? "0" : "1" }}
    >
      <div className={styles.grabber} aria-hidden="true" />

      {pick ? (
        <>
          <header className={styles.head}>
            <h2 id={titleId} className={styles.title}>
              레벨업 보상 선택
            </h2>
            {/* 진행 카운터는 두지 않는다 — 봉투 스냅샷과 남은 수가 서로 다른 축이라 "0 / 2" 같은
                거짓이 나온다(실화면 캡처로 확인). 남은 수는 적용 후 배너가 정확히 말한다. */}
          </header>
          <div className={styles.panel} data-testid="reward-panel">
            {/*
              누구의 무슨 레벨업인지 — 목업 화면 ③ 의 헤드. 성장 탭에서 행을 눌러 들어오므로
              맥락이 없으면 "누구 걸 고르는 중이지?" 가 된다. 천장은 카드가 오면 붙는다.
            */}
            {pickedPlayer && (
              <div className={styles.pickHead} data-testid="reward-pick-head">
                <PickAvatar entry={pickedPlayer} name={pickedName} />
                <span className={styles.pickMain}>
                  <span className={styles.pickName} data-testid="reward-pick-name">
                    {pickedName}
                  </span>
                  <span className={styles.pickMeta}>
                    {pickedPlayer.position && <span className={styles.pickChip}>{pickedPlayer.position}</span>}
                    {isGrade(pickedPlayer.grade) && (
                      <span className={styles.pickChip} style={{ color: GRADE_COLORS[pickedPlayer.grade], borderColor: "currentColor" }}>
                        {GRADE_LABELS[pickedPlayer.grade]}
                      </span>
                    )}
                  </span>
                </span>
                <span className={styles.pickLv}>
                  <b>
                    Lv {pick.level} → {pick.level + 1}
                  </b>
                  <span>LEVEL UP</span>
                </span>
              </div>
            )}
            {applied && (
              <>
                {remaining.length > 0 && (
                  <div className={styles.remainBar} data-testid="reward-remaining">
                    <span>
                      같은 경기에서 <b>선택 대기 {remaining.length}</b> 이 남았습니다
                    </span>
                    <button
                      type="button"
                      className={styles.remainCta}
                      data-testid="reward-pick-next"
                      onClick={() => {
                        setApplied(null);
                        setPick(remaining[0]!);
                      }}
                    >
                      이어서 선택
                    </button>
                  </div>
                )}
                <p className={styles.appliedHead}>
                  {STAT_LABEL_MAP[applied.stat] ?? applied.stat} 적용 완료
                </p>
              </>
            )}
            {/*
              ⚠️ **적용 후에도 이 컴포넌트를 언마운트하지 않는다** — 축하 오버레이가 그 안에 있어
              갈아끼우면 연출이 같은 프레임에 사라진다(e2e 가 잡았다). 다음 선택으로 넘어갈 때만
              `key` 로 새로 마운트한다.
            */}
            <ChoiceCandidates
              key={pick.choiceId}
              choice={pick}
              card={card}
              onApplied={onApplied}
              footer={
                <button
                  type="button"
                  className={styles.ghostCta}
                  data-testid="reward-pick-later"
                  onClick={() => setPick(null)}
                >
                  나중에 선택
                </button>
              }
            />
          </div>
          <button
            type="button"
            className={styles.cta}
            data-testid="reward-pick-done"
            onClick={() => {
              setApplied(null);
              setPick(null);
            }}
          >
            확인
          </button>
        </>
      ) : (
        <>
          <header className={styles.head}>
            <h2 id={titleId} className={styles.title}>
              경기 보상
            </h2>
            {badge && (
              <span className={`${styles.badge} ${badgeTone ? BADGE_CLASS[badgeTone] ?? "" : ""}`} data-testid="reward-badge">
                {badge}
              </span>
            )}
            {subtitle && <span className={styles.headMeta}>{subtitle}</span>}
          </header>

          {sections.length > 1 && (
            <div className={styles.tabs} role="tablist" aria-label="보상 종류">
              {sections.map((s) => (
                <button
                  key={s.kind}
                  type="button"
                  role="tab"
                  aria-selected={s.kind === active?.kind}
                  className={`${styles.tab} ${s.kind === active?.kind ? styles.tabActive : ""}`}
                  data-testid={`reward-tab-${s.kind}`}
                  onClick={() => setActiveKind(s.kind)}
                >
                  {s.title}
                  {s.kind === SECTION_GROWTH && openInBundle.length > 0 && (
                    <span className={styles.tabDot} data-testid="reward-tab-badge">
                      {openInBundle.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className={styles.panel} data-testid="reward-panel">
            {active?.render({
              bundle,
              ...(matchId ? { matchId } : {}),
              result,
              openChoiceIds: openIds,
              onPickChoice: (choice) => {
                setApplied(null);
                setPick(choice);
              },
            })}
          </div>

          {/*
            🚨 미수령 경고 — **`[확인]` 바로 위**다. 패널 안(스크롤 안쪽)에 두면 목록이 길 때
            화면 밖으로 밀려, 정작 막고 있는 버튼 옆에 이유가 없는 상태가 된다(#355 와 같은 축).
            처음부터 보인다(`blocking`) — 누른 **뒤에만** 알려 주면 그건 경고가 아니라 사후 통보다.
            `data-armed` = 한 번 눌러 확인 단계에 들어섰나(문구가 세진다).
          */}
          {blocking && (
            <p
              className={`${styles.unclaimed} ${warned ? styles.unclaimedArmed : ""}`}
              data-testid="reward-unclaimed"
              data-count={unclaimedTotal}
              data-armed={warned ? "1" : "0"}
              role={warned ? "alert" : undefined}
            >
              {unclaimed.map((u) => (
                <b key={u.section.kind}>
                  받지 않은 {u.section.title} {u.count}개
                </b>
              ))}
              <span>
                {warned
                  ? "확인을 한 번 더 누르면 받지 않고 넘어갑니다."
                  : "[확인]을 눌러도 지급되지 않습니다 — 지금 [받기]를 눌러 주세요."}
              </span>
              {/* 놓쳐도 사라지지 않는다 = 유저가 알아야 할 마지막 한 줄. 없으면 막다른 경고다. */}
              {unclaimed.map((u) =>
                u.section.unclaimedHint ? (
                  <span key={u.section.kind} data-testid="reward-unclaimed-hint">
                    {u.section.unclaimedHint}
                  </span>
                ) : null,
              )}
            </p>
          )}

          <button
            type="button"
            className={styles.cta}
            data-testid="reward-confirm"
            onClick={confirm}
            disabled={ack.isPending}
          >
            {/* 라벨이 결과를 말한다 — 같은 "확인"이 두 가지 일을 하면 두 번째 눌림이 사고가 된다. */}
            {blocking && warned ? "받지 않고 확인" : "확인"}
          </button>
        </>
      )}
    </Modal>
  );
}
