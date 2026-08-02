/**
 * 로그줄 라벨 **한글 표기** (#406 요구 5-4 · hero 확정 ④ "라벨 한글화 채택").
 *
 * <h3>경계 — 코어는 데이터, 표기는 호스트</h3>
 * <p>규칙 SoT 는 `packages/viewer-core/src/log-lines.impl.mjs` 다(어떤 이벤트를 어떤 중요도로
 * 보일지). 그런데 그 코어는 <b>QA dev-viewer 와 공용</b>이고 dev-viewer 는 <b>전면 영어</b>(v3 β)라
 * `packages/engine/dev-viewer/e2e/{log,captions}.spec.ts` 가 영어 라벨에 걸려 있다.
 * ⇒ <b>`labelOf` 를 한글로 바꾸지 않는다.</b> 코어는 계속 데이터(`type` · 영어 라벨)를 주고,
 * <b>표기는 호스트(web)가 정한다</b>. 같은 코어를 두 호스트가 각자의 언어로 그리는 구조다.
 *
 * <h3>왜 `type` 이 아니라 라벨 문자열로 매칭하나</h3>
 * <p>`LogLine` 에 <b>`detail` 이 없다</b>(코어가 라벨로 이미 접어 넣었다 — `Shot · saved 🧤`).
 * detail 을 라인에 싣게 하려면 코어 계약을 바꿔야 하는데 그건 이 웨이브의 소유가 아니다.
 * 그래서 <b>1차 = 코어 라벨 전문 매칭</b>(세부 변종까지 정확히), <b>2차 = `type` 매핑</b>
 * (모르는 detail 이어도 한글은 나온다), <b>3차 = 코어 라벨 그대로</b>(모르는 타입).
 * <p>1차가 코어 문자열에 의존하는 대가는 계약이 갚는다 — `log-labels.test.ts` 가 엔진이 실제로
 * 내보내는 (type × detail) 조합을 `logLines` 에 통과시켜 <b>전부 한글로 나오는지</b> 확인한다.
 * 코어가 라벨을 바꾸면 그 계약이 먼저 깨진다(조용한 영어 회귀가 없다).
 */
import type { LogLine } from "@hmb/viewer-core";

/** 코어 라벨 전문 → 한글. 목업 §4 대응표(hero 게이트 통과본)를 그대로 옮긴 것. */
const BY_LABEL: Record<string, string> = {
  "⚽ GOAL": "⚽ 골!",
  "⚽ PENALTY awarded": "⚽ 페널티킥 선언!",
  "🟨 Yellow card": "🟨 경고",
  "🟥 Red card": "🟥 퇴장",
  "🔄 Substitution": "🔄 교체",
  "Kick-off": "킥오프",
  Corner: "코너킥",
  "Goal kick": "골킥",
  "Throw-in": "스로인",
  "Shot on goal": "슛",
  "Shot · saved 🧤": "슛 · 선방 🧤",
  "Shot · off target": "슛 · 빗나감",
  "1-on-1 chance!": "일대일 찬스!",
  "Penalty shot": "페널티킥 슈팅",
  "🧤 Save": "🧤 선방",
  Tackle: "태클",
  Interception: "가로챔",
  Foul: "파울",
  "🚩 Offside": "🚩 오프사이드",
  "Free kick": "프리킥",
  "Half-time": "전반 종료",
  "Full-time": "경기 종료",
};

/**
 * `MatchEventType` 전수 매핑(2차). 코어가 티커에 안 올리는 타입(`pass`·`clearance`)도 넣는다 —
 * 코어의 `SHOWN` 이 넓어지는 날 <b>그 타입만</b> 영어로 새는 것을 막는 백스톱이다.
 */
const BY_TYPE: Record<string, string> = {
  kickoff: "킥오프",
  pass: "패스",
  interception: "가로챔",
  tackle: "태클",
  clearance: "걷어내기",
  shot: "슛",
  goal: "⚽ 골!",
  save: "🧤 선방",
  foul: "파울",
  offside: "🚩 오프사이드",
  free_kick: "프리킥",
  penalty: "⚽ 페널티킥 선언!",
  card: "🟨 경고",
  substitution: "🔄 교체",
  half_whistle: "전반 종료",
  full_whistle: "경기 종료",
};

/** 프리킥 사유 — 엔진이 싣는 detail(`contest.ts` 파울 / `match.ts` 오프사이드). */
const FREE_KICK_REASON: Record<string, string> = {
  foul: "파울",
  offside: "오프사이드",
};

/** 코어가 만드는 `Free kick (…)` 변종 — 사유가 괄호 안에 들어간다. */
const FREE_KICK_RE = /^Free kick \((.+)\)$/;

/**
 * 로그줄 한글 라벨. 모르는 타입이면 코어 라벨(영어)로 떨어진다 — <b>빈 줄을 만들지 않는다</b>.
 */
export function koLogLabel(line: Pick<LogLine, "type" | "label">): string {
  const fk = FREE_KICK_RE.exec(line.label);
  if (fk) {
    const reason = fk[1]!;
    return `프리킥 (${FREE_KICK_REASON[reason] ?? reason})`;
  }
  return BY_LABEL[line.label] ?? BY_TYPE[line.type] ?? line.label;
}

/** 계약이 "전수 매핑"을 셀 수 있게 노출한다(값 자체를 복사해 쓰지 말 것 — 표기는 여기가 SoT). */
export const KO_LABEL_TYPES: readonly string[] = Object.keys(BY_TYPE);
