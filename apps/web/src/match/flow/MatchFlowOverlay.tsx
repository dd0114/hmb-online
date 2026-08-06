import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MatchDetail } from "../../api/hooks";
import { Modal } from "../../common/Modal";
import { HalfReportModal, type ReportStackCard } from "../HalfReportModal";
import { captureOffsetMs, countdownLabel } from "../live-clock";
import { useCountdown } from "../useCountdown";
import { playedBaseline } from "../stage/stage-state";
import { FLOW_COPY } from "./flow-copy";
import { bridgeCardModel, bridgeScore, matchEndHandoff, type MatchEndContinuation } from "./match-flow";
import type { MatchFlowHandle } from "./useMatchFlow";
import styles from "./MatchFlowOverlay.module.css";

export interface MatchFlowOverlayProps {
  flow: MatchFlowHandle;
  match: MatchDetail | undefined;
  homeName: string;
  awayName: string;
  myTeamSide?: "home" | "away" | null;
  /**
   * 경기 종료 뒤 오버레이 안에서 올 화면. **출하 호출부 = `App.tsx` 의 `MATCH_END_CONTINUATION`**
   * (#456 S4 = 순차 보상 카드). 이 prop 이 곧 CTA 라벨을 가른다(`보상 받기` ↔ `보상과 결과 보기`).
   *
   * 넘기지 않으면 닫는 즉시 봉투가 미확인일 때 #405 시트가, 아니면 결과 탭이 나온다
   * (C2 — 이 prop 없이도 흐름이 완결된다. 에러 격리가 그 갈래로 떨어진다).
   */
  matchEndContinuation?: MatchEndContinuation | null;
}

/**
 * 경기 흐름 오버레이 — **하나의 카드 스택, 하나의 닫기** (#424 W1).
 *
 * 소유자는 `MatchPage` 다(`StageShell` 아님). 그래야 패널이 갈려도 오버레이가 산다 — 스킵 응답이
 * `GEN2` 면 `panelForState` 가 `GenWaitPanel` 로 라우팅해 `StageShell` 이 언마운트되는데, #421 은
 * 리포트를 거기 매달아 둬서 **유저가 리포트를 못 봤다**(D6 갭). 브릿지도 정확히 같은 문제를 겪는다
 * (B2 를 열어 둔 채 감독시간이 만료되면 `HALFTIME`→`GEN2` 로 패널이 갈린다).
 *
 * 스택 자체는 `HalfReportModal` 이 그린다 — 스택 연출(뒤 카드·페이저·도트·뷰포트 여백 #386 ·
 * 본문 페이드 #292)을 **재발명하지 않는다**. 브릿지는 그 배열의 **첫 카드**로 들어간다(#456 —
 * 구 규칙은 마지막이었고, 그래서 스킵 경로에서 두 번 눌러야 나왔다).
 *
 * ⚠️ **이 오버레이는 어떤 서버 호출도 하지 않는다**(설계 §6.4). 닫기 = 로컬 상태 해제뿐이라
 * "브릿지를 닫았는데 갈 곳이 없다"가 구조적으로 불가능하다 — 닫으면 그 순간의 `panelForState`
 * 결과가 그대로 뒤에 있다.
 */
