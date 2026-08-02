/**
 * 경기 스킵 — **순수 화면 규칙** (#421 W2).
 *
 * 서버가 흐름의 SoT 다(`POST /api/matches/{id}/skip` = 재생 창을 지금으로 당기고 기존 만료 전이를
 * 밟는다, W1). 여기 있는 건 **언제 버튼을 보여주고 · 무엇을 phase 로 보내고 · 실패를 어떻게 읽을까**
 * 뿐이다 — 전이 규칙을 클라가 복제하면 서버가 바뀔 때 조용히 어긋난다(#217·#249 교훈).
 *
 * React·DOM·API 의존 0 → vitest 로 계약을 박는다(`stage-state.ts`·`auto-mode.ts` 선례).
 */

/** 스킵할 수 있는 단계 = **재생 창이 열려 있는 하프**. 서버 요청 바디의 `phase` 와 같은 값. */
export type SkipPhase = "FIRST_HALF" | "SECOND_HALF";

/**
 * 이 상태에서 스킵할 수 있는가 — 라이브 하프만이다.
 *
 * 감독시간(HALFTIME)은 일부러 뺐다: 그 화면엔 [후반 시작]이 이미 있고(`HalftimePanel`),
 * 서버도 라이브 하프가 아니면 **409** 다. 브리핑·생성·종료도 같은 이유로 대상이 아니다.
 */
export function skipPhaseOf(state: string | undefined): SkipPhase | null {
  if (state === "FIRST_HALF") return "FIRST_HALF";
  if (state === "SECOND_HALF") return "SECOND_HALF";
  return null;
}

/** 그 단계를 스킵했을 때 **리포트가 말하는 하프**. 전반 스킵 → 전반 리포트. */
export function reportHalfOf(phase: SkipPhase): 1 | 2 {
  return phase === "FIRST_HALF" ? 1 : 2;
}

export interface SkipButtonInput {
  /** 매치 상태(서버 SoT). */
  state?: string | undefined;
  /** 스킵 요청이 진행 중인가 — **중복 클릭 방지**의 유일한 축이다. */
  pending?: boolean;
  /**
   * 돌려보는 화면인가(#244 review — 감독시간 `경기장면` 탭·다시보기).
   *
   * 거기서 보는 하프는 **이미 끝난 하프**라 건너뛸 "남은 재생"이 없고, 버튼을 그리면 지금 도는
   * 단계(예: 감독시간)를 스킵하는 것처럼 읽힌다. 렌더 쪽에도 같은 가드가 있지만(그쪽이 구조적
   * 보장이다) 규칙을 여기에 적어 둔다 — 새 호출부가 생겼을 때 답이 한 곳에 있어야 한다.
   */
  review?: boolean;
}

export interface SkipButtonView {
  visible: boolean;
  disabled: boolean;
  /** 서버로 보낼 phase. `visible === false` 면 null. */
  phase: SkipPhase | null;
  label: string;
  /** title/aria — **다음에 일어날 일**을 말한다(무엇을 누르나 < 뭐가 달라지나, `auto-mode` 규칙). */
  hint: string;
}

const HIDDEN: SkipButtonView = { visible: false, disabled: true, phase: null, label: "", hint: "" };

/**
 * 스킵 버튼의 화면 상태.
 *
 * ⚠️ **보이지 않는 것과 눌리지 않는 것을 섞지 마라.** 라이브가 아니면 아예 없고(그 자리에 회색
 * 버튼이 남아 있으면 유저는 "왜 안 되지"를 묻는다), 요청 중이면 있되 눌리지 않는다(같은 요청을
 * 두 번 보내면 CAS 가 한 번은 409 를 돌려주고 화면이 이유 없이 흔들린다).
 */
export function skipButtonView(input: SkipButtonInput): SkipButtonView {
  if (input.review) return HIDDEN;
  const phase = skipPhaseOf(input.state);
  if (!phase) return HIDDEN;
  const pending = input.pending === true;
  return {
    visible: true,
    disabled: pending,
    phase,
    label: pending ? "스킵 중…" : "⏩ 스킵",
    hint:
      phase === "FIRST_HALF"
        ? "남은 전반을 건너뛰고 전반 리포트를 봅니다"
        : "남은 후반을 건너뛰고 후반 리포트를 봅니다",
  };
}

/**
 * "이미 넘어갔다" 인가 — 서버 **409**(INVALID_STATE).
 *
 * 스위퍼(1초)·오토(#249)·다른 탭이 같은 경계를 먼저 밟으면 내 스킵은 CAS 0행으로 떨어져 409 가
 * 온다. 그건 **실패가 아니라 사실의 통지**다(#217 의 `MATCH_IN_PROGRESS` 와 같은 성질) — 에러
 * 토스트를 띄우면 유저는 자기가 뭘 잘못한 줄 안다. 화면은 매치를 다시 물어 따라가면 된다.
 *
 * ⚠️ 리포트는 열지 않는다. 이 요청이 그 하프를 끝낸 게 아니라 **이미 끝나 있던 것**이고,
 * 그 사이 상태가 어디까지 갔는지는 재조회가 답한다.
 */
export function isAlreadyAdvanced(err: unknown): boolean {
  return typeof (err as { status?: unknown } | null | undefined)?.status === "number"
    ? (err as { status: number }).status === 409
    : false;
}

/** 리포트 카드 제목. 하프 이름은 화면 세 곳(버튼 hint·리포트·로그)이 같은 말을 써야 한다. */
export function halfLabelOf(half: 1 | 2): string {
  return half === 1 ? "전반" : "후반";
}
