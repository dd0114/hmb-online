/**
 * gen-chars.ts — 선수 ↔ 아트 매핑 결정론 생성기 (#145 B안 → **#207 U-D5~U-D9 로 개편**).
 *
 * 실행: `npx tsx data/players/gen-chars.ts` → `player-chars.v2.json` 재생성(재실행 바이트 동일).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 왜 v2 인가 — **매핑값이 두 축에 걸쳤다**
 *
 * v1 은 `players[playerId] = charId`(문자열 평면)라 축이 하나뿐이라는 전제가 형에 박혀 있었다.
 * #207 W3-B 가 `design/characters/dist/units/`(hero 입고 실아트)를 **별도 축**으로 발행하면서
 * 같은 맵 안에 `characters` 축 charId 와 `units` 축 unitId 가 섞이게 됐다. 문자열만으로는
 * 소비자가 어느 manifest 를 봐야 하는지 알 수 없다 → **항목마다 축 태그**를 단다:
 *
 *      players[playerId] = { axis: "characters" | "units", id }
 *
 * ▸ **v1 소비자가 오독하지 않는 근거**(형이 문자열 → 객체로 바뀌는 fail-safe, W3-B 와 동일 논리):
 *   - `charIdFor` 계열은 전부 `typeof x === "string"` 로 좁힌다 → 객체는 **null** 이 되어
 *     플레이스홀더 축(또는 CSS 이니셜)으로 조용히 떨어진다. 틀린 얼굴을 그리는 경로가 없다.
 *   - `buildViewerSkins` 는 charId 를 manifest 키로 쓰는데, 키 조회 가드가 `typeof key !== "string"`
 *     이면 undefined 를 돌려준다 → 그 선수만 빠지고, 전원이 빠지면 payload 자체가 null 이라
 *     뷰어는 **현행 단색 원**으로 그린다(무회귀 경로).
 *   즉 구 소비자에게 v2 는 "매핑이 없는 것"과 같다 — **깨진 그림 대신 폴백**이다.
 *   이 성질은 `chars-map.test.ts` 의 "v1 소비자 오독 방지" 블록이 실제 v1 리더를 재현해 박제한다.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 배정 규칙 (#207 U-D5 · U-D8 · U-D9, 입력 = players.v2.4.json — #256 채번 2종 포함)
 *
 *   활성 LEGEND 5종     → `units` 축 **1:1 고유 실아트**   (P173/P175/P176/P177/P179)
 *   비활성 LEGEND 17종  → **현행 유지** — 구 14종은 `characters` 1:1, 아트 미입고 3종은 **미매핑**
 *                         (미매핑 = web CharAvatar 이니셜 폴백. 아트 입고 시 여기 표만 늘린다.)
 *   DIA 25명            → `characters` 축 포지션 풀(U-D9 — 현행 유지)
 *   GOLD/SILVER/BRONZE  → `units` 축 **`default-unit` 공용**(U-D8)
 *
 * 희소성 사다리: LEGEND 고유아트 > DIA 풀캐릭터 > GOLD 이하 디폴트 유닛.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 왜 별도 발행 파일인가(players.v2.x 에 안 넣는 이유):
 *   data/CLAUDE.md — "산출물은 버전 파일로만 발행, **발행 후 수정 금지**". 매핑은 players 와 축이
 *   다르고(선수 신규발행 없이 아트만 바뀔 수 있다) hero 가 손으로 갈아끼울 수 있어야 하므로
 *   **독립 축의 발행물**로 낸다. 소비자는 playerId 로 조인한다. v1 은 그대로 남는다(동결).
 *
 * 결정론(AC-D2): Math.random/Date.now 금지. playerId 문자열 해시만 쓴다(맵 순회 순서 무관).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashSeed } from "./rng";
import type { Grade, Position } from "./generate";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** 발행 버전 태그(파일명·manifest.version). */
export const CHARS_MAP_VERSION = "v2";

/** 이 매핑이 전제하는 캐릭터 발행물(design/characters/dist/characters). 불일치 시 생성이 실패한다. */
export const CHARS_SOURCE = "ref-pixel-fantasy-football";

/** 이 매핑이 전제하는 유닛 발행물(design/characters/dist/units). 불일치 시 생성이 실패한다. */
export const UNITS_SOURCE = "hero-imageRef-2026-08-01-rev5";

