/**
 * 폰 드래그 제스처의 **단일 출처** (#439 R1, hero 확정 Q3=ⓐ).
 *
 * ── 무엇이 문제였나 ──────────────────────────────────────────────────────────────────────────
 * "폰에서 드래그가 안 된다"(hero 라이브 제보)의 정체는 센서 버그가 **아니었다**. W0 실측:
 *   · 손가락을 대자마자 밀면 → 자리 안 바뀜 **3/3**
 *   · 300ms 참고 나서 밀면 → 자리 바뀜 **3/3**
 * 즉 드래그는 `TOUCH_ACTIVATION_MS` 를 **참은 사람에게만** 작동했고, 참으라는 신호가 화면에
 * 하나도 없었다. e2e 는 `waitForTimeout(300)` 으로 일부러 참아 줘서 계약도 초록이었다.
 *
 * ⛔ 되돌리면 안 되는 것 둘:
 *   · `MouseSensor`/`TouchSensor` **분리**(#98 의 수정) — `PointerSensor` 로 합치면 터치에서
 *     pointerdown 이 먼저 잡혀 롱프레스 활성화가 영영 안 걸린다.
 *   · 리스트 행의 `touch-action` 을 `none` 으로 — 리스트 터치 스크롤이 죽는다
 *     (`PlayerPicker.module.css` 실측 근거, `deck-list-dnd-touch.spec.ts` 가 회귀를 잡는다).
 *
 * ⇒ 그래서 hero 가 고른 것은 **제스처가 아니라 어포던스**다: 롱프레스는 그대로 두고, 잡히는
 *   과정을 눈에 보이게 만든다. 이 파일의 두 상수를 **센서(`DeckEditor`)와 표시(`TacticsBoard`)가
 *   같이 읽는다** — 갈라지면 링이 다 찼는데 아직 안 잡히거나(또는 그 반대) 어포던스가 거짓말한다.
 */

/** 손가락을 이만큼 누르고 있어야 드래그가 시작된다(@dnd-kit TouchSensor `delay`). */
export const TOUCH_ACTIVATION_MS = 150;

/** 그 대기 동안 허용되는 손가락 흔들림(@dnd-kit TouchSensor `tolerance`). 넘으면 스크롤로 넘어간다. */
export const TOUCH_TOLERANCE_PX = 8;

/** 마우스는 지연이 아니라 거리로 활성화한다(데스크탑은 클릭과 드래그를 거리로 가른다). */
export const MOUSE_ACTIVATION_PX = 6;

/** 잡히는 순간의 햅틱(ms). 장치가 없으면 조용히 건너뛴다 — 연출 실패가 동작을 막지 않는다. */
export const GRAB_VIBRATE_MS = 12;

/** 잡혔다는 것을 손끝으로도 알린다. 지원하지 않는 브라우저·설정에서는 아무 일도 하지 않는다. */
export function vibrateOnGrab(): void {
  try {
    navigator.vibrate?.(GRAB_VIBRATE_MS);
  } catch {
    /* 사용자 제스처 정책·미지원 — 무시한다(어포던스의 시각 축은 이미 떠 있다). */
  }
}
