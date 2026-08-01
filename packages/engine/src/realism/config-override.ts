import type { EngineConfig } from "../config";

/**
 * EngineConfig 런타임 오버라이드 — 무리빌드 튜닝 하네스(#377 M0-1)의 config 주입 지점.
 *
 * 엔진은 이미 무상태다(`runMatch(seed, home, away, select, config)`). 그런데 지금까지 계수를
 * 만지려면 `config.ts` 를 **편집**해야 했고, 그러면 TS 컴파일 → vitest 재기동 → 전체 로드가
 * 매번 따라왔다(#377 §3-1). 이 모듈은 그 왕복을 없앤다 — 엔진을 1회 로드해 두고 `defaultEngineConfig`
 * 위에 **데이터로** 계수를 얹는다.
 *
 * ## `pointConfig`(harness.ts) 와의 관계
 * `pointConfig` 는 **스윕 전용**이다 — 값이 `number` 뿐이고 `"label"` 키를 스펙 메타로 흘려보낸다.
 * 여기는 hero 가 손으로 쓰는 입력이라 ①문자열·불리언·중첩 객체를 받고 ②**모르는 경로를 던진다**.
 * 두 번째가 핵심이다: 오타가 조용한 no-op 이 되면 "노브를 돌렸는데 경기가 그대로다" 를
 * "그 노브는 레버가 아니다" 로 오독한다(#338 이 정확히 그 부류의 사고였다).
 *
 * 결정론 계약은 그대로다 — 주입된 config 도 재현 3종세트의 일부이고(`seed + selectData +
 * inputLog + EngineConfig`), 같은 오버라이드는 항상 같은 경기를 만든다.
 */

/** 오버라이드 맵. 키는 **점 경로**(`"chain.goalValue"`) 또는 **중첩 부분객체**(`{chain:{goalValue:9}}`). 둘 섞어 써도 된다. */
export type ConfigOverrides = Record<string, unknown>;

/** 잘못된 경로/타입을 만나면 던진다 — 조용한 no-op 금지(위 주석 참조). */
export class ConfigOverrideError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** config 는 순수 데이터라 JSON 왕복이 안전한 깊은 복사다(엔진 계약: 함수·클래스 없음). */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * 한 경로에 값을 쓴다. 존재하지 않는 경로거나 리프 타입이 바뀌면 던진다.
 * `path` 는 이미 분해된 세그먼트 배열, `where` 는 오류 메시지용 원본 표기.
 */
function setPath(target: Record<string, unknown>, path: string[], value: unknown, where: string): void {
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (!(seg in cur)) {
      throw new ConfigOverrideError(`알 수 없는 config 경로: "${where}" (구간 "${seg}" 없음)`);
    }
    const next = cur[seg];
    if (!isPlainObject(next)) {
      throw new ConfigOverrideError(`config 경로 "${where}" 의 "${seg}" 는 객체가 아니다(${typeName(next)})`);
    }
    cur = next;
  }
  const leaf = path[path.length - 1]!;
  if (!(leaf in cur)) {
    throw new ConfigOverrideError(`알 수 없는 config 경로: "${where}"`);
  }
  const before = cur[leaf];
  // 타입 변화는 거의 항상 오타다(숫자 노브에 문자열 등). 단 undefined 였던 optional 은 허용.
  if (before !== undefined && typeName(before) !== typeName(value)) {
    throw new ConfigOverrideError(
      `config 경로 "${where}" 의 타입이 바뀐다: ${typeName(before)} → ${typeName(value)}`,
    );
  }
  cur[leaf] = value;
}

/** 중첩 부분객체를 재귀로 병합한다(리프에서 setPath 와 같은 검증을 받는다). */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>, prefix: string): void {
  for (const [key, value] of Object.entries(patch)) {
    const where = prefix ? `${prefix}.${key}` : key;
    if (key.includes(".")) {
      // 중첩 안에서도 점 경로를 허용한다(`{contest:{"shot.x":1}}` 같은 혼용).
      setPath(target, `${where}`.split("."), value, where);
      continue;
    }
    if (isPlainObject(value)) {
      if (!(key in target)) throw new ConfigOverrideError(`알 수 없는 config 경로: "${where}"`);
      const next = target[key];
      if (!isPlainObject(next)) {
        throw new ConfigOverrideError(`config 경로 "${where}" 는 객체가 아니다(${typeName(next)})`);
      }
      mergeInto(next, value, where);
      continue;
    }
    setPath(target, [key], value, where);
  }
}

/**
 * `base` 에 오버라이드를 얹은 **새 EngineConfig** 를 만든다(`base` 무변경).
 * 빈 오버라이드면 base 의 깊은 복사 = 동작 동일(하네스의 "기준선" 실행 경로).
 */
export function applyConfigOverrides(base: EngineConfig, overrides: ConfigOverrides): EngineConfig {
  const out = deepClone(base) as unknown as Record<string, unknown>;
  mergeInto(out, overrides, "");
  return out as unknown as EngineConfig;
}

/** 리프 하나의 서술 — UI 가 노브 목록·자동완성을 그리는 재료. */
export interface ConfigLeaf {
  path: string;
  value: number | string | boolean;
  type: "number" | "string" | "boolean";
}

/**
 * config 의 모든 스칼라 리프를 점 경로로 편다. 배열(`formations` 좌표 등)은 **내려가지 않는다** —
 * 하네스가 만지는 것은 계수이고, 포메이션 좌표는 여기서 편집할 물건이 아니다.
 */
export function listConfigLeaves(base: EngineConfig): ConfigLeaf[] {
  const out: ConfigLeaf[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(value)) {
        walk(value, path);
      } else if (typeof value === "number") {
        out.push({ path, value, type: "number" });
      } else if (typeof value === "string") {
        out.push({ path, value, type: "string" });
      } else if (typeof value === "boolean") {
        out.push({ path, value, type: "boolean" });
      }
      // 배열·undefined 는 건너뛴다.
    }
  };
  walk(base as unknown as Record<string, unknown>, "");
  return out;
}

/**
 * hero 가 실제로 돌리는 레버 — #377 §1-3 · 트랙 T 1차 임무에서 이름이 오른 것들.
 * 목록은 **편의**일 뿐 제한이 아니다(어떤 경로든 자유 입력 가능). 순서 = 화면 표시 순서.
 */
export const TUNING_KNOBS: { path: string; label: string; note?: string }[] = [
  { path: "chain.goalValue", label: "골 가치(사슬 EV)", note: "볼륨 최상위 레버. 0.26.0 재보정에서 9.4 확정" },
  { path: "contest.shootXgThreshold", label: "슛 xG 임계", note: "⚠️ 절대 xG 컷 — 덱마다 분포가 달라 #370 붕괴의 직접 원인" },
  { path: "contest.xgBase", label: "xG 기준값" },
  { path: "contest.shootRange", label: "슛 사거리(m)" },
  { path: "contest.onTargetBase", label: "유효슛 기준확률" },
  { path: "decisionWeights.shoot", label: "슛 가중치", note: "⚠️ chain 코어에서는 무효(#338) — goalValue 가 레버" },
  { path: "rules.foul.base", label: "파울 기준확률" },
  { path: "rules.card.yellowProb", label: "옐로 확률" },
  { path: "contest.passBase", label: "패스 기준 성공률" },
  { path: "longPass.minM", label: "롱패스 최소거리(m)" },
  { path: "movement.markGap", label: "마크 스탠드오프(m)" },
  { path: "vision.attentionBase", label: "정밀추적 인원" },
];