/** 기본 입력 시드(현행 소비본). 다른 시드로 태우려면 `loadInputs(파일명)`. */
export const DEFAULT_SEED_FILE = "players.v2.4.json";

/** 해시 분산용 솔트 — 바꾸면 풀 배정이 통째로 바뀐다(= 새 버전 발행 대상). */
const SALT = "hmb-player-chars-v1";

// ── 축 ─────────────────────────────────────────────────────────────────────

/** 아트 발행 축. `characters` = 원화 14종 축, `units` = hero 입고 실아트 축(#207 W3-B). */
export type CharAxis = "characters" | "units";

/** 매핑값 — **축 태그가 붙은 참조**. 소비자는 axis 로 볼 manifest 를 고른다. */
export interface CharRef {
  axis: CharAxis;
  id: string;
}

// ── 확정 배정 ───────────────────────────────────────────────────────────────
//
// characters 축 LEGEND 1:1(#145 원안 그대로 — 아트를 뺏지 않는다).
// 이 14명은 #207 U-D1 로 **비활성**(획득 경로 제외)이 됐지만 보유분이 존재하므로 매핑을 유지한다.
const LEGEND_ASSIGNMENT: ReadonlyArray<readonly [playerId: string, charId: string]> = [
  ["P001", "aura"], // GK
  ["P002", "lupus"], // DF
  ["P003", "leo"], // DF
  ["P004", "bark"], // DF
  ["P005", "sail"], // MF
  ["P006", "mio"], // MF
  ["P007", "riya"], // MF
  ["P008", "bella"], // MF
  ["P009", "ragna"], // FW
  ["P010", "natzt"], // FW
  ["P011", "anubis"], // FW
  ["P012", "penguin-king"], // FW ← 여분 GK 캐릭터 전용(유일한 포지션 교차)
  ["P143", "sail-h150"], // MF (발행측 forPlayer 힌트)
  ["P144", "ragna-h210"], // FW (발행측 forPlayer 힌트)
];

/**
 * units 축 1:1 — U-D5 **활성 LEGEND 5종**(실아트 입고 완료분).
 * 발행측 `forPlayer` 힌트와 같은 값이지만 **권위는 이 표**다(manifest mappingHint 참조).
 * 힌트와의 일치는 계약 테스트가 감시한다 — 어긋나면 발행/매핑 중 하나가 틀린 것이다.
 */
const UNIT_ASSIGNMENT: ReadonlyArray<readonly [playerId: string, unitId: string]> = [
  ["P173", "bonaldo"], // FW
  ["P175", "yeoldona"], // MF
  ["P176", "chunbappe"], // FW
  ["P177", "dukbrayner"], // MF
  ["P179", "wookringham"], // MF
  ["P180", "kyeongnicius"], // FW ← 3차 입고(2026-07-29). 미매핑 표에서 승격.
  ["P181", "seokdijk"], // DF ← 3차 입고 아트가 #256 채번으로 붙었다(pendingCatalog 해제).
  ["P182", "osiyas"], // GK ← 4차 입고(2026-07-29). 아트·채번 동시(#256).
  ["P174", "kwonssi"], // FW ← 5차 입고(2026-08-01, #389). 미매핑 표에서 승격 — 채번은 #207 때 이미 됐다.
];

/**
 * 아트 미입고라 **의도적으로 매핑하지 않는** LEGEND(5차 입고 후 1종 — 석신).
 *
 * 왜 표로 두나: LEGEND 는 "배정표에 없으면 throw" 가 규칙이다(1:1 이 조용히 깨지는 걸 막는다).
 * 미입고를 침묵으로 표현하면 **새 LEGEND 가 실수로 추가된 경우와 구분이 안 된다** → 의도만
 * 여기 명시적으로 적고, 나머지 누락은 계속 throw 한다. 아트가 들어오면 이 줄을 UNIT_ASSIGNMENT
 * 로 옮기는 것이 해제 신호다. (3차 입고 2026-07-29 에 P180 경니시우스가, 5차 입고 2026-08-01 에
 * P174 권씨가 그렇게 승격됐다 — #389. 남은 미입고는 P178 석신 하나다.)
 */
const UNMAPPED_LEGENDS: readonly string[] = ["P178"];

