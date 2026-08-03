import type { HighlightToggleView } from "./highlight-sequencer";
import styles from "./HighlightToggle.module.css";

export interface HighlightToggleProps {
  view: HighlightToggleView;
  onToggle: () => void;
}

/**
 * 하이라이트 / 전체 보기 토글 (#421 W4).
 *
 * **자립 부품으로 둔 이유**는 `SkipButton`(W2)·`AutoModeToggle`(#249)과 같다 — 같은 경기 화면을
 * #406(matchux)이 동시에 만지는 중이라, 로직·스타일을 여기 모으고 호출부에는 한 줄만 꽂는다.
 *
 * ⚠️ **#216 이 지운 "하이라이트 토글"과 이름만 같고 축이 다르다.** 그쪽(`viewer-highlight-toggle-*`)은
 * **코어 연출(autoPace — 크루즈 4x / 키장면 1x 슬로우모션)** 을 끄는 스위치였고, 끔 경로가 깨진
 * 렌더를 낳아 제거됐다(계약이 `setAutoPace(false)` 호출 0 까지 박아 뒀다). 이 토글은 연출을 건드리지
 * 않는다 — **어느 구간을 볼 것인가**(장면 순 재생 ↔ 전체 재생)만 고른다. 그래서 재생 컨트롤 바
 * (`viewer-controls-*`, 플레이 모드 버튼 0개)에도 들어가지 않는다(스킵 버튼과 같은 자리 규칙).
 *
 * 노출·문구 규칙은 순수 모듈(`highlight-sequencer.highlightToggleView`)이 소유한다. 이 버튼은
 * **전체 재생으로 돌아가는 유일한 경로**라 장면이 0개여도 사라지지 않는다(그때 사라지면 유저가
 * 켜 둔 모드를 끌 수 없다).
 */
export function HighlightToggle({ view, onToggle }: HighlightToggleProps) {
  if (!view.visible) return null;

  return (
    <div className={styles.wrap} data-testid="highlight-mode">
      {/*
        지금 몇 번째 하이라이트를 보고 있는지 — 장면을 건너뛰는 화면에서 이 줄이 없으면 유저는
        "왜 갑자기 딴 장면이 나오지"가 된다. 재생 중이 아니면 렌더 자체가 없다.
      */}
      {view.status && (
        <span className={styles.status} data-testid="highlight-status">
          {view.status}
        </span>
      )}
      <button
        type="button"
        className={`${styles.toggle} ${view.pressed ? styles.on : ""}`}
        data-testid="highlight-toggle"
        data-highlight={view.pressed ? "on" : "off"}
        /*
         * ⚠️ **세 축이 한 곳을 가리켜야 한다**(독립검증 N5 — `AutoModeToggle` 과 같은 모양):
         *  · 이름 = **고정**(`하이라이트 모드`). 예전엔 `aria-label={view.hint}` 라 이름이 **액션
         *    문장**이었고, 그게 상태를 말하는 `aria-pressed` 와 정면으로 갈렸다.
         *  · `aria-pressed` = 하이라이트가 켜져 있나(= 보이는 글자의 `ON`/`OFF` 와 같은 축).
         *  · `hint`(누르면 뭐가 되나)는 **설명**이라 `title` 로만 나간다 — 이름으로 쓰지 마라.
         */
        aria-pressed={view.pressed}
        aria-label="하이라이트 모드"
        title={view.hint}
        onClick={onToggle}
      >
        {view.label}
      </button>
    </div>
  );
}
