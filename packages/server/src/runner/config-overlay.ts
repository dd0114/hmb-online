import { createHash } from "node:crypto";
import type { EngineConfig } from "@hmb/engine";
import type { EngineConfigOverrides } from "@hmb/shared";

/**
 * 계수 오버레이 (#383) — `EngineConfig` 의 수치/불리언 리프를 **런타임 입력**으로 덮어쓴다.
 * 설계 SoT = `docs/plan-v5/live-engine-config.md`.
 *
 * <b>엔진은 건드리지 않는다</b>(`packages/engine/**` = QA #25 도메인). 엔진은 이미
 * `simulate(req, config)` 로 config 를 통째로 받으므로, 여기서 만든 config 를 넘기면 끝이다.
 *
 * <b>왜 평평한 점경로 맵인가</b> — 중첩 deep-merge 였다면
 * `{"contest":{"shootXgThreshhold":0.07}}` 같은 **오타가 성공(200)하고 아무 일도 안 일어난다**.
 * "필드가 계약에 있다 ≠ 엔진이 읽는다"는 이 리포가 세 번 빠진 함정이다(#321·#337·#338, 그리고
 * #377 트랙 D 의 blocker 5건 중 3건). 평평한 경로는 기본 config 의 리프 전수와 **집합 대조**가
 * 되므로 미지 경로가 곧 400 이다. 덤으로 객체 통째 교체 사고(형제 노브 40개 증발)가 원천 봉쇄되고,
 * 키 정렬만으로 정본 직렬화·안정 해시가 나온다.
 */

/**
 * 오버레이가 **닿을 수 없는** 최상위 키 — 계수가 아니라 <b>구조</b>다.
 *
 * 좌표계(`fixedScale`·`coordMode`·`pitch`)·틱 해상도·포메이션 기하는 골든·직렬화·IFAB 유래 계약의
 * 전제이고, 바로 그 축을 지키라고 `config.version` 이 있다. 오버레이가 여기를 만지면 "버전은 같은데
 * 구조가 다른 매치"가 생겨 <b>버전 가드가 거짓말이 된다</b>(그 순간 이 기능은 #241 을 재현한다).
 */
export const STRUCTURAL_KEYS: readonly string[] = [
  "version",
  // ⚠️ `matchMinutes` 는 계수처럼 보이지만 **거부한다**(main 확정, W0 부록 2항). 이유는 이 값이
  // 오버레이 중 유일하게 **런타임 비용**을 정하기 때문이다 — 러너는 단일 프로세스라
  // `{"matchMinutes":100000}` 한 줄이 이후 모든 `/simulate` 를 붙잡아 **진행 중인 전 매치의
  // 하프를 같이 세운다**(실측 8분+ 미완). 틱 상한으로 막아 봤지만 그 상한 자체가
  // `msPerTick`(구조값, 배포에서 온다)에 달려 있어 **어제 통과한 값이 오늘 무효가 되는** 축을
  // 새로 만들었다(독립검증 M-A). 노브 하나를 포기해 그 축을 통째로 없애는 쪽이 싸다 —
  // 경기 길이를 무배포로 실험할 일은 없고, 계수 튜닝이라는 이 기능의 목적과도 무관하다.
  "matchMinutes",
  "msPerTick",
  "fixedScale",
  "coordMode",
  "gridSize",
  "pitch",
  "formations",
];

