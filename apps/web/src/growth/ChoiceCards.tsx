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
 * ── ⚠️ 세로 카드 3장 + 정보 감량 (#456 S4-W2 AC4, hero 지시) ─────────────────────────────
 * hero: *"강화 카드는 이미 세로 3장 — **누가 어떤 스탯 몇 올리는지**만 남기고 정보 감량"*.
 * 그래서 카드에 **남는 것**은 스탯 라벨 · 포지션 핵심 배지 · `+gain` · `[이 스탯 선택]` 뿐이고,
 * 아래 다섯은 **의도적으로 없다**:
 *   ① 현재→적용후(`50.0 → 52.0`) ② 천장 막대 2층 ③ 범례(`시작 N`/`천장까지`/`천장`)
 *   ④ 근거줄(`왜 …`) ⑤ 감쇠 설명(`낮은 스탯일수록 …`)
 * 사라진 것은 **화면 줄**이지 규칙이 아니다 — 근거 문장 매핑은 `choice-reason.ts`(+ 그 테스트),
 * 막대 원점은 `growth-config.cardAxisWindow`(강화탭 스탯 막대가 계속 소비)가 그대로 갖고 있다.
 * 두 모듈을 **지우지 않은 이유가 그것이다**: hero 가 되돌리라고 하면 화면 줄만 복구하면 된다.
 * ⚠️ 그리고 `from → to` 는 화면에서 사라졌지 계산에서 사라진 게 아니다 — **축하 연출**
 * (`44.0 → 47.8 (+3.82)`)과 **적용 후 카드**가 그 값을 쓴다. `candidateView` 가 계속 필요한 이유다.
 *
 * ⚠️ **클릭 = 즉시 적용이다**(두 단계 확인이 아니다). `[이 스탯 선택]` 은 카드 안의 **행동 라벨**이지
 * 별도 확인 버튼이 아니다 — 확인 단계를 넣으면 이 컴포넌트를 쓰는 두 자리(보상 시트·강화탭)의
 * 기존 계약이 전부 "클릭 → 축하" 를 전제하고 있어서 같이 깨진다. 되돌릴 수 없는 선택이라는 경고는
 * `.lockNote` 가 계속 말한다.
 *
 * ── ⚠️ 후보 **순서를 다시 정렬하지 마라** ────────────────────────────────────────────────
 * 서버가 `positionBaseline × gain` 내림차순으로 내린다(`ChoiceCandidate` 주석). 화면에서 제일
 * 눈에 띄는 숫자는 gain 배지인데 감쇠 탓에 gain 이 큰 쪽은 **낮은 스탯**이라, gain 순으로 그리면
 * 1번 자리에 **전력(OVR)으로는 지는 선택**이 온다(GK 의 `shooting` 이 그 예: gain 은 2등인데
 * 서버 순서로는 꼴찌다). 정렬 기준값은 안 내려오니 여기서 재현할 수도 없다 — 받은 순서 그대로 그린다.
 * 계약 = `p405-reward-sheet.spec.ts` (gain 내림차순이 **아닌** 응답으로 순서를 단언한다).
 */

const CELEBRATION_MS = 1700;
/**
 * 목업 화면 ④ 의 `LEVEL UP` 금색(`--warn`). 초록(성장분 색)이 아니다 — 초록은 **막대의 성장분**을
 * 뜻하는 색이라 축하 제목까지 초록으로 쓰면 두 뜻이 겹친다. 목업이 제목만 금색으로 뺀 이유다.
 */
const CELEBRATION_ACCENT = "#ffc24b";

/**
 * 스탯 1종의 "지금 → 적용 후"와 그 스탯의 천장. 카드가 아직 없으면 null(숫자를 지어내지 않는다).
 *
 * ⚠️ `from`/`to` 는 **후보 카드가 아니라 축하 연출·적용 후 카드**가 쓴다(AC4 감량). 지우면
 * `44.0 → 47.8 (+3.82)` 이 `+3.82` 로 퇴화한다.
 */
export interface CandidateView {
  stat: string;
  label: string;
  gain: number;
  from: number | null;
  to: number | null;
  /** 천장 — `to` 를 자르는 데만 쓴다(라벨로는 안 나간다). */
  cap: number | null;
  /** 그 포지션 핵심 스탯인가. **모르면 null**(구 박제분) → 배지 생략. */
  core: boolean | null;
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
  const from = num(pre?.[stat]) ?? num(attrs?.[stat]);
  const cap = num(caps?.[stat]);
  const to = from == null ? null : cap == null ? from + c.gain : Math.min(cap, from + c.gain);
  return {
    stat,
    label: STAT_LABEL_MAP[stat] ?? stat,
    gain: c.gain,
    from,
    to,
    cap,
    // `false` 로 눕히지 않는다 — 없는 사실을 단언하게 된다(ChoiceCandidate.core 주석).
    core: typeof c.core === "boolean" ? c.core : null,
  };
}

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
  return (
    <button
      type="button"
      className={styles.cand}
      data-testid={`choice-cand-${view.stat}`}
      data-gain={view.gain}
      onClick={onPick}
      disabled={disabled}
    >
      <span className={styles.candStat}>{view.label}</span>
      {/*
        포지션 핵심 배지 — gain 배지 **바로 위**다. 이 화면의 판단은 "얼마나 오르나"(gain)와
        "그게 이 선수에게 값어치가 있나"(core) 둘인데, 후자가 없어서 화면이 지는 선택을 유도하고
        있었다(서버 `619d18b`). 감량하면서도 이 배지를 남긴 이유가 그것이다 — 두 축이 같이 있어야
        비교가 성립하고, gain 만 남기면 화면이 **다시** 지는 선택을 가리킨다.
      */}
      {view.core === true ? (
        <span className={styles.coreBadge} data-testid={`choice-core-${view.stat}`}>
          포지션 핵심
        </span>
      ) : (
        // 자리를 비워 세 카드의 gain 줄이 같은 높이에 선다(없는 사실은 여전히 안 그린다).
        <span className={styles.coreSpacer} aria-hidden="true" />
      )}
      <span className={styles.gainBadge} data-testid={`choice-gain-${view.stat}`}>
        +{view.gain.toFixed(2)}
      </span>
      {/* 되돌릴 수 없는 행동이라 카드가 스스로 무엇을 하는지 말한다(#456 AC3). */}
      <span className={styles.candCta}>이 스탯 선택</span>
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
          {/* ⚠️ **받은 순서 그대로**(머리말) — `sort` 를 끼워 넣는 순간 이 화면의 요점이 사라진다. */}
          <div className={styles.cands} data-testid="choice-candidates">
            {views.map((v) => (
              <CandidateButton key={v.stat} view={v} onPick={() => pick(v)} disabled={apply.isPending} />
            ))}
          </div>

          {/*
            ⚠️ 감쇠 설명 줄(`낮은 스탯일수록 크게 오릅니다 …`)은 **은퇴했다**(AC4 감량). 그 줄은
            세 막대가 같은 원점을 쓴다는 사실을 설명하는 각주였는데, 막대가 사라지면서 설명할
            대상 자체가 없어졌다. 규칙(감쇠)은 서버에 그대로 있고 결과는 `+gain` 차이로 보인다.
          */}
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
