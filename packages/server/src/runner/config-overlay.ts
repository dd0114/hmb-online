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

/**
 * 한 하프가 넘어서면 안 되는 틱 수(#383 독립검증 M2).
 *
 * `matchMinutes` 는 수치 리프라 검증을 전부 통과하는데, 러너는 <b>단일 프로세스</b>다 —
 * `{"matchMinutes":100000}` 한 줄이 `/config/validate` 스모크와 이후 모든 `/simulate` 를 분 단위로
 * 붙잡아 <b>진행 중인 전 매치의 하프를 같이 세운다</b>(실측 8분+ 미완). 원장은 fail-closed 라
 * 안전하지만 가용성 사고는 그대로 난다. 오타 하나(`100`→`100000`)로 재현된다.
 *
 * 기본값(45분 · 1초 틱)의 하프는 1350틱이다. 20배를 상한으로 둔다 — 실험 여지는 남기고
 * "러너를 재우는 값"은 막는 자리.
 */
export const MAX_HALF_TICKS = 27_000;

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
 * 오버레이 적용. 실패는 {@link OverrideError}(호출부가 400 으로 매핑).
 *
 * <b>결과가 base 와 같으면 base 를 그대로 돌려준다</b>(동일 객체). 오버레이 없음/빈 맵/기본값과
 * 같은 값만 담긴 맵은 전부 "오늘과 한 비트도 다르지 않다"가 되어야 하고, 그걸 `===` 로 보장한다.
 *
 * <h4>이 함수는 재생 경로다 — 작성 게이트를 여기 두지 않는다 (독립검증 B2)</h4>
 *
 * `simulate()` 가 <b>매 하프</b> 부른다. 그 입력은 운영자가 방금 친 값이 아니라 <b>매치 생성
 * 시점에 박제된 오버레이</b>다. 그래서 여기서 던지는 규칙은 "지금 이 값을 쓰는 게 좋은가"가 아니라
 * <b>"이 값으로 경기를 돌릴 수 있는가"</b> 여야 한다 — 전자는 시간이 지나면 답이 바뀌고, 바뀐 답을
 * 과거 데이터에 소급하면 <b>이미 시작한 매치가 죽는다</b>.
 *
 * 그래서 여기 남는 것: 경로 실재·타입·유한성(값이 없으면 병합 자체가 불가) + {@link assertAffordable}
 * (런타임 비용 — 재생 경로에서도 진짜로 위험하다). 여기서 빠지는 것: <b>무효 노브 판정</b>
 * ({@link INERT_KNOBS}) — 그건 엔진 버전에 따라 변하는 잣대라 `validateOverrides`(작성 게이트)
 * 소관이다. 엔진이 노브를 LIVE→INERT 로 옮기는 것은 가정이 아니라 전례다(0.24.0 이 17개를 한 번에
 * 옮겼다). 그 판정을 여기 두면 그런 업그레이드 한 번이 ①그 오버레이가 박힌 진행 중 매치 전부와
 * ②원장의 현재 리비전이 그 키를 담고 있는 한 <b>이후 생성되는 모든 매치</b>를 h1 에서 죽인다.
 * 보호 가치는 0 이다 — 값이 무효라 경기는 어차피 동일하고, 신규 작성은 작성 게이트가 이미 막는다.
 */
export function applyOverrides(
  base: EngineConfig,
  overrides: EngineConfigOverrides | undefined,
): { config: EngineConfig; hash: string; changed: ChangedKnob[] } {
  const entries = Object.entries(overrides ?? {});
  if (entries.length === 0) {
    return { config: base, hash: effectiveConfigHash(base), changed: [] };
  }

  const knobs = knobPaths(base);
  const issues: string[] = [];
  const accepted: ChangedKnob[] = [];

  for (const [path, value] of entries) {
    const head = path.split(".")[0] ?? path;
    if (STRUCTURAL_KEYS.includes(head)) {
      issues.push(`${path}: 구조 경로라 오버레이할 수 없습니다(계수가 아닙니다)`);
      continue;
    }
    const knob = knobs.get(path);
    if (!knob) {
      // "없다"와 "있지만 못 만진다"를 구분한다(독립검증 M3): `chain.mode` 같은 문자열 리프에
      // "경로가 없습니다"라고 답하면 **거짓말**이고, 운영자는 오타를 찾아 소스를 뒤진다.
      issues.push(
        leafExists(base, path)
          ? `${path}: 존재하지만 오버레이 대상이 아닙니다(수·참거짓 리프만 가능 — 문자열/배열/구조는 배포로만 바꾼다)`
          : `${path}: EngineConfig 에 없는 경로입니다(오타입니다)`,
      );
      continue;
    }
    if (typeof value !== knob.type) {
      issues.push(`${path}: ${knob.type} 이어야 합니다(받은 값: ${typeof value})`);
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      issues.push(`${path}: 유한한 수여야 합니다(NaN·Infinity 금지)`);
      continue;
    }
    if (value !== knob.value) accepted.push({ path, from: knob.value, to: value });
  }

  if (issues.length > 0) throw new OverrideError(issues);
  if (accepted.length === 0) {
    return { config: base, hash: effectiveConfigHash(base), changed: [] };
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
  assertAffordable(config);
  return { config, hash: effectiveConfigHash(config), changed: accepted };
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

/**
 * 이 config 로 한 하프를 돌리는 비용이 상한 안인가(#383 독립검증 M2). 러너는 단일 프로세스라
 * 한 요청이 오래 돌면 <b>다른 매치의 하프가 전부 밀린다</b> — 값 하나가 가용성 사고가 되는 자리다.
 */
function assertAffordable(config: EngineConfig): void {
  const ticksPerHalf = Math.ceil((config.matchMinutes * 60_000) / config.msPerTick / 2);
  if (ticksPerHalf > MAX_HALF_TICKS) {
    throw new OverrideError([
      `matchMinutes=${config.matchMinutes}: 한 하프가 ${ticksPerHalf}틱이 되어 상한 ` +
        `${MAX_HALF_TICKS}틱을 넘습니다. 러너는 단일 프로세스라 이 값 하나가 진행 중인 다른 ` +
        `매치의 하프까지 세웁니다.`,
    ]);
  }
}
