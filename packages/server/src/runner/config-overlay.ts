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
      issues.push(`${path}: EngineConfig 에 없는 경로입니다(오타이거나 오버레이 대상이 아닌 리프)`);
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
  return { config, hash: effectiveConfigHash(config), changed: accepted };
}
