/**
 * **"왜 이 후보가 나왔나" 한 줄** (#405, 목업 화면 ③).
 *
 * 서버는 `{kind, detail}` **구조만** 내리고 문장을 만들지 않는다 — 문안이 서버에 박히면 문구
 * 하나 바꾸는 데 배포가 필요해진다(#232 재화 표기와 같은 이유). 그래서 표시명 매핑은 여기 있다.
 *
 * ── 규율 ────────────────────────────────────────────────────────────────────────────────
 * · **모르면 줄을 생략한다.** `type`/`param`/`result` 는 서버 enum 이고 서버가 언제든 늘릴 수
 *   있다(`GrowthTuning.EVENT_TYPES` 는 "일부는 가중 0 이지만 열거는 전수"). 매핑에 없는 값이
 *   왔을 때 "이 경기 interception 1회" 같은 raw 를 흘리거나 그럴듯한 말을 지어내면, 그 줄은
 *   **틀린 근거**가 된다. 근거 줄의 값어치는 정확성뿐이라 모르면 안 그리는 게 맞다.
 * · `BASE`(어느 축도 기여 안 함) · `reason == null`(W2b 초판 행) 도 같은 이유로 생략.
 * · 순수 함수다 — 화면은 결과 문자열만 그린다(테스트가 여기에 붙는다).
 */
import type { ChoiceReason } from "../api/growth";

/**
 * 이벤트 종류 → 사람 말. `GrowthTuning.EVENT_TYPES` 전수 중 **의미가 읽히는 것만** 담는다.
 * `kickoff`·`half_whistle`·`full_whistle` 은 선수의 활약이 아니라 진행 신호라 일부러 뺐다 —
 * 그게 최다 기여로 뽑히는 상황이면 그건 근거로 말할 것이 없는 상태다.
 */
export const EVENT_REASON_LABELS: Record<string, string> = {
  pass: "패스",
  interception: "가로채기",
  tackle: "태클",
  clearance: "걷어내기",
  shot: "슛",
  goal: "골",
  save: "선방",
  foul: "파울",
  offside: "오프사이드",
  free_kick: "프리킥",
  penalty: "페널티킥",
  card: "카드",
  substitution: "교체",
};

/**
 * behavior 파라미터 → **그 지시가 무슨 말이었나**. AI 가 프롬프트를 변환해 놓은 9개 파라미터가
 * 후보 가중의 입력이므로(설계 §2.5 — 키워드 매칭이 아니다), 유저에게는 "내가 시킨 것"으로 읽혀야
 * 한다. 그래서 파라미터 이름이 아니라 **지시문 투**로 옮긴다.
 */
export const BEHAVIOR_REASON_LABELS: Record<string, string> = {
  shootTendency: "적극적으로 슛",
  passRisk: "과감한 패스",
  passDirectness: "전진 패스 위주",
  dribbleTendency: "직접 몰고 들어가",
  pressAggression: "강하게 압박",
  forwardRunFreq: "적극적으로 침투",
  widthTendency: "넓게 벌려",
  supportDepth: "뒤를 받쳐",
  positioningFreedom: "자유롭게 움직여",
};

export const RESULT_REASON_LABELS: Record<string, string> = {
  WIN: "승리 보너스",
  DRAW: "무승부 보너스",
  LOSS: "패배 보너스",
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

/**
 * 후보 근거 → 화면 한 줄. **못 만들면 `null`**(호출부는 줄을 그리지 않는다).
 *
 * @example reasonTextOf({kind:"EVENT", detail:{type:"shot", count:4}})  // "이 경기 슛 4회"
 * @example reasonTextOf({kind:"BEHAVIOR", detail:{param:"shootTendency"}}) // '지시 "적극적으로 슛"'
 * @example reasonTextOf({kind:"BASE", detail:{}})                       // null
 */
export function reasonTextOf(reason: ChoiceReason | null | undefined): string | null {
  if (!reason || typeof reason !== "object") return null;
  const detail = (reason.detail ?? {}) as Record<string, unknown>;
  switch (reason.kind) {
    case "EVENT": {
      const label = EVENT_REASON_LABELS[str(detail.type) ?? ""];
      const count = posInt(detail.count);
      // 횟수를 모르면 "이 경기 슛" 으로 흘리지 않는다 — 근거의 무게가 횟수에 있다.
      return label && count != null ? `이 경기 ${label} ${count}회` : null;
    }
    case "BEHAVIOR": {
      const label = BEHAVIOR_REASON_LABELS[str(detail.param) ?? ""];
      return label ? `지시 "${label}"` : null;
    }
    case "POSITION": {
      const position = str(detail.position);
      return position ? `포지션 ${position} 핵심` : null;
    }
    case "RESULT": {
      const label = RESULT_REASON_LABELS[str(detail.result) ?? ""];
      return label ?? null;
    }
    case "LEGACY":
      return "이관 보상";
    // BASE = 균등 바닥만으로 뽑혔다 = 말할 근거가 없다. 모르는 kind 도 같다.
    default:
      return null;
  }
}
