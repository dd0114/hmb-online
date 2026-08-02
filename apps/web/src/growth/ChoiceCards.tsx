import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useApplyChoice } from "../api/growth-hooks";
import type { CardEffective, ChoiceCandidate, ChoiceResult, PendingChoice } from "../api/growth";
import { CelebrationOverlay } from "../common/CelebrationOverlay";
import { ErrorToast } from "../common/ErrorToast";
import { matchInProgressIdOf } from "../common/match-lock";
import { STAT_LABEL_MAP } from "./growth-config";
import styles from "./ChoiceCards.module.css";

/**
 * **3지선다 후보 카드** — 보상 시트(#405 화면 ③)와 강화탭(화면 ⑤)이 **같은 컴포넌트**를 쓴다.
 *
 * 두 자리에서 모양이 갈리면 안 된다는 게 설계 §2.10 의 명시 요구다. 그래서 선택 뮤테이션·축하
 * 연출·에러 처리까지 **여기 하나가** 갖는다 — 호출부가 흉내 내기 시작하면 한쪽만 낡는다.
 *
 * ── 화면에 없는 것: "왜 이 후보인가" 한 줄 ────────────────────────────────────────────────
 * 목업에는 후보마다 근거 문장이 있었다(*"이 경기 슛 4회 · 지시 …"*). **서버가 그 문자열을 주지
 * 않는다** — 응답의 후보는 `{stat, gain}` 뿐이고, 가중치를 만든 재료(포지션 baseline·이벤트
 * 점수·behavior 파라미터)는 서버 안에서 소비되고 버려진다. 클라가 지어내면 그건 **그럴듯한
 * 거짓말**이고, 포지션만으로 흉내 내려 해도 `baselineByPosition` 은 무배포 조정 대상이라
 * (§2.8) 미러가 곧 낡는다.
 *
 * 그래서 후보별 근거는 **빼고**, 대신 응답 값으로 실제 확인되는 사실 한 줄(감쇠 = 낮은 스탯이
 * 더 오른다)을 남긴다. 세 후보의 `+gain` 이 왜 다른지는 그 줄과 천장 막대가 설명한다.
 * 근거 문장을 되살리려면 **서버가 후보에 `reason` 을 실어야 한다**(#405 후속 이슈 대상).
 */

const CELEBRATION_MS = 1700;
const CELEBRATION_ACCENT = "#5cc98b";

