import { FLOW_COPY } from "./flow-copy";
import { flowNextHint, flowSteps } from "./match-flow";
import styles from "./FlowStepper.module.css";

interface FlowStepperProps {
  state: string | undefined;
  auto?: boolean | undefined;
}

/**
 * 대기형 브릿지(B1 경기 시작 · B3 후반 시작)의 **"지금 어디 / 다음 뭐"** 한 줄 (#424 W1).
 *
 * ⚠️ **`GenWaitPanel` 의 기존 문구를 새로 쓰지 않는다.** 제목·정경 문장은 #382 에서 hero 가 직접
 * 확정한 축이고("시스템을 설명하지 않는다") 계약이 리터럴로 들고 있다. 브릿지가 더하는 것은
 * **단계 정보**뿐이며, 그것도 시스템 어휘 없이 쓴다(`전반 준비`, `다음 · 전반 킥오프`).
 *
 * 오토 모드의 `감독시간` 스텝은 **지우지 않고 흐림 + `건너뜀`** 이다 — 스텝 수가 달라지면 유저가
 * 오토/일반 두 화면을 다르게 배운다(설계 §10.1).
 */
export function FlowStepper({ state, auto }: FlowStepperProps) {
  const steps = flowSteps(state, auto);
  const next = flowNextHint(state);

  return (
    <div className={styles.wrap} data-testid="flow-stepper">
      <ol className={styles.steps}>
        {steps.map((s) => (
          <li
            key={s.id}
            className={styles.step}
            data-testid={`flow-step-${s.id}`}
            data-status={s.status}
            data-skipped={s.skipped ? "true" : undefined}
            aria-current={s.status === "current" ? "step" : undefined}
          >
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.label}>{s.label}</span>
            {s.skipped && <span className={styles.skipped}>{FLOW_COPY.stepper.skipped}</span>}
          </li>
        ))}
      </ol>
      {next && (
        <p className={styles.next} data-testid="flow-stepper-next">
          {next}
        </p>
      )}
    </div>
  );
}