export function MatchFlowOverlay({
  flow,
  match,
  homeName,
  awayName,
  myTeamSide = null,
  matchEndContinuation = null,
}: MatchFlowOverlayProps) {
  const clock = match?.clock ?? null;
  const [offsetMs, setOffsetMs] = useState(0);
  const [continuing, setContinuing] = useState(false);
  const doneRef = useRef(false);

  // 서버 시계 오프셋은 **응답이 도착한 그 순간에 한 번** 잰다(live-clock.captureOffsetMs 주석 —
  // 프레임마다 다시 재면 serverNow 에 고정돼 카운트다운이 멈춘다).
  useEffect(() => {
    if (clock) setOffsetMs(captureOffsetMs(clock, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock?.serverNow]);
  const remaining = useCountdown(clock, offsetMs);

  const bridge = flow.bridge;
  const closeFlow = flow.close;

  /** C4 — `onDone` 은 멱등이다(보상 연출이 애니메이션 끝과 버튼 클릭 양쪽에서 부를 수 있다). */
  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setContinuing(false);
    closeFlow();
  }, [closeFlow]);

  const startContinuation = useCallback(() => {
    doneRef.current = false;
    setContinuing(true);
  }, []);

  const beat = flow.beat;

  if (!match) return null;

  const beatNode = beat ? (
    /*
     * 킥오프 비트 — **백드롭이 없다**(경기 화면이 뒤에 비친다). 자동 소멸 + 클릭 시 즉시 소멸.
     * 이 층은 무대를 내리지 않는다(`overlayOpen` 에 비트가 없는 이유 — useMatchFlow 주석).
     */
    <div
      className={styles.beat}
      data-testid="flow-beat"
      data-beat={beat}
      role="status"
      aria-live="polite"
      onClick={flow.dismissBeat}
    >
      <p className={styles.beatBig}>{FLOW_COPY.beat[beat].big}</p>
      <p className={styles.beatSmall}>{FLOW_COPY.beat[beat].small}</p>
      {/* 시안 3번째 줄 — 이 층이 "눌러서 넘길 수 있다"를 말하는 유일한 자리다(#456 B2). */}
      <p className={styles.beatHint} data-testid="flow-beat-hint">
        {FLOW_COPY.beatHint}
      </p>
    </div>
  ) : null;

  if (!bridge) return beatNode;

  // 보상 흐름(#405)은 **같은 오버레이 안에서** 렌더된다(C3 — 라우트를 만들면 MatchLockGate(#217)·
  // 뒤로가기·재입장 경로가 전부 새 케이스가 된다).
  if (continuing && matchEndContinuation) {
    return (
      <>
        {beatNode}
        <Modal
          onClose={finish}
          labelledBy="flow-continuation-label"
          overlayClassName={styles.contOverlay}
          className={styles.contBox}
          testId="flow-continuation"
          dismissable={false}
        >
          <h2 id="flow-continuation-label" className={styles.srOnly}>
            경기 보상
          </h2>
          {/*
            C5 — 보상 연출이 던져도 결과 화면 도달을 막지 않는다(StarterReveal 선례).
            ⚠️ **continuation 을 여기서 부르면 안 된다** — 이 render 는 바운더리 **밖**이라
            그 자리에서 던지면 잡히지 않고 매치 화면이 통째로 죽는다(계약이 실제로 잡았다).
            호출을 바운더리 **자식의** render 로 미룬다.
          */}
          <ContinuationBoundary
            onFail={finish}
            render={() => matchEndContinuation(matchEndHandoff(match, bridge.report != null), finish)}
          />
        </Modal>
      </>
    );
  }

  // ⚠️ **내용은 열림 시점 스냅샷이 아니라 매 렌더의 `match.state` 파생**이다(설계 §4.4). 그래서
  // 감독시간이 만료돼 상태가 GEN2/SECOND_HALF 로 가도 카드가 거짓말하지 않고 따라간다.
  const model = bridgeCardModel(bridge.kind, {
    state: match.state,
    auto: match.auto,
    outcome: match.result ?? null,
    countdown: countdownLabel(remaining),
    hasContinuation: Boolean(matchEndContinuation),
  });

  const card: ReportStackCard = {
    id: "bridge",
    kicker: model.kicker,
    title: model.title,
    ctaLabel: model.cta,
    className: styles.bridgeCard!,
    body: (
      <div className={styles.bridgeBody}>
        <p className={styles.bridgeText} data-testid="flow-bridge-text">
          {model.body}
        </p>
        {model.note && (
          <p className={styles.bridgeNote} data-testid="flow-bridge-note">
            {model.note}
          </p>
        )}
        {model.nextHint && (
          <p className={styles.bridgeNextHint} data-testid="flow-bridge-next-hint">
            {model.nextHint}
          </p>
        )}
      </div>
    ),
  };

  const half = bridge.report;
  return (
    <>
      {beatNode}
      <HalfReportModal
        matchId={match.id}
        half={half}
        homeName={homeName}
        awayName={awayName}
        myTeamSide={myTeamSide}
        /*
         * 베이스라인은 **리포트가 말하는 하프** 기준이다 — 오토 모드(전반 스킵 → 응답이 바로
         * SECOND_HALF)에서 무대 하프 기준으로 잡으면 전반 리포트에 전반 스코어를 한 번 더 얹는다.
         */
        baseline={half != null ? playedBaseline(half === 1 ? "FIRST_HALF" : "SECOND_HALF", match) : null}
        score={bridgeScore(bridge.kind, match)}
        extraCards={[card]}
        /*
         * #456: 브릿지가 **첫 장**이라 마지막 장은 리포트다 — 끝맺음 버튼이 `닫기` 로 퇴화하지
         * 않게 브릿지가 말한 목적지를 그대로 내려 준다(`HalfReportModal.finalCtaLabel` 주석).
         */
        finalCtaLabel={model.cta}
        /*
         * 리포트가 없는 스택은 **다른 이름**을 받는다 — "스킵하지 않았으니 리포트가 뜨지 않는다"를
         * 단언하는 계약(#421 i)이 브릿지를 리포트로 오인하면 그 계약이 조용히 무의미해진다.
         */
        testIdBase={half != null ? "half-report" : "flow-bridge"}
        onClose={bridge.kind === "match_end" && matchEndContinuation ? startContinuation : closeFlow}
      />
    </>
  );
}

/**
 * C5 — continuation 이 던지면 **오버레이는 닫힌다**.
 *
 * 보상 연출의 실패가 결과 화면 도달을 막으면 안 된다(가입 지급 연출 `StarterReveal` 이 같은 규칙:
 * *"연출이 없다고 동선이 막히면 안 된다"*). 여기서 화면을 지우지 않고 `onFail` 로 흐름을 끝낸다.
 */
class ContinuationBoundary extends Component<
  { onFail: () => void; render: () => ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFail();
  }

  render() {
    // ⚠️ 자식 컴포넌트 안에서 호출한다 — 바운더리는 **자기 render 의 예외를 못 잡는다**.
    return this.state.failed ? null : <ContinuationSlot render={this.props.render} />;
  }
}

function ContinuationSlot({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}