/**
 * 아트는 입고됐지만 **시드에서 아직 비활성**인 LEGEND — 활성화 대기.
 *
 * 왜 필요한가: #207 파트 A 의 운영 모델은 "아트가 나오면 **어드민 API 토글 한 번**으로 켠다
 * (배포 불필요)"다(grade-mapping-v2 §9.8). 즉 **아트 머지가 활성화보다 먼저**이고, 그 사이
 * `players.v2.x` 시드는 `active:false` 인 게 **정상**이다(시드는 런타임 상태가 아니다).
 * 그런데 아래 검사가 "비활성인데 units 실아트를 갖고 있다 → throw" 로 **양방향**이라, 이 정상
 * 순서를 시드 발행 없이는 아예 통과할 수 없었다.
 *
 * 그래서 방향을 쪼갠다:
 *   - 유지(하드) : **활성인데 아트가 없다** → 계속 throw. 등급만 올리고 아트를 잊는 사고를 잡는다.
 *   - 허용(선언) : 비활성 + 아트 = 이 표에 **적힌 경우만**. 안 적혀 있으면 여전히 throw —
 *                  즉 "조용히 강등된 유닛이 실아트를 물고 있는" 원래 실패모드는 그대로 잡힌다.
 *
 * 해제 신호: 어드민으로 활성화한 상태를 다음 시드 버전으로 승격(§9.8)하면 `active:true` 가 되고,
 * 그때 이 표에 남아 있으면 **stale 로 throw** 한다(아래 역방향 검사) → 지우라는 신호다.
 */
const ACTIVATION_PENDING: readonly string[] = [
  "P180", // 경니시우스(3차 입고 2026-07-29)
  "P181", // 석다이크(#256 채번 — 아트는 3차 입고분)
  "P182", // 오시야스(#256 채번 — 4차 입고)
  "P174", // 권씨(5차 입고 2026-08-01, #389) — 오픈은 hero 공지와 함께. 활성화는 어드민 토글 1회.
];

/** GOLD/SILVER/BRONZE 전원이 공용하는 기본 스킨(U-D8). */
export const DEFAULT_UNIT_ID = "default-unit";

/** 디폴트 유닛을 쓰는 등급(U-D8). 경기장에서도 개별 아이콘을 쓰지 않는다(팀색 원). */
export const DEFAULT_UNIT_GRADES: readonly Grade[] = ["GOLD", "SILVER", "BRONZE"];

/**
 * `characters` 풀 = **원본 12종만** 포지션별로 묶은 것. 변형 2종은 LEGEND 전용이라 제외한다.
 * U-D9 이후 이 풀의 소비자는 **DIA 25명뿐**이다(GOLD 이하는 디폴트 유닛으로 빠졌다).
 */
export const POOL_BY_POSITION: Readonly<Record<Position, readonly string[]>> = {
  GK: ["aura", "penguin-king"],
  DF: ["bark", "leo", "lupus"],
  MF: ["bella", "mio", "riya", "sail"],
  FW: ["anubis", "natzt", "ragna"],
};

/** `characters` 포지션 풀을 쓰는 등급(U-D9 — 현행 유지). */
export const POOL_GRADES: readonly Grade[] = ["DIA"];

// ── 순수 배정 로직 ──────────────────────────────────────────────────────────

export interface MappedPlayer {
  playerId: string;
  axis: CharAxis;
  id: string;
  /** 배정 근거. */
  rule: "legend-exclusive" | "unit-exclusive" | "grade-default-unit" | "position-pool";
  /** 아트의 포지션과 선수 포지션이 다른가(포지션 없는 디폴트 유닛은 대상 아님). */
  crossPosition?: true;
}

/**
 * 풀 배정 = 포지션 그룹 안에서 **균등 라운드로빈**.
 *
 * 왜 순수 해시가 아닌가: 풀이 2~4종뿐이라 해시는 쏠린다(실측 DF 53명 → 22/17/14). 중복이
 * 불가피한 B안에서 쏠림은 "같은 얼굴만 보인다"로 직결되므로 **최대 편차 1**을 보장한다.
 * 시작 오프셋만 그룹 해시로 돌려 포지션마다 같은 캐릭터로 시작하지 않게 한다.
 *
 * 결정론: 입력을 playerId 오름차순으로 고정 정렬한 뒤 인덱스를 매기므로 입력 순서 무관.
 */