/**
 * **무효 노브**(#338 레지스트리, engine `realism/dead-knobs.test.ts` 의 `INERT`).
 *
 * 0.24.0 이 볼 소유자 결정 코어를 사슬로 바꾸면서 이 값들은 <b>실행 경로를 잃었다</b> — 지우지 않은
 * 이유는 롤백 스위치(`chain.mode="weighted"`)의 자산이기 때문이고, 엔진은 "값을 바꿔도 경기가
 * bit-identical" 임을 계약으로 박제해 두고 있다.
 *
 * <b>작성 시점에 거부하지 않으면 이 기능이 정확히 #338 을 다시 만든다</b>: 운영자는 200 ·
 * `changed` diff · 새 지문 · 원장 리비전까지 <b>"적용됐다"는 신호를 넷</b>이나 받는데 경기는 한
 * 비트도 안 바뀐다. 죽은 노브를 못 잡는 것이 이 웨이브가 인용한 사고(#321·#337·#338) 그 자체다.
 *
 * ⚠️ <b>그러나 이 판정은 {@link applyOverrides}(=재생 경로)에 두지 않는다</b> — 소비처는
 * `config-validate.ts:validateOverrides` <b>하나뿐</b>이다. 이유는 {@link applyOverrides} 의
 * 주석에 적었다. 요약: 무효 판정은 <b>엔진 버전에 따라 변하는 값</b>이고, 재생은 <b>과거에 박힌
 * 오버레이</b>를 돌린다. 변하는 잣대를 과거 데이터에 소급 적용하면 엔진 업그레이드 한 번이
 * 진행 중인 매치를 전부 FAILED 로 민다(#241 의 정확한 형태).
 *
 * ⚠️ 이 목록은 엔진 레지스트리의 <b>복사본</b>이다(엔진은 QA #25 도메인이라 여기서 수정하지 않는다).
 * 드리프트는 `config-overlay.test.ts` 가 엔진 레지스트리를 <b>직접 읽어</b> 집합 대조로 막는다 —
 * 엔진이 노브를 살리거나 죽이면 그 테스트가 이름을 짚어 깨진다.
 *
 * ⚠️ 이 목록은 <b>무효의 전수가 아니다</b> — 엔진 레지스트리에 등재된 것만이다. 등재 밖에도
 * 실효 없는 노브가 더 있다(#383 독립검증 M5 → **#393**). 여기서 자체 판정하지 않는 이유는
 * "무효"의 SoT 가 엔진이기 때문이다 — 러너가 흉내내면 두 진실이 조용히 갈라진다.
 */
export const INERT_KNOBS: readonly string[] = [
  "decisionWeights.shoot",
  "decisionWeights.pass",
  "decisionWeights.dribble",
  "decisionWeights.hold",
  "decisionWeights.clearance",
  "decisionWeights.shootInBox",
  "decisionWeights.shootCentralBonus",
  "decisionWeights.backwardPassPenalty",
  "contest.centralShootHalfM",
  "contest.oneOnOneShootBias",
  "softCap",
  "variety.decisionTemperature",
  "variety.dribbleChainProb",
  "variety.dribbleChainBonus",
  "clearance.passScoreCeil",
  "clearance.boxWeightMult",
  "ball.shotSpeed",
];

export type KnobType = "number" | "boolean";
export interface Knob {
  value: number | boolean;
  type: KnobType;
}
export interface ChangedKnob {
  path: string;
  from: number | boolean;
  to: number | boolean;
}

/**
 * <b>재생에서 적용하지 못하고 버린 경로</b>(#383 독립검증 B3). 작성 시점엔 유효했는데 그 뒤
 * 엔진이 노브를 지우거나 타입을 바꾸면 여기 담긴다 — 버리되 <b>버렸다는 사실이 남는다</b>.
 */
export interface DroppedKnob {
  path: string;
  reason: string;
}