/** 스탯 1종의 "지금 → 적용 후"와 그 스탯의 천장. 카드가 아직 없으면 null(숫자를 지어내지 않는다). */
export interface CandidateView {
  stat: string;
  label: string;
  gain: number;
  from: number | null;
  to: number | null;
  base: number | null;
  cap: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * 후보 1개를 화면 값으로 — **기준은 `prePotential`**(= base + 성장분, 천장 클램프)이다.
 * `attributes` 는 잠재 보정이 얹힌 값이라 거기에 gain 을 더하면 서버가 실제로 저장하는 값과
 * 어긋난다(서버는 `stat_add` 에 더하고 천장은 `caps` 로 자른다).
 */
export function candidateView(c: ChoiceCandidate, card: CardEffective | undefined): CandidateView {
  const stat = c.stat;
  const pre = card?.prePotential as unknown as Record<string, number> | undefined;
  const attrs = card?.attributes as unknown as Record<string, number> | undefined;
  const caps = card?.caps as unknown as Record<string, number> | undefined;
  const base = card?.base as unknown as Record<string, number> | undefined;
  const from = num(pre?.[stat]) ?? num(attrs?.[stat]);
  const cap = num(caps?.[stat]);
  const to = from == null ? null : cap == null ? from + c.gain : Math.min(cap, from + c.gain);
  return {
    stat,
    label: STAT_LABEL_MAP[stat] ?? stat,
    gain: c.gain,
    from,
    to,
    base: num(base?.[stat]),
    cap,
  };
}

const pct = (v: number) => Math.max(0, Math.min(100, v));
const n1 = (v: number) => v.toFixed(1);

function CandidateButton({
  view,
  onPick,
  disabled,
}: {
  view: CandidateView;
  onPick: () => void;
  disabled: boolean;
}) {
  // 막대 축 = **그 스탯의 발행 원본 → 천장**. 카드가 실제로 들고 온 두 값이라 미러가 없다.
  const lo = view.base ?? 0;
  const hi = view.cap ?? 100;
  const span = hi > lo ? hi - lo : 1;
  const curPct = view.from == null ? 0 : pct(((view.from - lo) / span) * 100);
  const toPct = view.to == null ? curPct : pct(((view.to - lo) / span) * 100);
  return (
    <button
      type="button"
      className={styles.cand}
      data-testid={`choice-cand-${view.stat}`}
      data-gain={view.gain}
      onClick={onPick}
      disabled={disabled}
    >
      <span className={styles.candTop}>
        <span className={styles.candStat}>{view.label}</span>
        <span className={styles.gainBadge} data-testid={`choice-gain-${view.stat}`}>
          +{view.gain.toFixed(2)}
        </span>
      </span>
      {view.from != null && view.to != null && (
        <>
          <span className={styles.candNums}>
            <span className={styles.candFrom}>{n1(view.from)}</span>
            <span className={styles.candArrow} aria-hidden="true">
              →
            </span>
            <span className={styles.candTo} data-testid={`choice-to-${view.stat}`}>
              {n1(view.to)}
            </span>
          </span>
          <span className={styles.ceilBar}>
            <i className={styles.ceilCur} style={{ width: `${curPct}%` }} />
            <i
              className={styles.ceilAdd}
              style={{ left: `${curPct}%`, width: `${Math.max(0, toPct - curPct)}%` }}
            />
          </span>
          <span className={styles.ceilLegend}>
            {view.base != null && <span>기본 {n1(view.base)}</span>}
            {view.cap != null && <span>천장까지 {n1(Math.max(0, view.cap - view.to))} 남음</span>}
            {view.cap != null && <span>천장 {n1(view.cap)}</span>}
          </span>
        </>
      )}
    </button>
  );
}

export interface ChoiceCandidatesProps {
  choice: PendingChoice;
  /** 이 선수의 카드. 없으면(로딩) 스탯·상승폭만 그린다 — **현재값을 추측하지 않는다**. */
  card?: CardEffective;
  /** 적용 성공 알림 — 호출부는 **주변 UI**(남은 대기 배너·CTA 라벨)만 바꾼다. */
  onApplied?: (res: ChoiceResult) => void;
  /** 후보 아래에 붙일 보조 액션(예: 보상 시트의 `[나중에 선택]`). */
  footer?: React.ReactNode;
}

/**
 * 후보 3장 + 고정 안내 + 선택 적용 + **적용 결과**.
 *
 * `[나중에 선택]` 은 **보조 버튼**으로 호출부가 `footer` 에 넣는다 — 미루는 것이 기본 동선이
 * 아니라는 게 목업 화면 ③ 의 확인 포인트다.
 *
 * ⚠️ **적용 후 화면(목업 ④)도 여기가 그린다.** 처음엔 호출부가 `onApplied` 를 받아 자기 브랜치로
 * 갈아끼웠는데, 그러면 이 컴포넌트가 **언마운트되면서 축하 오버레이가 같은 프레임에 사라진다**
 * (e2e 가 실제로 잡았다: 클릭 직후 `choice-celebration` 이 없다). 연출과 그 결과는 한 컴포넌트가
 * 소유해야 두 자리(보상 시트·강화탭)에서 같은 순서로 보인다.
 * 다음 선택으로 넘어갈 땐 호출부가 `key={choiceId}` 로 새로 마운트한다.
 */
export function ChoiceCandidates({ choice, card, onApplied, footer }: ChoiceCandidatesProps) {
  const navigate = useNavigate();
  const apply = useApplyChoice();
  const [message, setMessage] = useState<string | null>(null);
  /** 409 MATCH_IN_PROGRESS — 문구가 아니라 **이어하기 안내**다(#217). 없으면 막다른 길이 된다. */
  const [blockedMatchId, setBlockedMatchId] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState<{ label: string; from: number | null; to: number | null; gain: number } | null>(
    null,
  );
  /** 적용 결과 — 축하가 지나간 뒤에도 "무엇이 얼마나 올랐나"가 화면에 남는다(목업 화면 ④). */
  const [applied, setApplied] = useState<{ stat: string; gain: number; from: number | null; to: number | null } | null>(
    null,
  );

  const candidates = Array.isArray(choice?.candidates) ? choice.candidates : [];
  const views = candidates.map((c) => candidateView(c, card));

  function pick(view: CandidateView) {
    setMessage(null);
    setBlockedMatchId(null);
    apply.mutate(
      { choiceId: choice.choiceId, stat: view.stat },
      {
        onSuccess: (res) => {
          const gain = res.gain ?? view.gain;
          setCelebrate({ label: view.label, from: view.from, to: view.to, gain });
          setApplied({ stat: res.stat ?? view.stat, gain, from: view.from, to: view.to });
          onApplied?.(res);
        },
        onError: (err) => {
          const matchId = matchInProgressIdOf(err);
          if (matchId) {
            setBlockedMatchId(matchId);
            return;
          }
          setMessage(err instanceof ApiError ? err.message : "성장 선택에 실패했습니다");
        },
      },
    );
  }

  return (
    <div className={styles.wrap} data-testid={`choice-${choice.choiceId}`} data-choice-level={choice.level}>
      {!applied && (
        <p className={styles.lockNote} data-testid="choice-lock-note">
          <span aria-hidden="true">🔒</span>
          <span>선택지는 고정됩니다 — 나중에 골라도 바뀌지 않아요. 상승폭도 지금 값 그대로 들어갑니다.</span>
        </p>
      )}

      {blockedMatchId && (
        // 진행 중 매치에서는 서버가 막는다(전·후반 사이 강화가 후반만 올리는 버그 차단, #217 AC2).
        // 그 사실을 알리는 것으로 끝내면 유저는 여기서 아무것도 못 한다 — 나가는 문을 같이 준다.
        <div className={styles.blocked} data-testid="choice-match-lock">
          <span>진행 중인 경기가 끝나야 성장을 선택할 수 있어요.</span>
          <button
            type="button"
            className={styles.blockedCta}
            data-testid="choice-resume-match"
            onClick={() => navigate(`/match/${blockedMatchId}`)}
          >
            경기 이어하기
          </button>
        </div>
      )}

      {applied ? (
        <AppliedChoiceCard applied={applied} />
      ) : (
        <>
          <div className={styles.cands} data-testid="choice-candidates">
            {views.map((v) => (
              <CandidateButton key={v.stat} view={v} onPick={() => pick(v)} disabled={apply.isPending} />
            ))}
          </div>

          {/* 후보별 근거 대신 남기는 한 줄 — 응답 값으로 실제 확인되는 사실만 말한다(파일 머리말). */}
          <p className={styles.decayNote}>낮은 스탯일수록 크게 오릅니다 — 천장에 가까울수록 상승폭이 줄어듭니다.</p>

          {footer}
        </>
      )}

      {celebrate && (
        <CelebrationOverlay
          variant="growth"
          testId="choice-celebration"
          accentColor={CELEBRATION_ACCENT}
          title="LEVEL UP"
          subtitle={
            celebrate.from != null && celebrate.to != null
              ? `${celebrate.label} ${n1(celebrate.from)} → ${n1(celebrate.to)}`
              : `${celebrate.label} +${celebrate.gain.toFixed(2)}`
          }
          durationMs={CELEBRATION_MS}
          onDone={() => setCelebrate(null)}
        />
      )}
      <ErrorToast message={message} onDismiss={() => setMessage(null)} />
    </div>
  );
}

/** 적용된 선택 요약(목업 화면 ④) — 무엇이 얼마나 올랐는지가 축하가 지나간 뒤에도 남는다. */
export function AppliedChoiceCard({ applied }: { applied: { stat: string; gain: number; from: number | null; to: number | null } }) {
  const label = STAT_LABEL_MAP[applied.stat] ?? applied.stat;
  return (
    <div className={styles.applied} data-testid="choice-applied" data-stat={applied.stat}>
      <span className={styles.candTop}>
        <span className={styles.candStat}>{label}</span>
        <span className={styles.gainBadge}>+{applied.gain.toFixed(2)}</span>
      </span>
      {applied.from != null && applied.to != null && (
        <span className={styles.candNums}>
          <span className={styles.candFrom}>{n1(applied.from)}</span>
          <span className={styles.candArrow} aria-hidden="true">
            →
          </span>
          <span className={styles.candTo}>{n1(applied.to)}</span>
        </span>
      )}
    </div>
  );
}