export function assignPool(playerIds: readonly string[], position: Position): Map<string, string> {
  const pool = POOL_BY_POSITION[position];
  const sorted = [...playerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const offset = hashSeed(`${SALT}:${position}`) % pool.length;
  const out = new Map<string, string>();
  sorted.forEach((id, i) => out.set(id, pool[(i + offset) % pool.length]));
  return out;
}

export interface PlayerLike {
  id: string;
  position: Position;
  grade: Grade;
  /** #207 U-D1 카탈로그 운영 플래그. 없으면(구 시드) 활성으로 본다. */
  active?: boolean;
}

/** 캐릭터 발행 manifest 중 이 생성기가 쓰는 부분. */
export interface CharsManifestLike {
  source?: string;
  characters: Record<string, { position: string } | undefined>;
}

/** 유닛 발행 manifest 중 이 생성기가 쓰는 부분. */
export interface UnitsManifestLike {
  source?: string;
  units: Record<
    string,
    {
      position?: string | null;
      forPlayer?: string;
      forGrades?: string[];
      /** 아트는 발행됐지만 **붙일 선수가 카탈로그에 없다**(채번 대기). 발행측 선언. */
      pendingCatalog?: boolean;
    } | undefined
  >;
}

const isActive = (p: PlayerLike) => p.active !== false;

/**
 * 선수 목록 → 매핑. 순수 함수(IO 없음). playerId 오름차순으로 정렬해 직렬화 안정성을 보장한다.
 * 발행물에 없는 id 를 만들면 즉시 throw — 조용히 깨진 참조를 내보내지 않는다.
 *
 * **미매핑은 결과에서 빠진다**(= 소비자 폴백). 의도적 미매핑(UNMAPPED_LEGENDS)만 허용하고,
 * 그 밖의 누락은 전부 throw 한다.
 */
export function buildMapping(
  players: readonly PlayerLike[],
  manifest: CharsManifestLike,
  units: UnitsManifestLike,
): MappedPlayer[] {
  if (manifest.source && manifest.source !== CHARS_SOURCE) {
    throw new Error(`캐릭터 발행물이 예상과 다르다: ${manifest.source} (기대 ${CHARS_SOURCE}) — 매핑 재확정 필요`);
  }
  if (units.source && units.source !== UNITS_SOURCE) {
    throw new Error(`유닛 발행물이 예상과 다르다: ${units.source} (기대 ${UNITS_SOURCE}) — 매핑 재확정 필요`);
  }
  const legend = new Map(LEGEND_ASSIGNMENT);
  const unitMap = new Map(UNIT_ASSIGNMENT);
  const unmapped = new Set(UNMAPPED_LEGENDS);
  const activationPending = new Set(ACTIVATION_PENDING);
  const byId = new Map(players.map((p) => [p.id, p]));

  // 디폴트 유닛이 없으면 GOLD 이하 전원이 폴백으로 떨어진다 — 조용히 넘어가지 않는다.
  if (!units.units[DEFAULT_UNIT_ID]) throw new Error(`유닛 발행물에 없는 유닛: ${DEFAULT_UNIT_ID}`);

  // characters 축 LEGEND 배정표가 실제 시드와 어긋나면(등급 재배정 등) 조용히 넘어가지 않는다.
  for (const [playerId, charId] of LEGEND_ASSIGNMENT) {
    const p = byId.get(playerId);
    if (!p) throw new Error(`LEGEND 배정 대상이 시드에 없다: ${playerId}`);
    if (p.grade !== "LEGEND") throw new Error(`${playerId} 는 LEGEND 가 아니다(${p.grade}) — 배정표 재확정 필요`);
    if (!manifest.characters[charId]) throw new Error(`발행물에 없는 캐릭터: ${charId}`);
  }
  // units 축 배정표(U-D5 활성 5종)도 같은 규율로 검사한다.
  for (const [playerId, unitId] of UNIT_ASSIGNMENT) {
    const p = byId.get(playerId);
    if (!p) throw new Error(`유닛 배정 대상이 시드에 없다: ${playerId}`);
    if (p.grade !== "LEGEND") throw new Error(`${playerId} 는 LEGEND 가 아니다(${p.grade}) — 배정표 재확정 필요`);
    // 비활성으로 내려간 유닛이 **조용히** 실아트를 유지하면 U-D5 전제가 깨진 걸 못 본다.
    // 단 "아트 입고 → 머지 → 어드민 활성화" 순서에서는 비활성+아트가 **정상 중간상태**이므로
    // ACTIVATION_PENDING 에 적힌 경우만 통과시킨다(선언되지 않은 비활성은 계속 throw).
    if (!isActive(p) && !activationPending.has(playerId)) {
      throw new Error(`${playerId} 는 비활성인데 units 축 실아트를 갖고 있다 — U-D5 재확정 필요`
        + ` (의도한 활성화 대기면 ACTIVATION_PENDING 에 선언해라)`);
    }
    if (!units.units[unitId]) throw new Error(`유닛 발행물에 없는 유닛: ${unitId}`);
  }
  // 대기표에 적힌 id 는 배정이 있어야 한다(적어만 놓고 매핑을 잊는 것 방지). **활성 여부는 여기서
  // 보지 않는다** — buildMapping 은 임의 시드로도 태울 수 있어야 하고(회귀 검증), 과거 시드에선
  // 같은 선수가 활성일 수 있다. "승격됐으니 표를 지워라"라는 stale 신호는 **현행 시드에 고정된**
  // chars-map.test.ts 계약이 맡는다.
  for (const playerId of ACTIVATION_PENDING) {
    if (!unitMap.has(playerId)) throw new Error(`${playerId} 는 활성화 대기인데 units 배정이 없다`);
  }
  // LEGEND 는 세 갈래(characters 1:1 / units 1:1 / 의도적 미매핑) 중 정확히 하나에 속해야 한다.
  for (const p of players) {
    if (p.grade !== "LEGEND") continue;
    const slots = [legend.has(p.id), unitMap.has(p.id), unmapped.has(p.id)].filter(Boolean).length;
    if (slots === 0) throw new Error(`LEGEND 인데 배정표에 없다: ${p.id} — 1:1 고정이 깨졌다`);
    if (slots > 1) throw new Error(`LEGEND 가 두 축에 동시에 배정됐다: ${p.id}`);
  }

  // characters 포지션 풀은 U-D9 대상 등급(DIA)만 쓴다 — 그룹 단위라야 편차를 보장할 수 있다.
  const poolGrades = new Set<Grade>(POOL_GRADES);
  const pooled = new Map<string, string>();
  for (const position of ["GK", "DF", "MF", "FW"] as const) {
    const ids = players.filter((p) => p.position === position && poolGrades.has(p.grade)).map((p) => p.id);
    for (const [id, charId] of assignPool(ids, position)) pooled.set(id, charId);
  }

  const defaultGrades = new Set<Grade>(DEFAULT_UNIT_GRADES);
  const out: MappedPlayer[] = [];
  for (const p of [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    let row: MappedPlayer | null = null;
    const unitId = unitMap.get(p.id);
    const charId = legend.get(p.id);
    if (unitId) {
      row = { playerId: p.id, axis: "units", id: unitId, rule: "unit-exclusive" };
    } else if (charId) {
      row = { playerId: p.id, axis: "characters", id: charId, rule: "legend-exclusive" };
    } else if (unmapped.has(p.id)) {
      continue; // 의도적 미매핑 — 소비자가 이니셜 폴백으로 그린다.
    } else if (defaultGrades.has(p.grade)) {
      row = { playerId: p.id, axis: "units", id: DEFAULT_UNIT_ID, rule: "grade-default-unit" };
    } else if (poolGrades.has(p.grade)) {
      const pooledId = pooled.get(p.id);
      if (!pooledId) throw new Error(`풀 배정이 비었다: ${p.id}`);
      row = { playerId: p.id, axis: "characters", id: pooledId, rule: "position-pool" };
    } else {
      throw new Error(`매핑 규칙이 없는 등급: ${p.grade} (${p.id}) — U-D5/U-D8/U-D9 재확정 필요`);
    }

    const artPosition =
      row.axis === "characters"
        ? manifest.characters[row.id]?.position
        : units.units[row.id]?.position ?? null;
    if (row.axis === "characters" && !manifest.characters[row.id]) {
      throw new Error(`발행물에 없는 캐릭터: ${row.id} (${p.id})`);
    }
    if (row.axis === "units" && !units.units[row.id]) {
      throw new Error(`유닛 발행물에 없는 유닛: ${row.id} (${p.id})`);
    }
    // 포지션 없는 아트(디폴트 유닛)는 교차 판정 대상이 아니다 — 등급 공용이라 포지션 개념이 없다.
    if (artPosition && artPosition !== p.position) row.crossPosition = true;
    out.push(row);
  }
  return out;
}

export interface CharsMapFile {
  version: string;
  rule: string;
  note: string;
  charsSource: string;
  unitsSource: string;
  /** 입력 시드(권위 카탈로그) 파일명 — 어느 카탈로그를 보고 만든 매핑인지 박제. */
  playersSource: string;
  /** 입력 카탈로그 총원. */
  catalogCount: number;
  /** 매핑된 선수 수(= players 키 수). catalogCount 와의 차이 = 의도적 미매핑. */
  playerCount: number;
  /** 의도적 미매핑(아트 미입고) — 소비자는 이니셜 폴백으로 그린다. */
  unmapped: string[];
  /** playerId → {axis,id} (조인 키). 소비자는 이 맵만 보면 된다. */
  players: Record<string, CharRef>;
  /** 배정 근거(감사·QA용). 렌더에는 불필요. */
  detail: MappedPlayer[];
}

export function buildFile(
  players: readonly PlayerLike[],
  manifest: CharsManifestLike,
  units: UnitsManifestLike,
  seedFile: string = DEFAULT_SEED_FILE,
): CharsMapFile {
  const detail = buildMapping(players, manifest, units);
  const map: Record<string, CharRef> = {};
  for (const d of detail) map[d.playerId] = { axis: d.axis, id: d.id };
  const mappedIds = new Set(detail.map((d) => d.playerId));
  return {
    version: CHARS_MAP_VERSION,
    rule:
      "#207 U-D5/U-D8/U-D9: 활성 LEGEND 5 = units 1:1 실아트 · 비활성 LEGEND = 현행 유지(구 14 characters 1:1, 미입고 3 미매핑) · " +
      "DIA = characters 포지션 풀 · GOLD/SILVER/BRONZE = units default-unit 공용",
    note:
      "매핑값은 **축 태그가 붙은 객체**다({axis,id}). v1(문자열)을 읽던 소비자는 타입 가드에서 null 로 " +
      "떨어져 폴백한다 — 틀린 그림을 그리지 않는 fail-safe 형상. 소비자는 playerId 로 조인한다.",
    charsSource: CHARS_SOURCE,
    unitsSource: UNITS_SOURCE,
    playersSource: seedFile,
    catalogCount: players.length,
    playerCount: detail.length,
    unmapped: players.map((p) => p.id).filter((id) => !mappedIds.has(id)),
    players: map,
    detail,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

export interface GenInputs {
  players: PlayerLike[];
  manifest: CharsManifestLike;
  units: UnitsManifestLike;
  seedFile: string;
}

/** 입력 시드는 파라미터다 — 과거 시드로도 태울 수 있어야 회귀·변이체 검증이 성립한다. */
export function loadInputs(seedFile: string = DEFAULT_SEED_FILE): GenInputs {
  const players = JSON.parse(readFileSync(join(here, seedFile), "utf8")) as PlayerLike[];
  const distDir = join(repoRoot, "design", "characters", "dist");
  const manifest = JSON.parse(
    readFileSync(join(distDir, "characters", "manifest.json"), "utf8"),
  ) as CharsManifestLike;
  const units = JSON.parse(readFileSync(join(distDir, "units", "manifest.json"), "utf8")) as UnitsManifestLike;
  return { players, manifest, units, seedFile };
}

export const OUT_PATH = join(here, `player-chars.${CHARS_MAP_VERSION}.json`);

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const seedFile = process.argv[2] ?? DEFAULT_SEED_FILE;
  const { players, manifest, units } = loadInputs(seedFile);
  const file = buildFile(players, manifest, units, seedFile);
  writeFileSync(OUT_PATH, JSON.stringify(file, null, 2) + "\n");
  const used = new Set(Object.values(file.players).map((r) => `${r.axis}:${r.id}`)).size;
  console.log(
    `[gen-chars] ${OUT_PATH} — 카탈로그 ${file.catalogCount}명 중 ${file.playerCount}명 매핑 ` +
      `(아트 ${used}종 사용 · 미매핑 ${file.unmapped.length}명: ${file.unmapped.join(",") || "없음"})`,
  );
}
