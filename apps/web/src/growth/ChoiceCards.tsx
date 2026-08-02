import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useApplyChoice } from "../api/growth-hooks";
import type { CardEffective, ChoiceCandidate, ChoiceResult, PendingChoice } from "../api/growth";
import { CelebrationOverlay } from "../common/CelebrationOverlay";
import { ErrorToast } from "../common/ErrorToast";
import { matchInProgressIdOf } from "../common/match-lock";
import { cardAxisWindow, STAT_LABEL_MAP } from "./growth-config";
import { reasonTextOf } from "./choice-reason";
import styles from "./ChoiceCards.module.css";

/**
 * **3지선다 후보 카드** — 보상 시트(#405 화면 ③)와 강화탭(화면 ⑤)이 **같은 컴포넌트**를 쓴다.
 *
 * 두 자리에서 모양이 갈리면 안 된다는 게 설계 §2.10 의 명시 요구다. 그래서 선택 뮤테이션·축하
 * 연출·에러 처리까지 **여기 하나가** 갖는다 — 호출부가 흉내 내기 시작하면 한쪽만 낡는다.
 *
 * ── "왜 이 후보인가" 한 줄 ──────────────────────────────────────────────────────────────
 * 서버가 후보마다 `reason` 을 박제해 내린다(`{kind, detail}`). **문장은 클라가 만든다** —
 * 매핑·규율은 `choice-reason.ts`. 만들 수 없으면(모르는 enum · `BASE` · 초판 행의 `null`)
 * **줄을 생략**한다. 지어내지 않는다.
 *
 * ── 막대의 원점은 **세 후보가 공유**해야 한다 ────────────────────────────────────────────
 * 감쇠가 `r = (v − startLo)/(ceiling − startLo)` 이므로, 막대를 스탯별 `base` 에서 시작시키면
 * 세 후보가 **서로 다른 원점**을 갖게 되어 "낮은 스탯일수록 크게 오른다"가 화면에서 안 읽힌다
 * (초판이 그 상태였고 독립 검증이 잡았다) — 목업이 이 화면에 부여한 유일한 정보 기능이다.
 * 그래서 원점은 카드 전체 축(`cardAxisWindow`)에서 온다. **강화탭 막대와 같은 함수**라 두 화면이
 * 갈릴 수 없다.
 * ⚠️ 목업의 정확한 원점은 등급 공유 `startLo` 인데 **서버가 아직 안 내린다**(`growCeil`·
 * `starCeilBonus` 는 온다). 그래서 지금은 카드의 발행 원본 최소값에서 앵커를 잡는다 — 공유
 * 원점이라는 성질은 같고, 값만 근사다. `bands.<GRADE>.startLo` 가 오면 그 값으로 바꾸고
 * 좌측 라벨을 `시작 {startLo}` 로 되살린다.
 */

const CELEBRATION_MS = 1700;
/**
 * 목업 화면 ④ 의 `LEVEL UP` 금색(`--warn`). 초록(성장분 색)이 아니다 — 초록은 **막대의 성장분**을
 * 뜻하는 색이라 축하 제목까지 초록으로 쓰면 두 뜻이 겹친다. 목업이 제목만 금색으로 뺀 이유다.
 */
const CELEBRATION_ACCENT = "#ffc24b";

/** 스탯 1종의 "지금 → 적용 후"와 그 스탯의 천장. 카드가 아직 없으면 null(숫자를 지어내지 않는다). */
export interface CandidateView {
  stat: string;
  label: string;
  gain: number;
  from: number | null;
  to: number | null;
  cap: number | null;
  /** 세 후보가 **공유**하는 막대 원점(위 머리말). 카드가 없으면 null. */
  axisLo: number | null;
  /** 화면에 그릴 근거 한 줄. 만들 수 없으면 null → 줄 생략. */
  reason: string | null;
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
  // 강화탭 막대와 **같은 함수**로 원점을 잡는다 — 두 화면이 다른 축을 쓰면 같은 카드가 두 모습이 된다.
  const axisLo = base && caps ? cardAxisWindow(base, caps).lo : null;
  return {
    stat,
    label: STAT_LABEL_MAP[stat] ?? stat,
    gain: c.gain,
    from,
    to,
    cap,
    axisLo,
    reason: reasonTextOf(c.reason),
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
  // 막대 축 = **카드 공유 원점 → 그 스탯의 천장**. 원점이 셋 다 같아야 gain 차이가 읽힌다(머리말).
  const lo = view.axisLo ?? 0;
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
            {/* ⚠️ 좌측에 `시작 {startLo}` 라벨을 붙이지 않았다 — 서버가 `startLo` 를 안 내려서
                이 원점은 근사치다(머리말). 값이 오면 라벨과 함께 되살린다. 근사치에 정확한 이름을
                붙이면 그게 곧 화면의 거짓말이다. */}
            <span />
            {view.cap != null && <span>천장까지 {n1(Math.max(0, view.cap - view.to))} 남음</span>}
            {view.cap != null && <span>천장 {n1(view.cap)}</span>}
          </span>
        </>
      )}
      {view.reason && (
        <span className={styles.candWhy} data-testid={`choice-why-${view.stat}`}>
          <span className={styles.candWhyTag}>왜</span>
          <span>{view.reason}</span>
        </span>
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

          {/* 세 막대가 **같은 원점**을 쓰는 이유를 말하는 줄 — 그게 이 화면의 정보 기능이다(머리말). */}
          <p className={styles.decayNote}>낮은 스탯일수록 크게 오릅니다 — 천장에 가까울수록 상승폭이 줄어듭니다.</p>

          {footer}
        </>
      )}

      {celebrate && (
        <CelebrationOverlay
          // `growth` 변이는 마킹이자 **스타일 스코프**다 — 목업 ④ 는 알약 뱃지가 아니라 큰 금색
          // `LEVEL UP` 이라, 공용 CSS 를 바꾸는 대신 이 변이에만 룩을 얹는다(성★·티어업 무영향).
          variant="growth"
          testId="choice-celebration"
          accentColor={CELEBRATION_ACCENT}
          title="LEVEL UP"
          subtitle={celebrate.label}
          steps={[
            <span key="delta" data-testid="choice-celebration-delta">
              {celebrate.from != null && celebrate.to != null
                ? `${n1(celebrate.from)} → ${n1(celebrate.to)} (+${celebrate.gain.toFixed(2)})`
                : `+${celebrate.gain.toFixed(2)}`}
            </span>,
          ]}
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