/** 검증 실패 — 여러 문제를 **한 번에** 들고 있다(운영자는 curl 로 쓴다. 왕복을 줄인다). */
export class OverrideError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid configOverrides: ${issues.join("; ")}`);
    this.name = "OverrideError";
    this.issues = issues;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 오버레이 가능한 리프 전수 → `{점경로: {value, type}}`.
 *
 * 규칙 셋: ①구조 최상위 키는 **애초에 걸어 들어가지 않는다**(거부 이전에 목록에 없다)
 * ②문자열·배열은 리프로 치지 않는다 ③`undefined`(미설정 optional)는 타입을 알 수 없으므로 뺀다 —
 * 기본 config 에 나타나지 않는 경로는 "엔진이 읽는다"는 근거가 없다.
 */
export function knobPaths(config: EngineConfig): Map<string, Knob> {
  const out = new Map<string, Knob>();
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!prefix && STRUCTURAL_KEYS.includes(key)) continue;
      if (typeof value === "number") {
        out.set(path, { value, type: "number" });
      } else if (typeof value === "boolean") {
        out.set(path, { value, type: "boolean" });
      } else if (isPlainObject(value)) {
        walk(value, path);
      }
      // string·array·undefined 는 오버레이 대상이 아니다.
    }
  };
  walk(config as unknown as Record<string, unknown>, "");
  return out;
}

/** 키를 정렬한 정본 JSON — 해시가 키 순서에 흔들리지 않게 하는 유일한 조각. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * <b>유효 config 전체</b>의 지문(sha256 앞 16자). 오버레이가 아니라 병합 결과를 해싱하는 이유는,
 * 러너 이미지가 바뀌어(=기본값이 바뀌어) 같은 오버레이가 다른 경기를 만들 때 값이 달라져야 하기
 * 때문이다. 오버레이만 해싱하면 그 사고가 지문에 안 잡힌다.
 */
export function effectiveConfigHash(config: EngineConfig): string {
  return createHash("sha256").update(canonical(config)).digest("hex").slice(0, 16);
}

/**
 * <b>오버레이 자체</b>의 지문 — 재개 가드가 비교하는 값이다(#383 독립검증 B4).
 *
 * ⚠️ 여기서 {@link effectiveConfigHash}(=병합된 config 전체)를 쓰면 안 된다. 그건 <b>러너 이미지가
 * 바뀌기만 해도</b> 달라지므로, 기본값이 한 글자 달라진 재배포가 <b>오버레이를 한 번도 쓴 적 없는</b>
 * 진행 중 매치의 h2 를 전부 죽인다 — 이 웨이브가 "아무도 안 쓰면 no-op"이라고 선언한 바로 그
 * 지점에서 전 유저를 때리는 실패 모드다(초판이 실제로 그랬다).
 *
 * 게다가 그 민감도는 <b>과하다</b>: 무효 노브(#338) 하나를 지우는 배포는 경기가 bit-identical 이라
 * `config.version` 을 올릴 이유가 없는데 유효 config 지문은 달라진다. 경기가 같은 변화에 매치가
 * 죽으면 그건 가드가 아니라 결함이다.
 *
 * 가드가 실제로 물어야 하는 것은 <b>"h2 가 h1 과 같은 오버레이를 받았는가"</b> 하나다 —
 * 그건 서버가 매치별로 통제하는 값이고, 엔진 배포와 무관하다. 러너 기본값이 진짜로 경기를 바꾸는
 * 변화는 `config.version` 범프가 잡는다(그 축이 `configVersion` 대조로 이미 있다).
 */
export function overlayFingerprint(overrides: EngineConfigOverrides | undefined): string {
  const entries = Object.entries(overrides ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash("sha256").update(canonical(Object.fromEntries(entries))).digest("hex").slice(0, 16);
}

/** 한 경로를 판정한 결과 — 적용 / 무변화 / 적용 불가(사유). */
type Verdict =
  | { kind: "apply"; knob: ChangedKnob }
  | { kind: "noop" }
  | { kind: "reject"; reason: string };

/** 경로/타입/구조 판정 — 작성과 재생이 <b>같은 규칙</b>을 쓰고 처분만 달리한다. */
function judge(base: EngineConfig, knobs: Map<string, Knob>, path: string, value: number | boolean): Verdict {
  const head = path.split(".")[0] ?? path;
  if (STRUCTURAL_KEYS.includes(head)) {
    return { kind: "reject", reason: "구조 경로라 오버레이할 수 없습니다(계수가 아닙니다)" };
  }
  const knob = knobs.get(path);
  if (!knob) {
    // "없다"와 "있지만 못 만진다"를 구분한다(독립검증 M3): `chain.mode` 같은 문자열 리프에
    // "경로가 없습니다"라고 답하면 **거짓말**이고, 운영자는 오타를 찾아 소스를 뒤진다.
    return {
      kind: "reject",
      reason: leafExists(base, path)
        ? "존재하지만 오버레이 대상이 아닙니다(수·참거짓 리프만 가능 — 문자열/배열/구조는 배포로만 바꾼다)"
        : "EngineConfig 에 없는 경로입니다(오타이거나, 이 엔진 버전에서 삭제·개명된 노브입니다)",
    };
  }
  if (typeof value !== knob.type) {
    return { kind: "reject", reason: `${knob.type} 이어야 합니다(받은 값: ${typeof value})` };
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { kind: "reject", reason: "유한한 수여야 합니다(NaN·Infinity 금지)" };
  }
  return value === knob.value ? { kind: "noop" } : { kind: "apply", knob: { path, from: knob.value, to: value } };
}

/**
 * <b>작성 게이트</b> — 새 오버레이를 원장에 쓰기 전에 전수 검사한다. 하나라도 걸리면
 * {@link OverrideError}(400). 무효 노브(#338)까지 여기서 본다({@link inertIssues}).
 *
 * 이름을 {@link applyOverrides} 와 갈라 둔 이유는 두 라운드 연속으로 <b>이 판정이 재생 경로에
 * 섞였기 때문</b>이다(B2·B3). 함수가 하나면 "여기 검사 하나 더 넣자"가 자연스러워 보이고, 그
 * 한 줄이 진행 중 매치를 죽인다. 이제 그러려면 <b>이름이 authoring 인 함수</b>를 골라야 한다.
 */
export function assertAuthorable(base: EngineConfig, overrides: EngineConfigOverrides | undefined): void {
  const issues = inertIssues(overrides);
  const knobs = knobPaths(base);
  for (const [path, value] of Object.entries(overrides ?? {})) {
    // ⚠️ 무효 노브라고 여기서 `continue` 하지 않는다(독립검증 6차 m-C). 그러면 무효 **이면서**
    // 타입도 틀린 값이 무효 사유만 돌려받고, 운영자는 그걸 고쳐 다시 보낸 뒤에야 타입 오류를
    // 만난다 — 이 파일이 선언한 "여러 문제를 **한 번에** 돌려준다(운영자는 curl 로 쓴다.
    // 왕복을 줄인다)"와 어긋난다. 정상 타입의 무효 노브는 `judge` 가 apply/noop 을 돌려주므로
    // 중복 사유가 붙지 않는다.
    const v = judge(base, knobs, path, value);
    if (v.kind === "reject") issues.push(`${path}: ${v.reason}`);
  }
  if (issues.length > 0) throw new OverrideError(issues);
}

/**
 * <b>재생 경로</b> — 매치에 <b>이미 박힌</b> 오버레이를 그 매치의 config 로 병합한다.
 *
 * <b>결과가 base 와 같으면 base 를 그대로 돌려준다</b>(동일 객체). 오버레이 없음/빈 맵/기본값과
 * 같은 값만 담긴 맵은 전부 "오늘과 한 비트도 다르지 않다"가 되어야 하고, 그걸 `===` 로 보장한다.
 *
 * <h4>여기서는 <b>거절하지 않고 버린다</b> (독립검증 B2 · B3)</h4>
 *
 * `simulate()` 가 <b>매 하프</b> 부르고, 입력은 운영자가 방금 친 값이 아니라 <b>매치 생성 시점에
 * 박제된 오버레이</b>다. 그래서 여기서 던지는 규칙은 "지금 이 값을 쓰는 게 좋은가"가 아니라
 * <b>"이 요청이 서버를 위험하게 하는가"</b> 여야 한다 — 전자는 <b>시간이 지나면 답이 바뀌고</b>,
 * 바뀐 답을 과거 데이터에 소급하면 이미 시작한 매치가 죽는다.
 *
 * 두 라운드가 같은 실수를 서로 다른 판정으로 반복했다:
 * <ul>
 *   <li><b>B2</b> — 무효 노브(#338). 엔진이 노브를 LIVE→INERT 로 옮기면(0.24.0 이 17개를 한 번에)
 *       그 오버레이가 박힌 매치가 전부 죽는다.</li>
 *   <li><b>B3</b> — <b>경로 실재</b>. 엔진이 노브를 <b>지우면</b>(0.26.0 이 `ball.settleSpeed` 를
 *       지웠다) 같은 일이 난다. 게다가 이쪽이 더 나쁘다 — 원장의 현재 리비전이 그 키를 든 채라
 *       {@code pinForNewMatch()} 가 계속 박고, <b>이후 생성되는 모든 매치</b>가 h1 에서 죽는다.
 *       자동 복구 경로가 없어 운영자가 유저 신고로 알아채야 끝난다.</li>
 * </ul>
 *
 * 노브 삭제·개명은 사고가 아니라 <b>엔진 열차의 정상 활동</b>이다(그래서 엔진에 죽은-노브 스냅샷
 * 게이트가 있다). 정상 활동이 게임 루프를 멈춰서는 안 된다. 그래서 적용 못 하는 경로는
 * <b>버리고 {@link DroppedKnob} 로 보고</b>한다 — 조용히 버리는 게 아니다: 러너 응답과 하프 번들에
 * 남고 서버가 WARN 을 찍는다. 유효 config 지문은 <b>실제로 돈 config</b>를 가리키므로 재현 계약도
 * 그대로다.
 *
 * <b>이 함수는 한 줄도 던지지 않는다.</b> 마지막까지 남아 있던 런타임 비용 상한은 <b>노브 자체를
 * 포기해</b> 없앴다(main 확정, W0 부록 2항) — `matchMinutes` 가 {@link STRUCTURAL_KEYS} 로 올라가
 * 여기서는 다른 구조 경로와 똑같이 <b>버려진다</b>. 상한을 재생에 두면 그 상한이 `msPerTick`
 * (구조값, 배포에서 온다)에 달려 있어 <b>어제 통과한 값이 오늘 무효가 되는</b> 축이 생겼고
 * (독립검증 M-A), 상한을 재생에서 버리는 것으로 고치면 코드와 계약이 그만큼 남는다.
 * 노브 하나를 포기하는 쪽이 싸다 — 경기 길이를 무배포로 실험할 일은 없다.
 *
 * ⚠️ 여기에 throw 를 다시 넣고 싶어질 때 읽을 것: B2·B3·M-A 는 <b>전부 같은 실수</b>였고 그때마다
 * "이건 다르다"는 그럴듯한 근거가 있었다. 던져도 되는 유일한 조건은 <b>그 판정의 답이 배포로
 * 바뀌지 않는 것</b>이고, 세 번 다 그 조건을 확인하지 않고 그렇다고 믿었다.
 */
export function applyOverrides(
  base: EngineConfig,
  overrides: EngineConfigOverrides | undefined,
): { config: EngineConfig; hash: string; changed: ChangedKnob[]; dropped: DroppedKnob[] } {
  const entries = Object.entries(overrides ?? {});
  if (entries.length === 0) {
    return { config: base, hash: effectiveConfigHash(base), changed: [], dropped: [] };
  }

  const knobs = knobPaths(base);
  const dropped: DroppedKnob[] = [];
  const accepted: ChangedKnob[] = [];

  for (const [path, value] of entries) {
    const v = judge(base, knobs, path, value);
    if (v.kind === "reject") dropped.push({ path, reason: v.reason });
    else if (v.kind === "apply") accepted.push(v.knob);
  }

  dropped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (accepted.length === 0) {
    return { config: base, hash: effectiveConfigHash(base), changed: [], dropped };
  }

  const config = structuredClone(base);
  for (const { path, to } of accepted) {
    const parts = path.split(".");
    let node = config as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
    node[parts[parts.length - 1] as string] = to;
  }
  // 경로 순서를 정렬해 두면 감사 원장·diff 가 요청 키 순서에 흔들리지 않는다.
  accepted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { config, hash: effectiveConfigHash(config), changed: accepted, dropped };
}

/**
 * 경로가 config 에 실재하는가(타입 무관) — 에러 메시지를 정직하게 만들기 위한 조회.
 *
 * `in` 이 아니라 `hasOwnProperty` 인 이유(독립검증 m6): `in` 은 프로토타입 체인을 본다. 그래서
 * `contest.constructor` · `toString` 같은 경로가 "실재한다"로 판정돼, 오타를 오타라고 못 부르고
 * "존재하지만 오버레이 대상이 아닙니다"라는 <b>틀린 안내</b>를 하게 된다(운영자는 소스를 뒤진다).
 */
function leafExists(base: EngineConfig, path: string): boolean {
  let node: unknown = base;
  for (const part of path.split(".")) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, part)) return false;
    node = node[part];
  }
  return node !== undefined;
}

/**
 * <b>작성 게이트 전용</b> — 오버레이에 무효 노브(#338)가 있으면 사유 목록을 돌려준다(없으면 빈 배열).
 *
 * {@link applyOverrides} 가 아니라 여기 따로 있는 이유는 위 주석(B2)에 있다: 이 판정은
 * <b>새 값을 받을 때만</b> 유효하고, 재생에 적용하면 엔진 업그레이드가 진행 중 매치를 죽인다.
 * 그래서 <b>순수 함수로 분리</b>해 두고 `validateOverrides` 한 곳에서만 부른다 — 재생 경로가
 * 실수로 이걸 다시 부르면 그건 코드 리뷰에서 보이는 한 줄이 된다.
 */
export function inertIssues(overrides: EngineConfigOverrides | undefined): string[] {
  return Object.keys(overrides ?? {})
    .filter((path) => INERT_KNOBS.includes(path))
    .sort()
    .map(
      (path) =>
        `${path}: 지금 엔진(사슬 기본)에서 **실행 경로가 없는 노브**입니다 — 값을 바꿔도 경기가 ` +
        `비트 단위로 동일합니다(#338 레지스트리). 롤백 스위치의 자산이라 남아 있을 뿐입니다.`,
    );
}
