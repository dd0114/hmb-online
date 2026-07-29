import type { ReactNode } from "react";
import { PROMPT_MAX_CHARS } from "../deck/deck-logic";
import styles from "./PromptBlock.module.css";

export interface PromptBlockProps {
  /** 누구에게 말하는가 — "팀 전체에게" / "7. 강태호 에게". */
  title: string;
  /** 신원 보조(포지션·컨디션 등). 없으면 생략. */
  subtitle?: string;
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  /** 카운터에 쓰는 길이 — 합성문(선택지+자유문장) 길이가 실제 전송 길이인 경우가 있다. */
  countLength?: number;
  rows?: number;
  disabled?: boolean;
  /** 한도 초과 표시(합성 결과가 넘칠 때). */
  over?: boolean;
  testId: string;
  /**
   * "지금 누구에게 말하는가" 라벨의 testid. 기본은 `${testId}-target` 이지만, 대상이 바뀌면
   * testId 자체가 바뀌는 화면(감독시간: 팀 ↔ 선수)에서는 **고정된 이름**이 필요하다.
   */
  targetTestId?: string;
  /** 카운터 줄 오른쪽에 붙는 액션들(자리 바꾸기 · 제거 · 팀으로 돌아가기). */
  actions?: ReactNode;
  /** 문구 삽입 칩 등, 입력 아래 보조 영역. */
  children?: ReactNode;
}

/**
 * **프롬프트 = 이 게임의 1급 입력** (이슈 #244).
 *
 * 덱 편성 · 브리핑 · 감독시간이 **같은 블록**을 쓴다. 예전에는 감독시간이 이 모양을 손으로 복제해
 * 갖고 있었는데, 그러면 한쪽만 고쳐질 때 "같은 입력인데 화면마다 다르게 생긴" 상태가 된다
 * (hero 지적: "하프타임 자체가 교체만 활성화되고 덱 만들 때랑 똑같잖아").
 *
 * ⚠️ 모양은 하나지만 **문장이 가는 곳은 화면마다 다르다** — 덱/브리핑은 덱 스냅샷(`promptText`,
 * PUT /api/deck)이고 감독시간은 매치 프롬프트(POST /prompts, phase=halftime)다. 그 차이는 진짜라
 * 여기서 숨기지 않는다(호출부가 `onChange` 로 결정한다).
 */
export function PromptBlock(props: PromptBlockProps) {
  const {
    title, subtitle, value, onChange, placeholder, countLength, rows = 4,
    disabled, over, testId, targetTestId, actions, children,
  } = props;
  const len = countLength ?? value.length;
  return (
    <div className={styles.block}>
      <div className={styles.head}>
        <b className={styles.title} data-testid={targetTestId ?? `${testId}-target`}>
          {title}
        </b>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        {/* #244: "AI가 읽는다"는 **한 번만** 말한다. 예전엔 머리 뱃지 + 카운터 문장 + 플레이스홀더로
            같은 말이 세 번 나와 세로만 먹었다(재설계 진단). 뱃지 하나로 남긴다. */}
        <span className={styles.tag}>AI가 읽는다</span>
      </div>
      <textarea
        className={over ? styles.textareaOver : styles.textarea}
        data-testid={testId}
        aria-label={title}
        rows={rows}
        maxLength={PROMPT_MAX_CHARS}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className={styles.meter}>
        <b data-testid={`${testId}-count`}>{len}</b> / {PROMPT_MAX_CHARS}
        {actions}
      </div>
      {children}
    </div>
  );
}
