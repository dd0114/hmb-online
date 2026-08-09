import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PlayerCard } from "@hmb/shared";
import {
  generateAll,
  rollAttributes,
  SEED,
  type PlayerSeed,
  type Position,
  type Grade,
  type Personality,
  V28_RETIRED_CARDS,
  V281_FIX_CARDS,
  V27_ACTIVE_CARDS,
} from "./generate";
import { createRng } from "./rng";
import { ROSTER } from "./roster";
import { PERSONALITY } from "./personality";

const POSITIONS: Position[] = ["GK", "DF", "MF", "FW"];
const GRADES: Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];

// 문서화된 총원(LLD-data §2 v2 / grade-mapping-v2.md)을 테스트에 직접 박제 — roster/generate 의
// 상수를 재사용하면 자기참조 검증이 되어 데이터 드리프트를 못 잡는다. 리터럴로 독립 검증한다.
//
// #207(웨이브2-B, hero 확정 U-D4): 구 172명 + 신규 LEGEND 8종 = **180명**(players.v2.2).
// 구 172명 발행물(players.v2 / v2.1)은 **동결**(발행 후 수정 금지, data/CLAUDE.md) — 신규분은
// ROSTER 맨 끝에 append 되어 P173~P180 을 받고, 앞 172명은 바이트 동일하게 보존된다.
// #256(hero 확정 2026-07-29): 180명 + 신규 LEGEND 2종(석다이크 DF · 오시야스 GK) = **182명**
// (players.v2.4). v2.2/v2.3 발행물도 이제 **동결**이라 경계 상수가 하나 더 생겼다.
const TOTAL = 182;
/** players.v2 / players.v2.1 이 동결된 시점의 총원. 이 경계 앞은 절대 변하지 않는다. */
const FROZEN_TOTAL = 172;
/** players.v2.2 / players.v2.3 이 동결된 시점의 총원(#207 신규 8종까지). 이 경계도 불변. */
const V23_TOTAL = 180;
// 전체 카탈로그(182). 구 172명 GK13/DF53/MF59/FW47 + #207 8종(GK1/MF3/FW4) + #256 2종(GK1/DF1).
const POSITION_TOTALS: Record<Position, number> = { GK: 15, DF: 54, MF: 62, FW: 51 };
const GRADE_TOTALS: Record<Grade, number> = {
  BRONZE: 35,
  SILVER: 52,
  GOLD: 46,
  DIA: 25,
  LEGEND: 24,
};
/** v2.2/v2.3 발행 경계(180)에서의 분포 — 그 발행물들은 동결이라 이 값도 영구 고정이다. */
const V23_POSITION_TOTALS: Record<Position, number> = { GK: 14, DF: 53, MF: 62, FW: 51 };
const V23_GRADE_TOTALS: Record<Grade, number> = {
  BRONZE: 35,
  SILVER: 52,
  GOLD: 46,
  DIA: 25,
  LEGEND: 22,
};

/**
 * #207 U-D4 확정 신규 8종(P173~P180). 유닛명·포지션·traits 를 리터럴로 박제한다
 * (roster.ts 를 재사용하면 자기참조 — 이슈 결정표와 코드가 어긋나도 못 잡는다).
 */
const NEW_UNITS: readonly {
  id: string;
  name: string;
  position: Position;
  traits: readonly (keyof PlayerSeed["attributes"])[];
}[] = [
  { id: "P173", name: "보날두", position: "FW", traits: ["shooting", "physical"] },
  { id: "P174", name: "권씨", position: "FW", traits: ["technical", "shooting"] },
  { id: "P175", name: "유라도나", position: "MF", traits: ["technical", "shooting"] },
  { id: "P176", name: "춘바페", position: "FW", traits: ["pace", "shooting"] },
  { id: "P177", name: "덕브라이너", position: "MF", traits: ["passing", "shooting"] },
  { id: "P178", name: "석신", position: "GK", traits: ["positioning", "mental"] },
  { id: "P179", name: "욱리엄", position: "MF", traits: ["physical", "shooting"] },
  { id: "P180", name: "경니시우스", position: "FW", traits: ["pace", "technical"] },
];

/**
 * #207 U-D1(조합안): 구 LEGEND 14종은 **등급 LEGEND 를 그대로 유지**하고 `active:false` 로만
 * 표시한다(강등 아님 — 기보유 유저 손실 0). 가챠/트레이드 신규 획득 경로에서만 제외.
 */
const INACTIVE_IDS: readonly string[] = [
  ...Array.from({ length: 12 }, (_, i) => `P${String(i + 1).padStart(3, "0")}`), // P001~P012
  "P143", // Park Ji-sung
  "P144", // Cha Bum-kun
];

/**
 * #207 U-D6 — 유닛명 정본 정정(v2.3). 이름이 **카드 아트에 구워져** 발행돼 아트가 정본이다.
 * 이슈 결정표에서 직접 박제한다(generate.ts 의 V23_NAME_CORRECTIONS 재사용은 자기참조).
 */
const V23_RENAMES: readonly { id: string; before: string; after: string }[] = [
  { id: "P175", before: "유라도나", after: "열라도나" },
  { id: "P179", before: "욱리엄", after: "욱링엄" },
];

/**
 * #207 U-D5 — 신규 8종 중 **실아트 입고 완료 5종만 활성**. 나머지 3종은 시드에 남긴 채 비활성.
 * (아트 입고 시 어드민 카탈로그 API 토글 한 번으로 배포 없이 활성화 — #207 파트 A.)
 */
const V23_ACTIVE_LEGEND_IDS: readonly string[] = ["P173", "P175", "P176", "P177", "P179"];
const V23_NEW_INACTIVE_IDS: readonly string[] = ["P174", "P178", "P180"];
/** v2.3 비활성 전체 = 구 LEGEND 14 + 신규 미입고 3 = 17. */
const INACTIVE_IDS_V23: readonly string[] = [...INACTIVE_IDS, ...V23_NEW_INACTIVE_IDS];

/**
 * #256 hero 확정(2026-07-29) 신규 2종(P181~P182). NEW_UNITS 와 같은 이유로 **리터럴 박제** —
 * roster.ts 를 재사용하면 자기참조라 결정과 코드가 어긋나도 못 잡는다.
 *
 * traits 는 "스탯을 숫자로 복사"가 아니라 **소스 실선수의 포지션·traits 만 복제**하는 기존
 * 관례(석신←야신)를 따른 값이다. 판다이크(P015)는 DIA 라 값을 복사하면 LEGEND 에 DIA 성능이
 * 되고, 카시야스는 애초에 로스터에 없다 — 그래서 값 복사 경로 자체가 성립하지 않는다.
 */
const V24_NEW_UNITS: readonly {
  id: string;
  name: string;
  position: Position;
  traits: readonly (keyof PlayerSeed["attributes"])[];
}[] = [
  { id: "P181", name: "석다이크", position: "DF", traits: ["tackling", "physical"] },
  { id: "P182", name: "오시야스", position: "GK", traits: ["positioning", "physical"] },
];

/**
 * #256 — 신규 2종은 `active:false` 로 발행한다(아트 머지 → 배포 → 어드민 토글이 활성화 순서).
 * 따라서 **획득 가능 LEGEND 의 DF/GK 갭은 채번만으로 닫히지 않는다** — 이 상태를 그대로 박제한다.
 */
const V24_NEW_INACTIVE_IDS: readonly string[] = ["P181", "P182"];
/** v2.4 비활성 전체 = v2.3 의 17 + 신규 2 = 19. */
const INACTIVE_IDS_V24: readonly string[] = [...INACTIVE_IDS_V23, ...V24_NEW_INACTIVE_IDS];

/**
 * #405 W1 — **초기 스탯 하향 밴드**(players.v2.5). `docs/plan-v5/growth-redesign.md` §2.2 확정표에서
 * 직접 박제한다(generate.ts 의 `GRADE_BANDS_V25` 재사용은 자기참조 — 설계와 코드가 어긋나도 못 잡는다).
 *
 * ⚠️ **여기 있는 것은 "시작 밴드"뿐이다.** 성장 천장(72/78/84/90/95)은 data 가 발행하지 않는다 —
 * 런타임 SoT 는 server 의 `GrowthTuning.bands.growCeil` 이다(§2.8.1). 그 경계를 아래
 * `V25_GROW_CEIL_NOT_PUBLISHED` 계약이 직접 지킨다.
 */
const V25_BANDS: Record<Grade, readonly [number, number]> = {
  BRONZE: [32, 42],
  SILVER: [41, 51],
  GOLD: [50, 60],
  DIA: [59, 69],
  LEGEND: [68, 78],
};
/** §2.2 "시작 중앙" 열 — 밴드 중앙값이 설계표와 일치하는지 직접 대조한다. */
const V25_START_MEDIAN: Record<Grade, number> = {
  BRONZE: 37,
  SILVER: 46,
  GOLD: 55,
  DIA: 64,
  LEGEND: 73,
};
/** §2.2 성장 천장 — **server 소관**. data 발행물에 이 값이 새어 나오면 경계가 무너진 것이다. */
const V25_GROW_CEIL_NOT_PUBLISHED: Record<Grade, number> = {
  BRONZE: 72,
  SILVER: 78,
  GOLD: 84,
  DIA: 90,
  LEGEND: 95,
};
/** v2.5 = v2.4 와 **같은 182행**(신규 채번 0, 능력치만 재롤). */
const V25_TOTAL = 182;

/**
 * 패러디 유닛명에 실명이 새어 들어오지 않는지 — 소스 실선수의 한글 표기 denylist(부분문자열 금지).
 *
 * ⚠️ **적용 범위 = 패러디 유닛(P173~P182) 뿐이다** (#406 hero 확정 2026-08-02, 안 C 하이브리드).
 * 원래 목적이 "패러디명이 실명을 베끼지 않는다"이므로 범위를 명시하는 것은 가드 약화가 아니라
 * **의도에 정확해지는** 것이다. v2.6 부터 실선수 172명의 `name` 은 **한글 음역**이고(레프 야신·
 * 디에고 마라도나·호나우두 나자리우·주드 벨링엄·킬리안 음바페·비니시우스 주니오르 = 이 목록과
 * 정면으로 겹치는 6건), 그건 **정상 통과해야 한다** — 실명 유닛에 실명을 쓰는 것이 안 C 다.
 * 그래서 이 배열은 실선수 축에는 절대 적용하지 않는다(그 대비는 아래 v2.6 describe 가 박제).
 */
const PARODY_REAL_NAME_KO_DENYLIST: readonly string[] = [
  "호날두",
  "호나우두",
  "메시",
  "마라도나",
  "음바페",
  "데브라위너",
  "야신",
  "벨링엄",
  "비니시우스",
];

/**
 * hero 요청(#84): 한국 유명 선수 추가. 대표 선수의 존재·등급을 명시 검증(도감 반영 보장).
 *
 * #406 로 축이 둘이 됐다 — `name`(ROSTER·v2~v2.5 발행물의 **로마자 표기**)과 `ko`(v2.6 발행물의
 * **한글 표기**). 둘 다 박제하는 이유: 로마자 축은 로스터/동결 발행물의 정체성이라 계속 유효하고,
 * 한글 축은 "한국 선수가 실제로 한글로 나온다"는 #406 요구 6 의 최종 결과물이기 때문이다.
 * 한 축만 두면 v2.6 레이어가 엉뚱한 행을 개명해도 통과한다.
 */
const EXPECTED_KOREANS: readonly { name: string; ko: string; grade: Grade }[] = [
  { name: "Son Heung-min", ko: "손흥민", grade: "DIA" },
  { name: "Kim Min-jae", ko: "김민재", grade: "DIA" },
  { name: "Park Ji-sung", ko: "박지성", grade: "LEGEND" },
  { name: "Cha Bum-kun", ko: "차범근", grade: "LEGEND" },
  { name: "Lee Kang-in", ko: "이강인", grade: "GOLD" },
  { name: "Hwang Hee-chan", ko: "황희찬", grade: "GOLD" },
  { name: "Cho Hyun-woo", ko: "조현우", grade: "SILVER" },
  { name: "Yang Min-hyuk", ko: "양민혁", grade: "BRONZE" },
];
const BANDS: Record<Grade, readonly [number, number]> = {
  BRONZE: [40, 55],
  SILVER: [50, 65],
  GOLD: [60, 75],
  DIA: [70, 85],
  LEGEND: [80, 95],
};
const PRIMARY: Record<Position, readonly (keyof PlayerSeed["attributes"])[]> = {
  GK: ["positioning", "mental"],
  DF: ["tackling", "positioning"],
  MF: ["passing", "stamina"],
  FW: ["shooting", "pace"],
};
const RANK: Record<Grade, number> = { BRONZE: 0, SILVER: 1, GOLD: 2, DIA: 3, LEGEND: 4 };

const PERSONALITIES: Personality[] = ["FIERY", "CALM", "GLASS", "AMBITIOUS"];

// personality 목표 분포(PRD-v3 P2-D7): 대략 FIERY 25 / CALM 40 / GLASS 15 / AMBITIOUS 20 (%).
// "대략" 이므로 밴드로 검증(정확 카운트 강제 금지 — 큐레이션 여지 유지). data 독립 리터럴.
const PERSONALITY_BANDS: Record<Personality, readonly [number, number]> = {
  FIERY: [0.2, 0.3],
  CALM: [0.34, 0.46],
  GLASS: [0.1, 0.2],
  AMBITIOUS: [0.15, 0.25],
};

// 리그 봇 클럽명 실클럽 denylist — data 와 독립인 리터럴(유명 실클럽 정규화 풀네임 + 도시/고유 토큰).
// 가상 클럽명이 이 중 하나와 같거나(정확 일치) 도시 토큰을 포함하면 실패.
const REAL_CLUB_NAMES: readonly string[] = [
  "Manchester United",
  "Manchester City",
  "Liverpool",
  "Chelsea",
  "Arsenal",
  "Tottenham Hotspur",
  "Newcastle United",
  "Aston Villa",
  "West Ham United",
  "Real Madrid",
  "Barcelona",
  "Atletico Madrid",
  "Sevilla",
  "Valencia",
  "Bayern Munich",
  "Borussia Dortmund",
  "RB Leipzig",
  "Bayer Leverkusen",
  "Juventus",
  "Inter Milan",
  "AC Milan",
  "Napoli",
  "AS Roma",
  "Paris Saint-Germain",
  "Marseille",
  "Ajax",
  "PSV Eindhoven",
  "Feyenoord",
  "Benfica",
  "Porto",
  "Sporting CP",
  "Celtic",
  "Rangers",
];
// 실클럽 고유 도시/식별 토큰(가상명에 섞이면 안 됨) — 일반 접미사(United/FC/Athletic 등)는 제외.
const REAL_CLUB_TOKENS: readonly string[] = [
  "Manchester",
  "Liverpool",
  "Chelsea",
  "Arsenal",
  "Tottenham",
  "Newcastle",
  "Madrid",
  "Barcelona",
  "Atletico",
  "Sevilla",
  "Munich",
  "Dortmund",
  "Leipzig",
  "Leverkusen",
  "Juventus",
  "Napoli",
  "Milan",
  "Roma",
  "Ajax",
  "Benfica",
  "Porto",
  "Celtic",
];

const {
  players, playersV2, playersV21, playersV22, playersV23, playersV24, playersV25, playersV26,
  playersV27, playersV28, playersV281, economy, economyV3, economyV4, bots, league, leagueV2, botsV3, botsV4,
} = generateAll();

describe("players 카탈로그 — counts/distribution (AC-PL1)", () => {
  it(`총 ${TOTAL}명`, () => {
    expect(players.length).toBe(TOTAL);
  });

  it("포지션 분포 GK15/DF54/MF62/FW51 (#207 8종 + #256 2종 가산)", () => {
    const counts: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const p of players) counts[p.position]++;
    expect(counts).toEqual(POSITION_TOTALS);
  });

  it("GK 비중이 낮다 — 컬렉션의 12% 미만(팀당 선발 1명, hero 지적 반영)", () => {
    const gk = players.filter((p) => p.position === "GK").length;
    expect(gk / players.length).toBeLessThan(0.12);
  });

  it("등급 분포 BRONZE35/SILVER52/GOLD46/DIA25/LEGEND24 (레전드 희소)", () => {
    const counts: Record<Grade, number> = {
      BRONZE: 0,
      SILVER: 0,
      GOLD: 0,
      DIA: 0,
      LEGEND: 0,
    };
    for (const p of players) counts[p.grade]++;
    expect(counts).toEqual(GRADE_TOTALS);
  });

  it("등급 희소성 단조 — LEGEND < DIA < GOLD, 저등급이 더 흔함(수집 열망)", () => {
    const counts: Record<Grade, number> = { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 };
    for (const p of players) counts[p.grade]++;
    expect(counts.LEGEND).toBeLessThan(counts.DIA);
    expect(counts.DIA).toBeLessThan(counts.GOLD);
  });

  it("포지션×등급 교차 — 행/열 합이 각 총원과 일치", () => {
    const table: Record<Position, Record<Grade, number>> = {
      GK: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      DF: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      MF: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
      FW: { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 },
    };
    for (const p of players) table[p.position][p.grade]++;

    for (const pos of POSITIONS) {
      const rowSum = GRADES.reduce((s, g) => s + table[pos][g], 0);
      expect(rowSum, `${pos} 행 합`).toBe(POSITION_TOTALS[pos]);
    }
    for (const g of GRADES) {
      const colSum = POSITIONS.reduce((s, pos) => s + table[pos][g], 0);
      expect(colSum, `${g} 열 합`).toBe(GRADE_TOTALS[g]);
    }
  });

  it("GK는 등급별 최소 1명씩 보유(전 등급 GK 확보)", () => {
    const gkGradeCounts: Record<Grade, number> = {
      BRONZE: 0,
      SILVER: 0,
      GOLD: 0,
      DIA: 0,
      LEGEND: 0,
    };
    for (const p of players) if (p.position === "GK") gkGradeCounts[p.grade]++;
    for (const g of GRADES) {
      expect(gkGradeCounts[g], `GK ${g}`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("players 카탈로그 — ID/이름 유일성 + 실선수(로스터 일치)", () => {
  it(`ID가 P001..P${TOTAL} 순차·유일`, () => {
    const ids = players.map((p) => p.id);
    expect(new Set(ids).size).toBe(TOTAL);
    const expectedIds = Array.from(
      { length: TOTAL },
      (_, i) => `P${String(i + 1).padStart(3, "0")}`,
    );
    expect(ids).toEqual(expectedIds);
  });

  it("이름이 전부 유일", () => {
    const names = players.map((p) => p.name);
    expect(new Set(names).size).toBe(TOTAL);
  });

  it("실선수 이름(로스터 allowlist) — 생성 이름 = ROSTER 이름 (순서·값 일치)", () => {
    // v2는 실명 허용(이슈 #84). 이름은 큐레이션 로스터에서만 오고, 절차 생성 가상 이름이 아니다.
    expect(ROSTER.length).toBe(TOTAL);
    expect(players.map((p) => p.name)).toEqual(ROSTER.map((r) => r.name));
    const allow = new Set(ROSTER.map((r) => r.name));
    for (const p of players) expect(allow.has(p.name), `${p.id}:${p.name}`).toBe(true);
  });

  it("동결 172명 이름이 실선수 형태(라틴 문자 포함) — 구 가상 한글 3음절 패턴 아님", () => {
    // 이 가드의 원래 목적 = v1 절차생성 가상명(한글 3음절) 재유입 차단. 실선수 블록에만 적용한다.
    //
    // ⚠️ **적용 축 = ROSTER/영문(`players` = v2~v2.5 발행물의 이름)** 이다 (#406 로 축이 갈렸다).
    // v2.6 부터 발행물의 `name` 은 한글 음역이지만, 그건 **표시명 레이어**이고 ROSTER 는 여전히
    // 로마자다 — 로마자 축이 RNG 스트림 순서이자 동결 발행물 재현의 기준이라 이 가드는 그대로
    // 유효하다. 한글로 갈아치우는 축(v2.6)의 가드는 아래 "players.v2.6" describe 에 따로 있다
    // (한글 포함·빈 문자열 금지·길이 상한·shortName 무결성). 즉 가드를 약화한 게 아니라
    // **두 축에 각각 맞는 가드를 세운** 것이다.
    for (const p of players.slice(0, FROZEN_TOTAL)) {
      expect(p.name, `${p.id} 라틴 문자 포함`).toMatch(/[A-Za-z]/);
      expect(p.name, `${p.id} 구 가상 패턴 아님`).not.toMatch(/^[가-힣]{3}$/);
    }
  });

  it("신규 8종은 한글 패러디명 — 실명이 아니다(실명 유입 차단 유지, #207 U-D4)", () => {
    // 패러디명은 로마자화하면 의미가 죽으므로 한글 그대로 발행한다. 대신 "실명이 아니다"를
    // 두 축으로 못 박는다: ① 실선수 이름 재사용 0 ② 소스 실선수 한글 표기 부분문자열 0.
    const byId = new Map(players.map((p) => [p.id, p]));
    const realNames = new Set(players.slice(0, FROZEN_TOTAL).map((p) => p.name));
    for (const u of NEW_UNITS) {
      const p = byId.get(u.id);
      expect(p, `${u.id} 존재`).toBeDefined();
      expect(p!.name, `${u.id} 유닛명`).toBe(u.name);
      expect(p!.name, `${u.id} 한글 전용 패러디명`).toMatch(/^[가-힣]{2,}$/);
      expect(realNames.has(p!.name), `${u.id} 실선수 이름 재사용 금지`).toBe(false);
      for (const banned of PARODY_REAL_NAME_KO_DENYLIST) {
        expect(p!.name.includes(banned), `${u.id} 실명 "${banned}" 포함 금지`).toBe(false);
      }
    }
  });

  it("로스터 position/grade 가 생성 선수와 일치(파생 정합)", () => {
    players.forEach((p, i) => {
      expect(p.position).toBe(ROSTER[i].position);
      expect(p.grade).toBe(ROSTER[i].grade);
    });
  });

  it("한국 유명 선수 포함(hero 요청 #84) — 대표 선수 존재 + 등급 일치(로마자 축)", () => {
    const byName = new Map(players.map((p) => [p.name, p]));
    for (const k of EXPECTED_KOREANS) {
      const p = byName.get(k.name);
      expect(p, `한국 선수 ${k.name} 존재`).toBeDefined();
      expect(p?.grade, `${k.name} 등급`).toBe(k.grade);
    }
  });
});

describe("players 카탈로그 — 능력치 밴드 + trait 반영 (AC-PL1)", () => {
  const ATTR_KEYS = [
    "technical",
    "mental",
    "physical",
    "passing",
    "shooting",
    "tackling",
    "pace",
    "stamina",
    "positioning",
  ] as const;

  it("모든 능력치가 해당 등급 밴드 내(clamp 포함) — LLD 리터럴 밴드 기준", () => {
    for (const p of players) {
      const [lo, hi] = BANDS[p.grade];
      for (const key of ATTR_KEYS) {
        const v = p.attributes[key];
        expect(v, `${p.id} ${p.grade} ${key}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${p.id} ${p.grade} ${key}`).toBeLessThanOrEqual(hi);
        expect(Number.isInteger(v), `${p.id} ${key} integer`).toBe(true);
      }
    }
  });

  it("포지션 주스탯 평균이 비주스탯 평균보다 높다(+5 바이어스 효과, 모집단 단위)", () => {
    for (const pos of POSITIONS) {
      const posPlayers = players.filter((p) => p.position === pos);
      const primary = PRIMARY[pos];
      const primaryAvg =
        posPlayers.reduce(
          (s, p) => s + primary.reduce((s2, k) => s2 + p.attributes[k], 0) / primary.length,
          0,
        ) / posPlayers.length;
      const otherKeys = ATTR_KEYS.filter((k) => !primary.includes(k));
      const otherAvg =
        posPlayers.reduce(
          (s, p) => s + otherKeys.reduce((s2, k) => s2 + p.attributes[k], 0) / otherKeys.length,
          0,
        ) / posPlayers.length;
      expect(primaryAvg, `${pos} 주스탯 평균 > 비주스탯 평균`).toBeGreaterThan(otherAvg);
    }
  });

  it("각 선수의 trait 스탯이 밴드 내 상위(비trait 평균 이상) — 시그니처 반영", () => {
    // trait 는 +6 바이어스 대상. 개별 롤 편차가 있으므로 모집단(전체 trait vs 전체 비trait) 평균으로 검증.
    let traitSum = 0,
      traitN = 0,
      restSum = 0,
      restN = 0;
    players.forEach((p, i) => {
      const traits = new Set(ROSTER[i].traits as string[]);
      for (const key of ATTR_KEYS) {
        if (traits.has(key)) {
          traitSum += p.attributes[key];
          traitN++;
        } else {
          restSum += p.attributes[key];
          restN++;
        }
      }
    });
    expect(traitSum / traitN, "trait 평균 > 비trait 평균").toBeGreaterThan(restSum / restN);
  });
});

describe("players 카탈로그 — zod PlayerCard 호환 (AC-PL1)", () => {
  it("모든 선수가 shared PlayerCard 스키마로 파싱된다(id→playerId 매핑)", () => {
    for (const p of players) {
      const card = PlayerCard.parse({
        playerId: p.id,
        name: p.name,
        position: p.position,
        attributes: p.attributes,
      });
      expect(card.playerId).toBe(p.id);
    }
  });
});

describe("economy.v2 — 스타터팩·확률표", () => {
  it("economy.version === 'v2'", () => {
    expect(economy.version).toBe("v2");
  });

  it("initialPoints === 3000", () => {
    expect(economy.initialPoints).toBe(3000);
  });

  it("starterPack 14명: GK1/DF5/MF5/FW3, 전원 브론즈~실버", () => {
    expect(economy.starterPack.length).toBe(14);
    expect(new Set(economy.starterPack).size).toBe(14);

    const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));
    const counts: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const id of economy.starterPack) {
      const p = byId.get(id);
      expect(p, `starterPack id ${id} exists in players.v2`).toBeDefined();
      if (!p) continue;
      counts[p.position]++;
      expect(
        p.grade === "BRONZE" || p.grade === "SILVER",
        `${id} grade ${p.grade} within BRONZE~SILVER`,
      ).toBe(true);
    }
    expect(counts).toEqual({ GK: 1, DF: 5, MF: 5, FW: 3 });
  });

  it("gacha 확률 합 === 1", () => {
    const sum = Object.values(economy.gacha.rates).reduce((s, r) => s + r, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("gacha 수치 — 단뽑300/10연뽑3000/11개/GOLD pity", () => {
    expect(economy.gacha.singleCost).toBe(300);
    expect(economy.gacha.tenCost).toBe(3000);
    expect(economy.gacha.tenCount).toBe(11);
    expect(economy.gacha.tenPityMinGrade).toBe("GOLD");
  });

  it("gacha 레전드 희소 — LEGEND rate ≤ DIA ≤ GOLD (희소성 반영)", () => {
    const r = economy.gacha.rates;
    expect(r.LEGEND).toBeLessThanOrEqual(r.DIA);
    expect(r.DIA).toBeLessThanOrEqual(r.GOLD);
  });

  it("rewards — flat 폴백은 연습 보상과 동일(승500/무200/패100)", () => {
    const { win, draw, loss } = economy.rewards;
    expect({ win, draw, loss }).toEqual({ win: 500, draw: 200, loss: 100 });
  });

  // #212 hero 목표 곡선: 연습 적게 < 리그 매판 적당 < 리그 최종성적 가파르게.
  // 여기서는 앞의 두 구간(연습 vs 리그 매판)을 데이터 차원에서 박제한다 —
  // 최종성적 구간은 league.v1.json rewards 쪽 계약이 담당한다.
  describe("rewards.byMode — 모드별 보상(#212)", () => {
    it("practice/league 두 모드가 다 정의돼 있고, flat 폴백은 연습과 같다", () => {
      const byMode = economy.rewards.byMode;
      expect(Object.keys(byMode).sort()).toEqual(["league", "practice"]);
      expect(byMode.practice).toEqual({ win: 500, draw: 200, loss: 100 });
      expect(byMode.league).toEqual({ win: 5000, draw: 2000, loss: 1000 });
    });

    it("연습 지급이 같은 결과의 리그 지급보다 엄격히 작다(승·무·패 전부)", () => {
      const { practice, league } = economy.rewards.byMode;
      expect(practice.win).toBeLessThan(league.win);
      expect(practice.draw).toBeLessThan(league.draw);
      expect(practice.loss).toBeLessThan(league.loss);
    });

    it("각 모드 안에서 승 > 무 > 패 순서가 유지된다", () => {
      for (const t of [economy.rewards.byMode.practice, economy.rewards.byMode.league]) {
        expect(t.win).toBeGreaterThan(t.draw);
        expect(t.draw).toBeGreaterThan(t.loss);
      }
    });
  });

  // #212: 뽑기 = 젬(유료 재화). 가입 젬이 정확히 10연차 2회분이어야 hero 요구("두 판")가 성립.
  describe("재화 이원화 — 뽑기 통화·가입 젬(#212)", () => {
    it("gacha.currency=GEM", () => {
      expect(economy.gacha.currency).toBe("GEM");
    });

    it("initialGems = tenCost × 2 (가입 시 10연차 두 판)", () => {
      expect(economy.initialGems).toBe(economy.gacha.tenCost * 2);
    });

    it("league.gemReward — 우승(1위)만, min ≤ max", () => {
      const g = economy.league.gemReward;
      expect(g.maxRank).toBe(1);
      expect(g.min).toBeLessThanOrEqual(g.max);
      expect(g.min).toBeGreaterThan(0);
    });
  });
});

/**
 * #209 스타터 개편 — economy 는 v3 로 **부분 버전업**된다. v2 는 발행물이라 손대지 않고
 * (아래 첫 테스트가 그걸 강제한다), v3 만 `starterTop` 블록을 얹는다.
 */
describe("economy.v3 — starterTop (#209 AC1)", () => {
  it("v2 는 불변 — starterTop 블록이 v2 에는 없다(발행물 동결)", () => {
    expect(economy.version).toBe("v2");
    expect(economy.starterTop).toBeUndefined();
  });

  it("v3 = v2 + starterTop (다른 블록은 전부 동일)", () => {
    expect(economyV3.version).toBe("v3");
    const { starterTop, version, ...restV3 } = economyV3;
    const { version: v2Version, ...restV2 } = economy;
    expect(starterTop).toBeDefined();
    expect(v2Version).toBe("v2");
    expect(restV3).toEqual(restV2);
  });

  it("pool 은 중복 없는 5명 — count=1 (가입 시 '후보 중 1장')", () => {
    const top = economyV3.starterTop!;
    expect(top.pool.length).toBe(5);
    expect(new Set(top.pool).size).toBe(5);
    expect(top.count).toBe(1);
    expect(top.count).toBeLessThanOrEqual(top.pool.length);
  });

  it("pool 전원이 카탈로그 실재 + 최상위 등급(LEGEND)", () => {
    const byId = new Map(players.map((p) => [p.id, p]));
    for (const id of economyV3.starterTop!.pool) {
      const p = byId.get(id);
      expect(p, `starterTop id ${id} exists in players`).toBeDefined();
      expect(p!.grade).toBe("LEGEND");
    }
  });

  /**
   * #207 이 구 pool 4종을 전원 비활성시켰다. 비활성 = **신규 획득 차단**이 정책이고 가입 지급은
   * 명백한 신규 획득이라, 비활성 유닛이 pool 에 남으면 정책을 정면으로 어긴다("도감엔 있는데
   * 아무리 뽑아도 안 나오는" 유닛을 가입 선물로 주는 꼴). 이 검사가 그 회귀를 막는다.
   */
  it("pool 전원이 **활성** 유닛 — 비활성은 신규 획득 차단 대상이라 지급 후보가 될 수 없다", () => {
    const activeById = new Map(playersV23.map((p) => [p.id, p.active]));
    for (const id of economyV3.starterTop!.pool) {
      expect(activeById.get(id), `${id} 는 현행 발행본(v2.3)에 있어야 한다`).toBeDefined();
      expect(activeById.get(id), `${id} 가 비활성이다 — pool 에서 빼거나 활성화해야 한다`).toBe(true);
    }
  });

  it("pool 과 기본팩은 서로소 — 최상위는 언제나 '기본 위에 얹히는 1장'", () => {
    const basics = new Set(economyV3.starterPack);
    for (const id of economyV3.starterTop!.pool) {
      expect(basics.has(id), `${id} must not be in starterPack`).toBe(false);
    }
  });

  it("기본팩은 SILVER/BRONZE 만 — 최상위는 오직 starterTop 경로로만 나온다", () => {
    const byId = new Map(players.map((p) => [p.id, p]));
    for (const id of economyV3.starterPack) {
      const grade = byId.get(id)!.grade;
      expect(grade === "SILVER" || grade === "BRONZE", `${id} grade ${grade}`).toBe(true);
    }
  });
});

describe("economy.v2 — 성장/강화 config (#179 §7, additive)", () => {
  const ATTR_KEYS = [
    "technical",
    "mental",
    "physical",
    "passing",
    "shooting",
    "tackling",
    "pace",
    "stamina",
    "positioning",
  ] as const;

  it("growth 블록 존재 + 스칼라 수치(V2 메이플 피벗, 이슈 V2-5)", () => {
    const g = economy.growth;
    expect(g).toBeDefined();
    expect(g.xpBase).toBe(100);
    expect(g.xpLvBase).toBe(100);
    expect(g.xpLvGrowth).toBe(1.7);
  });

  it("gradeXpMult — 5개 등급 전부 + hero 확정값(브/실 0.4·골 1.0·다 1.5·레 3.0)", () => {
    const m = economy.growth.gradeXpMult;
    expect(Object.keys(m).sort()).toEqual([...GRADES].sort());
    expect(m.BRONZE).toBe(0.4);
    expect(m.SILVER).toBe(0.4);
    expect(m.GOLD).toBe(1.0);
    expect(m.DIA).toBe(1.5);
    expect(m.LEGEND).toBe(3.0);
  });

  it("minutesMult — starter 1.0 / partial 0.5 / bench 0 (미출전 XP=0, V2-1①)", () => {
    const m = economy.growth.minutesMult;
    expect(m.starter).toBe(1.0);
    expect(m.partial).toBe(0.5);
    expect(m.bench).toBe(0);
  });

  it("eventStatMap — 7종 이벤트 전부 존재 + 스탯 가중 양수", () => {
    const e = economy.growth.eventStatMap;
    const expectedEvents = ["goal", "shot", "pass", "interception", "tackle", "save", "dribble"];
    expect(Object.keys(e).sort()).toEqual([...expectedEvents].sort());
    for (const key of expectedEvents) {
      const bonus = e[key];
      expect(bonus, `${key} 존재`).toBeDefined();
      if (!bonus) continue;
      expect(Object.keys(bonus).length, `${key} 가중 ≥1개`).toBeGreaterThan(0);
      for (const [stat, w] of Object.entries(bonus)) {
        expect(w, `${key}.${stat} > 0`).toBeGreaterThan(0);
      }
    }
    expect(e.goal).toEqual({ shooting: 0.3, positioning: 0.1 }); // M2: baseline 스케일 정합(#179 gverify)
    expect(e.save).toEqual({ positioning: 0.3, mental: 0.1 }); // M2 스케일
  });

  it("baselineByPosition — 4포지션 전부 존재 · 9종 능력치 완비 · 각 값 양수", () => {
    const b = economy.growth.baselineByPosition;
    for (const pos of POSITIONS) {
      const vec = b[pos];
      expect(vec, `${pos} baseline 존재`).toBeDefined();
      const keys = Object.keys(vec).sort();
      expect(keys, `${pos} 능력치 9종`).toEqual([...ATTR_KEYS].sort());
      for (const k of ATTR_KEYS) {
        expect(vec[k], `${pos}.${k} > 0`).toBeGreaterThan(0);
      }
    }
  });

  it("각 baseline 벡터 합 = 1.0 (정규화)", () => {
    const b = economy.growth.baselineByPosition;
    for (const pos of POSITIONS) {
      const sum = ATTR_KEYS.reduce((s, k) => s + b[pos][k], 0);
      expect(sum, `${pos} 벡터 합=1`).toBeCloseTo(1, 10);
    }
  });

  it("포지션 주스탯이 성장 방향 최대치(baseline 최상위)", () => {
    // 성장 방향은 포지션 주스탯을 가장 크게 밀어야 한다(§4 방향 w).
    const b = economy.growth.baselineByPosition;
    const topOf = (pos: Position) =>
      ATTR_KEYS.reduce((best, k) => (b[pos][k] > b[pos][best] ? k : best), ATTR_KEYS[0]);
    expect(topOf("FW")).toBe("shooting");
    expect(topOf("MF")).toBe("passing");
    expect(topOf("DF")).toBe("tackling");
    expect(topOf("GK")).toBe("positioning");
  });

  it("구 enhance 블록 제거됨(V2 메이플 피벗 — 강화 폐기)", () => {
    expect((economy as unknown as Record<string, unknown>).enhance).toBeUndefined();
  });

  describe("star — ★ 승급(중복) config (V2-5)", () => {
    it("copies — 누진(2★<3★<4★), hero 확정값(2/3/5)", () => {
      const c = economy.star.copies;
      expect(c["2"]).toBe(2);
      expect(c["3"]).toBe(3);
      expect(c["4"]).toBe(5);
      expect(c["2"]).toBeLessThan(c["3"]);
      expect(c["3"]).toBeLessThan(c["4"]);
    });

    it("starFrac — 1★→4★ 단조 증가, 4★=1.0(밴드 상한 완전 개방)", () => {
      const f = economy.star.starFrac;
      expect(f["1"]).toBe(0.25);
      expect(f["2"]).toBe(0.5);
      expect(f["3"]).toBe(0.75);
      expect(f["4"]).toBe(1.0);
      expect(f["1"]).toBeLessThan(f["2"]);
      expect(f["2"]).toBeLessThan(f["3"]);
      expect(f["3"]).toBeLessThan(f["4"]);
    });
  });

  describe("potential — 잠재능력 config (V2-5, 안 ㄴ 성 게이트형)", () => {
    it("linesByGrade — 브/실 1줄 · 골 2줄 · 다/레 3줄", () => {
      const l = economy.potential.linesByGrade;
      expect(l.BRONZE).toBe(1);
      expect(l.SILVER).toBe(1);
      expect(l.GOLD).toBe(2);
      expect(l.DIA).toBe(3);
      expect(l.LEGEND).toBe(3);
    });

    it("gradeTierCap × starTierCap 매트릭스(AC-V5) — 골드=EPIC·다이아 이상=UNIQUE, 성 캡 정확", () => {
      const g = economy.potential.gradeTierCap;
      expect(g.BRONZE).toBe("RARE");
      expect(g.SILVER).toBe("RARE");
      expect(g.GOLD).toBe("EPIC");
      expect(g.DIA).toBe("UNIQUE");
      expect(g.LEGEND).toBe("UNIQUE");

      const s = economy.potential.starTierCap;
      expect(s["2"]).toBe("RARE");
      expect(s["3"]).toBe("EPIC");
      expect(s["4"]).toBe("UNIQUE");
    });

    it("tierUp 확률 — 0~1 구간, 상위 승급일수록 낮음(레어→에픽 6% > 에픽→유니크 1.8%)", () => {
      const t = economy.potential.tierUp;
      expect(t.rareToEpic).toBeGreaterThan(0);
      expect(t.rareToEpic).toBeLessThan(1);
      expect(t.epicToUnique).toBeGreaterThan(0);
      expect(t.epicToUnique).toBeLessThan(1);
      expect(t.epicToUnique).toBeLessThan(t.rareToEpic);
    });

    it("breakout — V2.1-1 폐기(전줄 동일 티어로 의미 소멸) — 필드 부재", () => {
      expect(economy.potential).not.toHaveProperty("breakout");
    });

    it("ceilingMult·cashPremiumMult > 0", () => {
      expect(economy.potential.ceilingMult).toBeGreaterThan(0);
      expect(economy.potential.cashPremiumMult).toBeGreaterThan(0);
    });

    it("tables — RARE/EPIC/UNIQUE 3티어 전부 비어있지 않고, weight > 0", () => {
      const tables = economy.potential.tables;
      for (const tier of ["RARE", "EPIC", "UNIQUE"] as const) {
        const rows = tables[tier];
        expect(rows.length, `${tier} 비어있지 않음`).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.weight, `${tier} ${row.type}${row.stat ? "." + row.stat : ""} weight>0`).toBeGreaterThan(0);
          expect(row.value, `${tier} ${row.type} value>0`).toBeGreaterThan(0);
        }
      }
    });

    it("tables — STAT_PCT/STAT_FLAT 이 9종 스탯 전부 커버(각 티어)", () => {
      const attrKeys = [
        "technical", "mental", "physical", "passing", "shooting",
        "tackling", "pace", "stamina", "positioning",
      ] as const;
      for (const tier of ["RARE", "EPIC", "UNIQUE"] as const) {
        const rows = economy.potential.tables[tier];
        for (const type of ["STAT_PCT", "STAT_FLAT"] as const) {
          const stats = new Set(rows.filter((r) => r.type === type).map((r) => r.stat));
          expect([...stats].sort(), `${tier}.${type} 9종 스탯`).toEqual([...attrKeys].sort());
        }
      }
    });

    it("tables — 상위 티어일수록 STAT_PCT premium 값이 큼(레어<에픽<유니크)", () => {
      const maxPct = (tier: "RARE" | "EPIC" | "UNIQUE") =>
        Math.max(
          ...economy.potential.tables[tier]
            .filter((r) => r.type === "STAT_PCT")
            .map((r) => r.value),
        );
      expect(maxPct("RARE")).toBeLessThan(maxPct("EPIC"));
      expect(maxPct("EPIC")).toBeLessThan(maxPct("UNIQUE"));
    });

    it("tables — CONDITION_RECOVERY·TEAM_MORALE 부재(M3 #179 gverify: 서버 효과 배선 전까지 제외)", () => {
      for (const tier of ["RARE", "EPIC", "UNIQUE"] as const) {
        const rows = economy.potential.tables[tier];
        expect(rows.filter((r) => r.type === "CONDITION_RECOVERY").length).toBe(0);
        expect(rows.filter((r) => r.type === "TEAM_MORALE").length).toBe(0);
      }
    });

    describe("V2.1-2 — 4스텝+가중 옵션 테이블(롤 편차 확대)", () => {
      const stepsWeights = {
        RARE: { steps: [1, 2, 3, 4], weights: [40, 30, 20, 10] },
        EPIC: { steps: [4, 5, 6, 8], weights: [35, 30, 25, 10] },
        UNIQUE: { steps: [8, 10, 12, 15], weights: [35, 30, 25, 10] },
      } as const;
      it.each(["RARE", "EPIC", "UNIQUE"] as const)(
        "%s — STAT_PCT/STAT_FLAT 각 스탯 4스텝, 값·weight 가 스펙과 정확히 일치",
        (tier) => {
          const rows = economy.potential.tables[tier];
          const { steps, weights } = stepsWeights[tier];
          for (const type of ["STAT_PCT", "STAT_FLAT"] as const) {
            for (const stat of [
              "technical", "mental", "physical", "passing", "shooting",
              "tackling", "pace", "stamina", "positioning",
            ] as const) {
              const optRows = rows
                .filter((r) => r.type === type && r.stat === stat)
                .sort((a, b) => a.value - b.value);
              expect(optRows.map((r) => r.value), `${tier}.${type}.${stat} 값`).toEqual([...steps]);
              expect(optRows.map((r) => r.weight), `${tier}.${type}.${stat} weight`).toEqual([...weights]);
            }
          }
        },
      );

      it.each(["RARE", "EPIC", "UNIQUE"] as const)("%s — STAT 계열 weight 합 = 100(4스텝)", (tier) => {
        const { weights } = stepsWeights[tier];
        expect(weights.reduce((a, b) => a + b, 0)).toBe(100);
      });

      it("티어 바닥 = 아래 티어 천장(승급 체감 상승) — EPIC 최소=RARE 최대, UNIQUE 최소=EPIC 최대", () => {
        expect(stepsWeights.EPIC.steps[0]).toBe(stepsWeights.RARE.steps[3]);
        expect(stepsWeights.UNIQUE.steps[0]).toBe(stepsWeights.EPIC.steps[3]);
        // 실제 생성 데이터로도 동일 불변식 확인(스펙 하드코딩이 아니라 산출물 검증).
        const maxOf = (tier: "RARE" | "EPIC", type: "STAT_PCT" | "STAT_FLAT") =>
          Math.max(...economy.potential.tables[tier].filter((r) => r.type === type).map((r) => r.value));
        const minOf = (tier: "EPIC" | "UNIQUE", type: "STAT_PCT" | "STAT_FLAT") =>
          Math.min(...economy.potential.tables[tier].filter((r) => r.type === type).map((r) => r.value));
        for (const type of ["STAT_PCT", "STAT_FLAT"] as const) {
          expect(minOf("EPIC", type)).toBe(maxOf("RARE", type));
          expect(minOf("UNIQUE", type)).toBe(maxOf("EPIC", type));
        }
      });

      it("premium — STAT_PCT/STAT_FLAT 은 상위 2스텝(3·4번째)만 premium, 하위 2스텝은 아님", () => {
        for (const tier of ["RARE", "EPIC", "UNIQUE"] as const) {
          for (const type of ["STAT_PCT", "STAT_FLAT"] as const) {
            const optRows = economy.potential.tables[tier]
              .filter((r) => r.type === type && r.stat === "technical")
              .sort((a, b) => a.value - b.value);
            expect(optRows.map((r) => r.premium), `${tier}.${type}.technical premium 순서`).toEqual([
              false,
              false,
              true,
              true,
            ]);
          }
        }
      });

    });
  });

  describe("dice — 다이스 상점 config (V2-5, V2.2 재화 이원화 개정)", () => {
    // #212: 노말은 골드 싱크라 리그 수입 ×10 에 맞춰 5000 으로 상향. 캐시는 젬 경제라 무변경.
    it("normalCost=5000(P) · cashGemCost=10(젬), 구 cashCost(P) 필드는 부재", () => {
      const d = economy.dice as unknown as Record<string, unknown>;
      expect(d.normalCost).toBe(5000);
      expect(d.cashGemCost).toBe(10);
      expect(d.normalCost as number).toBeGreaterThan(0);
      expect(d.cashGemCost as number).toBeGreaterThan(0);
      expect(d.cashCost).toBeUndefined();
    });
  });

  describe("gems — 충전형 젬 상점 config (V2.2 재화 이원화)", () => {
    it("topupPacks 3종: id 유일 · gems>0 · mockPrice 문자열", () => {
      const packs = economy.gems.topupPacks;
      expect(packs.length).toBe(3);
      const ids = packs.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of packs) {
        expect(p.gems).toBeGreaterThan(0);
        expect(typeof p.mockPrice).toBe("string");
        expect(p.mockPrice.length).toBeGreaterThan(0);
      }
    });

    it("팩이 클수록 젬이 많다(단조 증가, 오름차순 시드 순서 가정)", () => {
      const packs = economy.gems.topupPacks;
      for (let i = 1; i < packs.length; i++) {
        expect(packs[i].gems).toBeGreaterThan(packs[i - 1].gems);
      }
    });
  });
});

describe("bots.v2 — 덱 유효성(서버 규칙: 11명·GK≥1·중복 금지)", () => {
  const byId = new Map<string, PlayerSeed>(players.map((p) => [p.id, p]));

  it("봇 3종 존재: BOT_ATK/BOT_DEF/BOT_BAL", () => {
    expect(bots.map((b) => b.id).sort()).toEqual(["BOT_ATK", "BOT_BAL", "BOT_DEF"]);
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 선발 11명 + 벤치 4명, 중복 없음", (botId) => {
    const bot = bots.find((b) => b.id === botId);
    expect(bot).toBeDefined();
    if (!bot) return;
    expect(bot.deck.starters.length).toBe(11);
    expect(bot.deck.bench.length).toBe(4);

    const allIds = [...bot.deck.starters.map((s) => s.playerId), ...bot.deck.bench];
    expect(new Set(allIds).size).toBe(15);
    for (const id of allIds) {
      expect(byId.get(id), `${botId} 선수 ${id} exists`).toBeDefined();
    }
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 선발에 GK 최소 1명", (botId) => {
    const bot = bots.find((b) => b.id === botId);
    if (!bot) return;
    const gkCount = bot.deck.starters.filter((s) => byId.get(s.playerId)?.position === "GK")
      .length;
    expect(gkCount).toBeGreaterThanOrEqual(1);
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])(
    "%s: DIA/LEGEND 미편성 — 상위 등급은 가챠 열망 카드로 예약",
    (botId) => {
      const bot = bots.find((b) => b.id === botId);
      if (!bot) return;
      const allIds = [...bot.deck.starters.map((s) => s.playerId), ...bot.deck.bench];
      for (const id of allIds) {
        const g = byId.get(id)!.grade;
        expect(RANK[g], `${botId} ${id} ${g} ≤ GOLD`).toBeLessThanOrEqual(RANK.GOLD);
      }
    },
  );

  it("BOT_ATK: FW 2명에 promptText('적극 침투') 부여", () => {
    const bot = bots.find((b) => b.id === "BOT_ATK");
    expect(bot).toBeDefined();
    if (!bot) return;
    const promptedFw = bot.deck.starters.filter(
      (s) => byId.get(s.playerId)?.position === "FW" && s.promptText === "적극 침투",
    );
    expect(promptedFw.length).toBe(2);
  });

  it("BOT_ATK: 미드필더/공격수가 GOLD 위주", () => {
    const bot = bots.find((b) => b.id === "BOT_ATK");
    expect(bot).toBeDefined();
    if (!bot) return;
    const mfFw = bot.deck.starters.filter((s) => {
      const pos = byId.get(s.playerId)?.position;
      return pos === "MF" || pos === "FW";
    });
    const goldUp = mfFw.filter((s) => RANK[byId.get(s.playerId)!.grade] >= RANK.GOLD);
    expect(goldUp.length).toBe(mfFw.length);
  });

  it("BOT_DEF: 수비수가 GOLD 위주", () => {
    const bot = bots.find((b) => b.id === "BOT_DEF");
    expect(bot).toBeDefined();
    if (!bot) return;
    const df = bot.deck.starters.filter((s) => byId.get(s.playerId)?.position === "DF");
    const goldUp = df.filter((s) => RANK[byId.get(s.playerId)!.grade] >= RANK.GOLD);
    expect(goldUp.length).toBe(df.length);
  });

  it("BOT_BAL: 등급 혼합·실버 중심(LLD §4) — SILVER 과반 + BRONZE≥1 + GOLD 1~2, DIA/LEGEND 없음", () => {
    const bot = bots.find((b) => b.id === "BOT_BAL");
    expect(bot).toBeDefined();
    if (!bot) return;
    const counts: Record<Grade, number> = { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 };
    for (const s of bot.deck.starters) {
      const p = byId.get(s.playerId);
      expect(p, s.playerId).toBeDefined();
      if (p) counts[p.grade]++;
    }
    expect(counts.SILVER, "실버 과반(중심)").toBeGreaterThan(11 / 2);
    expect(counts.BRONZE, "혼합 — 브론즈 포함").toBeGreaterThanOrEqual(1);
    expect(counts.GOLD, "혼합 — 골드 1~2(첫 승리 가능 수준)").toBeGreaterThanOrEqual(1);
    expect(counts.GOLD).toBeLessThanOrEqual(2);
    expect(counts.DIA + counts.LEGEND, "고등급 없음(비등한 전력)").toBe(0);
  });
});

describe("players.v2.1 — personality 부여 (PRD-v3 P2-D7, additive)", () => {
  it(`v2.1 은 동결 ${FROZEN_TOTAL}명 — v2 와 동일 개수(신규 8종은 v2.2 로만 발행)`, () => {
    expect(playersV21.length).toBe(FROZEN_TOTAL);
    expect(playersV2.length).toBe(FROZEN_TOTAL);
  });

  it("v2.1 = v2 필드 완전 동일 + personality 만 additive(id/name/position/grade/attributes 무변경)", () => {
    playersV21.forEach((p, i) => {
      const base = playersV2[i]!;
      expect(p.id).toBe(base.id);
      expect(p.name).toBe(base.name);
      expect(p.position).toBe(base.position);
      expect(p.grade).toBe(base.grade);
      expect(p.attributes).toEqual(base.attributes);
      // personality 를 뺀 나머지가 v2 와 정확히 같아야 한다(순수 additive).
      const { personality, ...rest } = p;
      expect(rest).toEqual(base);
      expect(personality).toBeDefined();
    });
  });

  it("모든 personality 가 4종 enum(FIERY/CALM/GLASS/AMBITIOUS) 내", () => {
    for (const p of playersV22) {
      expect(PERSONALITIES, `${p.id}:${p.name} personality`).toContain(p.personality);
    }
  });

  it("PERSONALITY 매핑 ↔ ROSTER 이름 전단사(bijection) — 누락/잉여 0", () => {
    const rosterNames = new Set(ROSTER.map((r) => r.name));
    const mapNames = new Set(Object.keys(PERSONALITY));
    // 모든 로스터 선수가 매핑을 가진다.
    for (const n of rosterNames) expect(mapNames.has(n), `매핑 누락: ${n}`).toBe(true);
    // 매핑에 로스터 밖 이름(오타 등)이 없다.
    for (const n of mapNames) expect(rosterNames.has(n), `로스터 밖 매핑 키: ${n}`).toBe(true);
    expect(mapNames.size).toBe(TOTAL);
  });

  it("분포가 목표 밴드 내 — 대략 FIERY25/CALM40/GLASS15/AMBITIOUS20 (%)", () => {
    const counts: Record<Personality, number> = { FIERY: 0, CALM: 0, GLASS: 0, AMBITIOUS: 0 };
    for (const p of playersV22) counts[p.personality]++;
    for (const k of PERSONALITIES) {
      const ratio = counts[k] / TOTAL;
      const [lo, hi] = PERSONALITY_BANDS[k];
      expect(ratio, `${k} 비율 ${(ratio * 100).toFixed(1)}% in [${lo * 100},${hi * 100}]%`).toBeGreaterThanOrEqual(lo);
      expect(ratio, `${k} 비율`).toBeLessThanOrEqual(hi);
    }
  });

  it("CALM 이 최다(기본 성격) — 나머지 3종보다 많다", () => {
    const counts: Record<Personality, number> = { FIERY: 0, CALM: 0, GLASS: 0, AMBITIOUS: 0 };
    for (const p of playersV22) counts[p.personality]++;
    expect(counts.CALM).toBeGreaterThan(counts.FIERY);
    expect(counts.CALM).toBeGreaterThan(counts.AMBITIOUS);
    expect(counts.CALM).toBeGreaterThan(counts.GLASS);
  });

  it("큐레이션 대표 선수 성격 고정(회귀 가드)", () => {
    const byName = new Map(playersV22.map((p) => [p.name, p.personality]));
    expect(byName.get("Toni Kroos")).toBe("CALM");
    expect(byName.get("Antonio Rüdiger")).toBe("FIERY");
    expect(byName.get("Marcus Rashford")).toBe("GLASS");
    expect(byName.get("Erling Haaland")).toBe("AMBITIOUS");
    expect(byName.get("Park Ji-sung")).toBe("AMBITIOUS");
    expect(byName.get("Son Heung-min")).toBe("CALM");
  });

  it("신규 8종 성격 = 소스 선수 성격 복제(원본 없는 2종은 §8.1 기준 배정)", () => {
    // U-D4 표는 traits 까지만 확정했다 → personality 는 "소스 선수 것을 그대로 복제"라는
    // 규칙으로 파생하고 여기서 못 박는다(임의 드리프트 차단).
    const byName = new Map(playersV22.map((p) => [p.name, p.personality]));
    expect(byName.get("유라도나"), "마라도나(P005 FIERY) 복제").toBe("FIERY");
    expect(byName.get("춘바페"), "음바페(AMBITIOUS) 복제").toBe("AMBITIOUS");
    expect(byName.get("덕브라이너"), "데브라위너(FIERY) 복제").toBe("FIERY");
    expect(byName.get("석신"), "야신(P001 CALM) 복제").toBe("CALM");
    expect(byName.get("욱리엄"), "벨링엄(FIERY) 복제").toBe("FIERY");
    expect(byName.get("경니시우스"), "비니시우스(FIERY) 복제").toBe("FIERY");
    // 로스터에 소스가 없는 2종 = §8.1 기준 신규 배정(U-D2 와 같은 방식).
    expect(byName.get("보날두"), "CR7 = 기록·승부욕 지향").toBe("AMBITIOUS");
    expect(byName.get("권씨"), "메시 = 압박에도 흔들리지 않는 안정형").toBe("CALM");
  });
});

describe("players.v2.2 — 신규 LEGEND 8종 + active 축 (#207 U-D1/U-D4)", () => {
  const byId = new Map(playersV22.map((p) => [p.id, p]));

  it(`v2.2 = ${V23_TOTAL}명 (동결 ${FROZEN_TOTAL} + 신규 8)`, () => {
    expect(playersV22.length).toBe(V23_TOTAL);
  });

  it("신규 8종이 P173~P180 신규 채번 — 기존 P-공간 재사용 0", () => {
    expect(NEW_UNITS.map((u) => u.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `P${String(FROZEN_TOTAL + i + 1).padStart(3, "0")}`),
    );
    playersV22.slice(FROZEN_TOTAL).forEach((p, i) => {
      expect(p.id).toBe(NEW_UNITS[i]!.id);
      expect(p.name).toBe(NEW_UNITS[i]!.name);
    });
  });

  it("신규 8종 = 전원 LEGEND, 포지션 GK1/MF3/FW4 (U-D4 표 그대로)", () => {
    const counts: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const u of NEW_UNITS) {
      const p = byId.get(u.id)!;
      expect(p.grade, `${u.id} 등급`).toBe("LEGEND");
      expect(p.position, `${u.id} 포지션`).toBe(u.position);
      counts[p.position]++;
    }
    expect(counts).toEqual({ GK: 1, DF: 0, MF: 3, FW: 4 });
  });

  it("신규 8종 traits 가 스탯에 반영된다 — trait 스탯 ≥ 밴드하한+6(밴드 상한 클램프 안)", () => {
    const [lo, hi] = BANDS.LEGEND;
    for (const u of NEW_UNITS) {
      const p = byId.get(u.id)!;
      for (const key of u.traits) {
        const v = p.attributes[key];
        expect(v, `${u.id} trait ${key}`).toBeGreaterThanOrEqual(lo + 6);
        expect(v, `${u.id} trait ${key} 밴드 상한`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("LEGEND 총원 22 = 구 14(등급 유지) + 신규 8", () => {
    const legend = playersV22.filter((p) => p.grade === "LEGEND");
    expect(legend).toHaveLength(22);
    expect(legend.filter((p) => p.active === false)).toHaveLength(14);
    expect(legend.filter((p) => p.active === true)).toHaveLength(8);
  });

  it("active:false 가 정확히 14개이고 집합이 P001~P012 + P143 + P144 와 일치", () => {
    const inactive = playersV22.filter((p) => p.active === false).map((p) => p.id);
    expect(inactive).toHaveLength(14);
    expect(new Set(inactive)).toEqual(new Set(INACTIVE_IDS));
  });

  it("LEGEND 중 active:true 는 정확히 8개(=신규분) — 가챠/트레이드 획득 가능 LEGEND", () => {
    const activeLegend = playersV22.filter((p) => p.grade === "LEGEND" && p.active).map((p) => p.id);
    expect(activeLegend).toEqual(NEW_UNITS.map((u) => u.id));
  });

  it("구 14종은 강등이 아니다 — 등급 LEGEND 유지 + 밴드 무변경(기보유 유저 손실 0)", () => {
    const [lo, hi] = BANDS.LEGEND;
    for (const id of INACTIVE_IDS) {
      const p = byId.get(id)!;
      expect(p.grade, `${id} 등급 유지`).toBe("LEGEND");
      for (const v of Object.values(p.attributes)) {
        expect(v).toBeGreaterThanOrEqual(lo);
        expect(v).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("비활성 14종을 뺀 전원이 active:true (기본값 = 획득 가능)", () => {
    const inactive = new Set(INACTIVE_IDS);
    for (const p of playersV22) {
      expect(p.active, `${p.id} active`).toBe(!inactive.has(p.id));
    }
  });

  it("v2.2 = v2.1 필드 + active 만 끝에 append(필드 순서·기존 값 무변경)", () => {
    for (const p of playersV22) {
      expect(Object.keys(p)).toEqual([
        "id",
        "name",
        "position",
        "grade",
        "attributes",
        "personality",
        "active",
      ]);
    }
  });
});

describe("players.v2.3 — 유닛명 정정 + 활성 5/비활성 3 (#207 U-D5/U-D6)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const byId = new Map(playersV23.map((p) => [p.id, p]));
  /** 디스크의 **발행된** v2.2 — 대조 기준을 코드가 아니라 파일에서 가져온다(자기참조 회피). */
  const diskV22 = JSON.parse(readFileSync(join(here, "players.v2.2.json"), "utf8")) as {
    id: string;
    name: string;
    position: Position;
    grade: Grade;
    attributes: PlayerSeed["attributes"];
    personality: Personality;
    active: boolean;
  }[];

  // ── U-D6 이름 정정 ────────────────────────────────────────────────
  it("유닛명 정정 2건 반영 — P175 열라도나 · P179 욱링엄(아트가 정본)", () => {
    for (const r of V23_RENAMES) {
      expect(byId.get(r.id)?.name, `${r.id} v2.3 이름`).toBe(r.after);
      // v2.2 발행물은 정정 전 이름 그대로여야 한다(동결 — ROSTER 를 고치면 여기가 터진다).
      expect(diskV22.find((p) => p.id === r.id)?.name, `${r.id} v2.2 발행물 이름`).toBe(r.before);
    }
  });

  it("정정 대상 외 178명 이름은 v2.2 와 동일 — 개명이 새어 나가지 않는다", () => {
    const renamed = new Set(V23_RENAMES.map((r) => r.id));
    playersV23.forEach((p, i) => {
      if (renamed.has(p.id)) return;
      expect(p.name, `${p.id} 이름 무변경`).toBe(diskV22[i]!.name);
    });
  });

  it("정정 후에도 이름 유일 + 한글 패러디명 + 실명 denylist 0 (실명 유입 차단 유지)", () => {
    expect(new Set(playersV23.map((p) => p.name)).size).toBe(V23_TOTAL);
    for (const r of V23_RENAMES) {
      const name = byId.get(r.id)!.name;
      expect(name, `${r.id} 한글 전용 패러디명`).toMatch(/^[가-힣]{2,}$/);
      for (const banned of PARODY_REAL_NAME_KO_DENYLIST) {
        expect(name.includes(banned), `${r.id} 실명 "${banned}" 포함 금지`).toBe(false);
      }
    }
  });

  // ── U-D6 핵심 증명: 이름은 attributes 를 흔들지 않는다 ──────────────
  it("이름 정정이 attributes 를 안 흔든다 ① — P173~P180 9종이 디스크 v2.2 와 바이트 동일", () => {
    // 이름 변경이 RNG 스트림을 건드렸다면 신규 8종(정정 대상 포함)의 스탯이 먼저 어긋난다.
    const newV23 = playersV23.slice(FROZEN_TOTAL).map((p) => p.attributes);
    const newV22 = diskV22.slice(FROZEN_TOTAL).map((p) => p.attributes);
    expect(newV23).toHaveLength(8);
    expect(JSON.stringify(newV23, null, 2)).toBe(JSON.stringify(newV22, null, 2));
  });

  it("이름 정정이 attributes 를 안 흔든다 ② — 180명 전원 9종이 디스크 v2.2 와 바이트 동일", () => {
    expect(JSON.stringify(playersV23.map((p) => p.attributes), null, 2)).toBe(
      JSON.stringify(diskV22.map((p) => p.attributes), null, 2),
    );
  });

  it("이름 정정이 attributes 를 안 흔든다 ③ — 로스터 이름을 전부 뒤바꿔 재파생해도 9종 동일", () => {
    // ①②는 "안 바뀌었다"는 관측이다. 여기서는 **이름 축이 애초에 입력이 아니다**를 능동 증명한다:
    // rollAttributes(rng, grade, position, traits) 에 이름 파라미터가 없으므로, 로스터 이름을
    // 전부 다른 문자열로 갈아엎고 같은 시드로 재파생해도 결과가 동일해야 한다.
    const mutated = ROSTER.map((r, i) => ({ ...r, name: `MUT-${i}-${[...r.name].reverse().join("")}` }));
    expect(mutated.every((r, i) => r.name !== ROSTER[i]!.name)).toBe(true);
    const rng = createRng(SEED);
    const derived = mutated.map((r) => rollAttributes(rng, r.grade, r.position, r.traits));
    // 대조는 **전체 카탈로그(v2.4)** 로 한다 — ROSTER 전원을 재파생했으므로 180 경계에서 자르면
    // 신규 채번분이 증명 밖으로 빠진다(#256).
    expect(JSON.stringify(derived, null, 2)).toBe(
      JSON.stringify(playersV24.map((p) => p.attributes), null, 2),
    );
  });

  // ── U-D5 활성 5 / 비활성 3 ─────────────────────────────────────────
  it("active:false 가 정확히 17개이고 집합이 P001~P012 + P143 + P144 + P174·P178·P180 과 일치", () => {
    const inactive = playersV23.filter((p) => p.active === false).map((p) => p.id);
    expect(inactive).toHaveLength(17);
    expect(new Set(inactive)).toEqual(new Set(INACTIVE_IDS_V23));
  });

  it("LEGEND 중 active:true 는 정확히 5개 = P173·P175·P176·P177·P179 (가챠 등장 LEGEND)", () => {
    const activeLegend = playersV23
      .filter((p) => p.grade === "LEGEND" && p.active)
      .map((p) => p.id);
    expect(activeLegend).toEqual(V23_ACTIVE_LEGEND_IDS);
    // 이름으로도 못 박는다 — id 만 맞고 개명이 안 됐으면 여기서 걸린다.
    expect(activeLegend.map((id) => byId.get(id)!.name)).toEqual([
      "보날두",
      "열라도나",
      "춘바페",
      "덕브라이너",
      "욱링엄",
    ]);
  });

  it("비활성 신규 3종(권씨·석신·경니시우스)은 시드에 **남아 있다** — 삭제가 아니라 플래그", () => {
    const expected = [
      { id: "P174", name: "권씨" },
      { id: "P178", name: "석신" },
      { id: "P180", name: "경니시우스" },
    ];
    for (const e of expected) {
      const p = byId.get(e.id);
      expect(p, `${e.id} 존재`).toBeDefined();
      expect(p!.name).toBe(e.name);
      expect(p!.grade, `${e.id} 등급 유지`).toBe("LEGEND");
      expect(p!.active, `${e.id} 비활성`).toBe(false);
    }
  });

  it("구 LEGEND 14종은 v2.2 그대로 비활성 유지(무변경)", () => {
    for (const id of INACTIVE_IDS) {
      expect(byId.get(id)!.active, `${id} active`).toBe(false);
      expect(byId.get(id)!.grade, `${id} 등급`).toBe("LEGEND");
    }
  });

  it("비활성 17종을 뺀 163명이 active:true", () => {
    const inactive = new Set(INACTIVE_IDS_V23);
    for (const p of playersV23) expect(p.active, `${p.id} active`).toBe(!inactive.has(p.id));
    expect(playersV23.filter((p) => p.active)).toHaveLength(V23_TOTAL - 17);
  });

  // ── 축 무변경(활성 여부는 등급/포지션 축과 독립) ──────────────────
  it(`총원 ${V23_TOTAL} · LEGEND 22 · 등급/포지션 분포 무변경`, () => {
    expect(playersV23).toHaveLength(V23_TOTAL);
    const grades: Record<Grade, number> = { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 };
    const positions: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const p of playersV23) {
      grades[p.grade]++;
      positions[p.position]++;
    }
    expect(grades).toEqual(V23_GRADE_TOTALS);
    expect(grades.LEGEND).toBe(22);
    expect(positions).toEqual(V23_POSITION_TOTALS);
  });

  it("v2.3 = v2.2 와 스키마 동일 — 필드 순서/개수 무변경(신설 필드 0)", () => {
    for (const p of playersV23) {
      expect(Object.keys(p)).toEqual([
        "id",
        "name",
        "position",
        "grade",
        "attributes",
        "personality",
        "active",
      ]);
    }
  });

  it("id/position/grade/personality 가 디스크 v2.2 와 필드 단위로 동일(바뀐 축은 name·active 뿐)", () => {
    playersV23.forEach((p, i) => {
      const old = diskV22[i]!;
      expect(p.id, `#${i} id`).toBe(old.id);
      expect(p.position, `${old.id} position`).toBe(old.position);
      expect(p.grade, `${old.id} grade`).toBe(old.grade);
      expect(p.personality, `${old.id} personality`).toBe(old.personality);
    });
  });

  it("앞 172명이 디스크 players.v2.1.json 과 바이트 동일(active 제외) — 동결 경계 불변", () => {
    const onDisk = readFileSync(join(here, "players.v2.1.json"), "utf8");
    const head = playersV23.slice(0, FROZEN_TOTAL).map(({ active, ...rest }) => rest);
    expect(JSON.stringify(head, null, 2) + "\n").toBe(onDisk);
  });

  it("economy 등급 축 무변경 — v2.3 도 등급 밴드·확률표를 건드리지 않는다 (U-D1 조합안 유지)", () => {
    expect(economy.gacha.rates).toEqual({
      BRONZE: 0.45,
      SILVER: 0.3,
      GOLD: 0.15,
      DIA: 0.08,
      LEGEND: 0.02,
    });
    expect(economy.growth.gradeXpMult).toEqual({
      BRONZE: 0.4,
      SILVER: 0.4,
      GOLD: 1.0,
      DIA: 1.5,
      LEGEND: 3.0,
    });
    expect(economy.trade.waitHours.LEGEND).toBe(72);
    // #212 재화 정돈이 byGrade·attrSumCoeff 를 함께 ×10 했다(카드 대 카드 비율은 불변, 환율만 이동).
    // 그 커밋이 생성기만 올리고 이 기대값을 놓쳐 main 이 red 였다 — 리스케일이 의도이므로 값을 맞춘다.
    expect(economy.trade.value.byGrade.LEGEND).toBe(30000);
    expect(economy.trade.targetRarityWeights.LEGEND).toBe(0.05);
    expect(economy.potential.linesByGrade.LEGEND).toBe(3);
    expect(economy.potential.gradeTierCap.LEGEND).toBe("UNIQUE");
  });

  it("발행물 v2.2 는 여전히 재현된다 — v2.3 추가가 과거 발행 축을 흔들지 않았다", () => {
    const onDisk = readFileSync(join(here, "players.v2.2.json"), "utf8");
    expect(onDisk).toBe(JSON.stringify(playersV22, null, 2) + "\n");
  });
});

describe("players.v2.4 — 신규 LEGEND 2종 채번 (#256 석다이크·오시야스)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const byId = new Map(playersV24.map((p) => [p.id, p]));
  const diskV23 = JSON.parse(readFileSync(join(here, "players.v2.3.json"), "utf8")) as {
    id: string;
    name: string;
    position: Position;
    grade: Grade;
    attributes: PlayerSeed["attributes"];
    personality: Personality;
    active: boolean;
  }[];

  // ── 이게 이 작업의 진짜 게이트: 과거 발행 축이 안 흔들렸나 ──────────────
  it(`앞 ${V23_TOTAL}행이 디스크 players.v2.3.json 과 **바이트 동일** — append 가 RNG 스트림을 밀지 않았다`, () => {
    // ROSTER 중간 삽입이면 180명 attributes 가 전부 shift 되어 기보유 유저 카드가 통째로 바뀐다.
    // 발행 파일과 직접 대조해 원천 차단한다(v2.2 가 v2.1 을 대하는 방식과 동일).
    const onDisk = readFileSync(join(here, "players.v2.3.json"), "utf8");
    expect(JSON.stringify(playersV24.slice(0, V23_TOTAL), null, 2) + "\n").toBe(onDisk);
  });

  it("발행물 v2.2 / v2.3 이 여전히 재현된다 — v2.4 추가가 과거 발행 축을 흔들지 않았다", () => {
    expect(readFileSync(join(here, "players.v2.2.json"), "utf8")).toBe(
      JSON.stringify(playersV22, null, 2) + "\n",
    );
    expect(readFileSync(join(here, "players.v2.3.json"), "utf8")).toBe(
      JSON.stringify(playersV23, null, 2) + "\n",
    );
  });

  it(`앞 ${FROZEN_TOTAL}행도 디스크 players.v2.1.json 과 동일(active 제외) — 이중 경계 불변`, () => {
    const onDisk = readFileSync(join(here, "players.v2.1.json"), "utf8");
    const head = playersV24.slice(0, FROZEN_TOTAL).map(({ active, ...rest }) => rest);
    expect(JSON.stringify(head, null, 2) + "\n").toBe(onDisk);
  });

  // ── 신규 채번분 ────────────────────────────────────────────────────────
  it(`v2.4 = ${TOTAL}명 (v2.3 ${V23_TOTAL} + 신규 2)`, () => {
    expect(playersV24).toHaveLength(TOTAL);
    expect(diskV23).toHaveLength(V23_TOTAL);
  });

  it("신규 2종이 P181~P182 신규 채번 — 기존 P-공간 재사용 0", () => {
    expect(V24_NEW_UNITS.map((u) => u.id)).toEqual(
      Array.from({ length: 2 }, (_, i) => `P${String(V23_TOTAL + i + 1).padStart(3, "0")}`),
    );
    playersV24.slice(V23_TOTAL).forEach((p, i) => {
      expect(p.id).toBe(V24_NEW_UNITS[i]!.id);
      expect(p.name).toBe(V24_NEW_UNITS[i]!.name);
      expect(p.position).toBe(V24_NEW_UNITS[i]!.position);
      expect(p.grade).toBe("LEGEND");
    });
    const oldIds = new Set(diskV23.map((p) => p.id));
    for (const u of V24_NEW_UNITS) expect(oldIds.has(u.id), `${u.id} 재사용 금지`).toBe(false);
  });

  it("신규 2종 이름 = 한글 패러디명 + 실명 denylist 0 (실명 유입 차단 유지)", () => {
    for (const u of V24_NEW_UNITS) {
      expect(u.name, `${u.id} 한글 전용`).toMatch(/^[가-힣]{2,}$/);
      for (const banned of PARODY_REAL_NAME_KO_DENYLIST) {
        expect(u.name.includes(banned), `${u.id} 실명 "${banned}" 포함 금지`).toBe(false);
      }
    }
    expect(new Set(playersV24.map((p) => p.name)).size).toBe(TOTAL);
  });

  it("신규 2종 능력치가 LEGEND 밴드(80~95) 안 — 스탯은 밴드 롤이지 소스 값 복사가 아니다", () => {
    for (const u of V24_NEW_UNITS) {
      const p = byId.get(u.id)!;
      for (const [k, v] of Object.entries(p.attributes)) {
        expect(v, `${u.id} ${k}`).toBeGreaterThanOrEqual(80);
        expect(v, `${u.id} ${k}`).toBeLessThanOrEqual(95);
      }
    }
    // 판다이크(P015)는 DIA 라 값 복사였다면 밴드를 뚫는다 — 그게 아님을 직접 대조한다.
    const vanDijk = playersV24.find((p) => p.id === "P015")!;
    expect(vanDijk.grade).toBe("DIA");
    expect(byId.get("P181")!.attributes).not.toEqual(vanDijk.attributes);
  });

  it("신규 2종 trait 스탯이 밴드 상단 — traits 복제가 실제로 반영됐다", () => {
    for (const u of V24_NEW_UNITS) {
      const attrs = byId.get(u.id)!.attributes;
      const others = Object.entries(attrs)
        .filter(([k]) => !u.traits.includes(k as keyof PlayerSeed["attributes"]))
        .map(([, v]) => v);
      for (const t of u.traits) {
        expect(attrs[t], `${u.id} trait ${t}`).toBeGreaterThanOrEqual(Math.min(...others));
      }
    }
  });

  it("신규 2종은 active:false 로 발행 — 활성화는 어드민 토글 몫(시드는 런타임 상태가 아니다)", () => {
    for (const id of V24_NEW_INACTIVE_IDS) expect(byId.get(id)!.active, `${id} active`).toBe(false);
  });

  it(`비활성 19종을 뺀 ${TOTAL - 19}명이 active:true`, () => {
    const inactive = new Set(INACTIVE_IDS_V24);
    for (const p of playersV24) expect(p.active, `${p.id} active`).toBe(!inactive.has(p.id));
    expect(playersV24.filter((p) => p.active)).toHaveLength(TOTAL - 19);
    expect(new Set(playersV24.filter((p) => !p.active).map((p) => p.id))).toEqual(
      new Set(INACTIVE_IDS_V24),
    );
  });

  it("v2.3 구간의 active 는 한 건도 안 바뀐다 — v2.4 는 순수 append 다", () => {
    diskV23.forEach((old, i) => {
      const now = playersV24[i]!;
      expect(now.id, `#${i} id`).toBe(old.id);
      expect(now.active, `${old.id} active`).toBe(old.active);
    });
  });

  it("v2.4 = v2.3 과 스키마 동일 — 필드 순서/개수 무변경(신설 필드 0)", () => {
    for (const p of playersV24) {
      expect(Object.keys(p)).toEqual([
        "id",
        "name",
        "position",
        "grade",
        "attributes",
        "personality",
        "active",
      ]);
    }
  });

  // ── 획득 가능 LEGEND 갭: 채번이 아니라 **활성화** 시점에 닫힌다 ──────────
  it("채번만으로는 획득 가능 LEGEND 의 DF/GK 갭이 닫히지 않는다(활성화 대기 상태 박제)", () => {
    const obtainable = playersV24.filter((p) => p.grade === "LEGEND" && p.active);
    expect(obtainable.filter((p) => p.position === "DF")).toHaveLength(0);
    expect(obtainable.filter((p) => p.position === "GK")).toHaveLength(0);
    // 활성화하면 닫힌다는 것도 같이 박제한다 — 이 줄이 "갭이 메워질 준비가 됐다"의 증거다.
    const afterToggle = playersV24.filter(
      (p) => p.grade === "LEGEND" && (p.active || V24_NEW_INACTIVE_IDS.includes(p.id)),
    );
    expect(afterToggle.filter((p) => p.position === "DF")).toHaveLength(1);
    expect(afterToggle.filter((p) => p.position === "GK")).toHaveLength(1);
  });

  it("economy starterPack / 봇 덱이 신규 2종을 참조하지 않는다(append 가 선별을 안 밀었다)", () => {
    const newIds = new Set(V24_NEW_UNITS.map((u) => u.id));
    for (const id of economy.starterPack) expect(newIds.has(id), `starterPack ${id}`).toBe(false);
    for (const b of [...bots, ...botsV3]) {
      for (const st of b.deck.starters) {
        expect(newIds.has(st.playerId), `${b.id} ${st.playerId}`).toBe(false);
      }
      for (const id of b.deck.bench) expect(newIds.has(id), `${b.id} bench ${id}`).toBe(false);
    }
    // starterTop 은 **활성 유닛만** 담는 정책(data/CLAUDE.md) — 비활성 신규가 새어 들어가면 안 된다.
    for (const id of economyV3.starterTop!.pool) {
      expect(V24_NEW_INACTIVE_IDS.includes(id), `starterTop ${id} 는 비활성`).toBe(false);
    }
  });
});

// ── #405 W1: 초기 스탯 하향 밴드 (players.v2.5) ────────────────────────────
// 설계 SoT = docs/plan-v5/growth-redesign.md §2.2. 이 발행물은 **시작 밴드만** 바꾼다 —
// 성장 천장·감쇠·XP 는 전부 server(GrowthTuning) 소관이라 data 는 손대지 않는다(§2.8.1 경계).
describe("players.v2.5 — 초기 스탯 하향 밴드 (#405 §2.2)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ATTR_KEYS = [
    "technical", "mental", "physical", "passing", "shooting",
    "tackling", "pace", "stamina", "positioning",
  ] as const;
  const diskV24 = JSON.parse(readFileSync(join(here, "players.v2.4.json"), "utf8")) as {
    id: string;
    name: string;
    position: Position;
    grade: Grade;
    attributes: PlayerSeed["attributes"];
    personality: Personality;
    active: boolean;
  }[];

  // ── 설계표 자체의 성질(리터럴 대조) ──────────────────────────────────────
  it("신규 시작 밴드가 §2.2 확정표와 일치 — 폭 11 · 시작 격차 9 · 중앙 37/46/55/64/73", () => {
    for (const g of GRADES) {
      const [lo, hi] = V25_BANDS[g];
      expect(hi - lo + 1, `${g} 밴드 폭`).toBe(11);
      expect((lo + hi) / 2, `${g} 시작 중앙`).toBe(V25_START_MEDIAN[g]);
    }
    // 등급 간 시작 격차 9 (§2.2 "시작 격차 9 / 천장 격차 6").
    for (let i = 1; i < GRADES.length; i++) {
      const prev = V25_BANDS[GRADES[i - 1]!];
      const cur = V25_BANDS[GRADES[i]!];
      expect(cur[0] - prev[0], `${GRADES[i]} 하한 격차`).toBe(9);
      expect(cur[1] - prev[1], `${GRADES[i]} 상한 격차`).toBe(9);
    }
  });

  it("구 밴드보다 확실히 낮다 — 하향이 목적이다(모든 등급에서 lo·hi 둘 다 감소)", () => {
    for (const g of GRADES) {
      expect(V25_BANDS[g][0], `${g} lo`).toBeLessThan(BANDS[g][0]);
      expect(V25_BANDS[g][1], `${g} hi`).toBeLessThan(BANDS[g][1]);
    }
  });

  // ── data / server 경계 (§2.8.1) ─────────────────────────────────────────
  it("성장 천장은 data 발행물에 없다 — 런타임 SoT 는 server 의 GrowthTuning.bands.growCeil", () => {
    // data 가 발행하는 것은 **시작 스탯 원본값**뿐이다. 어떤 행의 어떤 스탯도 시작 밴드 상한을
    // 넘지 않는다 = 천장 값이 이 파일에서 나오지 않는다.
    for (const g of GRADES) {
      expect(V25_BANDS[g][1], `${g} 시작 상한 < 성장 천장`).toBeLessThan(
        V25_GROW_CEIL_NOT_PUBLISHED[g],
      );
    }
    const maxByGrade: Record<Grade, number> = { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 };
    for (const p of playersV25) {
      for (const k of ATTR_KEYS) {
        maxByGrade[p.grade] = Math.max(maxByGrade[p.grade], p.attributes[k]);
      }
    }
    for (const g of GRADES) {
      expect(maxByGrade[g], `${g} 발행 최댓값이 시작 밴드 상한 이하`).toBeLessThanOrEqual(
        V25_BANDS[g][1],
      );
    }
  });

  // ── 핵심 AC: 전 182행이 자기 등급 신규 밴드 안 ──────────────────────────
  it(`v2.5 = ${V25_TOTAL}행 — 신규 채번 0, 행 수·id 순서가 v2.4 와 동일`, () => {
    expect(playersV25).toHaveLength(V25_TOTAL);
    expect(diskV24).toHaveLength(V25_TOTAL);
    expect(playersV25.map((p) => p.id)).toEqual(diskV24.map((p) => p.id));
  });

  it("전 182행의 능력치 9종이 **자기 등급의 신규 시작 밴드** 안(정수)", () => {
    for (const p of playersV25) {
      const [lo, hi] = V25_BANDS[p.grade];
      for (const k of ATTR_KEYS) {
        const v = p.attributes[k];
        expect(v, `${p.id} ${p.grade} ${k} ≥ ${lo}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${p.id} ${p.grade} ${k} ≤ ${hi}`).toBeLessThanOrEqual(hi);
        expect(Number.isInteger(v), `${p.id} ${k} integer`).toBe(true);
      }
    }
  });

  it("등급별 최솟값·최댓값이 밴드 경계를 실제로 채운다 — 밴드가 이름뿐이 아니다", () => {
    // 밴드를 넓게 잡아 놓고 실제로는 한 점만 쓰는 상태를 배제한다(밴드 계약의 유효성).
    for (const g of GRADES) {
      const vals = playersV25
        .filter((p) => p.grade === g)
        .flatMap((p) => ATTR_KEYS.map((k) => p.attributes[k]));
      expect(vals.length, `${g} 표본`).toBeGreaterThan(0);
      expect(Math.min(...vals), `${g} 최솟값 = 밴드 하한`).toBe(V25_BANDS[g][0]);
      expect(Math.max(...vals), `${g} 최댓값 = 밴드 상한`).toBe(V25_BANDS[g][1]);
    }
  });

  it("등급 단조 — 등급별 평균 능력치가 BRONZE<SILVER<GOLD<DIA<LEGEND (뽑기 가치 보존)", () => {
    const avg = (g: Grade) => {
      const vals = playersV25
        .filter((p) => p.grade === g)
        .flatMap((p) => ATTR_KEYS.map((k) => p.attributes[k]));
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    for (let i = 1; i < GRADES.length; i++) {
      expect(avg(GRADES[i]!), `${GRADES[i]} > ${GRADES[i - 1]}`).toBeGreaterThan(avg(GRADES[i - 1]!));
    }
  });

  it("v2.4 대비 전 등급에서 평균이 내려갔다 — '초기 스탯 하향'의 방향성 계약", () => {
    const avgOf = (rows: { grade: Grade; attributes: PlayerSeed["attributes"] }[], g: Grade) => {
      const vals = rows
        .filter((p) => p.grade === g)
        .flatMap((p) => ATTR_KEYS.map((k) => p.attributes[k]));
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    for (const g of GRADES) {
      expect(avgOf(playersV25, g), `${g} 평균 하향`).toBeLessThan(avgOf(diskV24, g));
    }
  });

  // ── 능력치 **만** 바뀐다 ────────────────────────────────────────────────
  it("name/position/grade/personality/active 가 디스크 v2.4 와 완전 동일 — 바뀐 축은 attributes 뿐", () => {
    expect(playersV25).toHaveLength(diskV24.length);
    diskV24.forEach((old, i) => {
      const now = playersV25[i]!;
      expect(now.id, `#${i} id`).toBe(old.id);
      expect(now.name, `${old.id} name`).toBe(old.name);
      expect(now.position, `${old.id} position`).toBe(old.position);
      expect(now.grade, `${old.id} grade`).toBe(old.grade);
      expect(now.personality, `${old.id} personality`).toBe(old.personality);
      expect(now.active, `${old.id} active`).toBe(old.active);
    });
    // attributes 를 제외하면 두 발행물은 바이트 동일해야 한다(누락 축 검출).
    const strip = (rows: typeof diskV24) => rows.map(({ attributes, ...rest }) => rest);
    expect(JSON.stringify(strip(playersV25 as typeof diskV24))).toBe(JSON.stringify(strip(diskV24)));
  });

  it("v2.5 = v2.4 와 스키마 동일 — 필드 순서/개수 무변경(신설 필드 0)", () => {
    for (const p of playersV25) {
      expect(Object.keys(p)).toEqual([
        "id", "name", "position", "grade", "attributes", "personality", "active",
      ]);
      expect(Object.keys(p.attributes)).toEqual([...ATTR_KEYS]);
    }
  });

  it("traits 승계 — ROSTER 가 v2.5 행과 index 단위로 정합(포지션·등급 일치, 재배열 0)", () => {
    // traits 는 발행 필드가 아니라 ROSTER 축이다. "traits 를 그대로 승계했다"의 관측 가능한
    // 형태 = **로스터 index 정합**(빌더가 같은 순서의 같은 엔트리로 굴렸다).
    expect(ROSTER.length).toBe(V25_TOTAL);
    playersV25.forEach((p, i) => {
      expect(p.name, `${p.id} 로스터 index 정합`).toBe(diskV24[i]!.name);
      expect(p.position).toBe(ROSTER[i]!.position);
      expect(p.grade).toBe(ROSTER[i]!.grade);
    });
  });

  // ⚠️ 바이어스 계약을 **평균 비교로 걸지 않는다.** 실제로 걸어 봤더니 `entry.traits` 를 빈
  // 배열로 바꾼 변이체가 살아남았다 — traits 가 주스탯과 자주 겹쳐서, 바이어스를 완전히 없애도
  // trait 평균이 여전히 +1.03 높게 나왔기 때문이다(측정값). 대신 **구조적 하한**으로 건다:
  // 바이어스는 롤 뒤 순수 가산이고 가산 대상 스탯은 raw ≥ lo 이므로, 클램프 후에도 **반드시
  // lo+bias 이상**이다(lo+3, lo+4 ≤ hi=lo+10). 확률이 아니라 항등식이다.
  //
  // 이 계약은 실제로 살아 있다 — 바이어스를 +5/+6 → +3/+4 로 바꾼 순간 아래 두 건이 **먼저
  // 깨졌고**(lo+5/lo+6 미달), 값을 갱신해서 통과시켰다. 상수를 코드에서 재사용하지 않고 리터럴로
  // 박는 이유가 이것이다(자기참조면 같이 따라 움직여 아무것도 못 잡는다).
  it("바이어스 유지 ① — 포지션 주스탯이 전원 **lo+3 이상**(가산이 실제로 들어갔다)", () => {
    for (const p of playersV25) {
      const lo = V25_BANDS[p.grade][0];
      for (const k of PRIMARY[p.position]) {
        expect(p.attributes[k], `${p.id} ${p.position} 주스탯 ${k} ≥ ${lo + 3}`).toBeGreaterThanOrEqual(lo + 3);
      }
    }
  });

  it("바이어스 유지 ② — trait 스탯이 전원 **lo+4 이상**(traits 승계가 실제로 반영됐다)", () => {
    playersV25.forEach((p, i) => {
      const lo = V25_BANDS[p.grade][0];
      for (const k of ROSTER[i]!.traits) {
        expect(p.attributes[k], `${p.id} trait ${k} ≥ ${lo + 4}`).toBeGreaterThanOrEqual(lo + 4);
      }
    });
  });

  /**
   * ⚠️ **함정 계약: 밴드 폭을 줄이면 바이어스도 같이 줄여야 한다.**
   *
   * #405 1차 발행에서 실제로 밟았다 — 폭만 16→11 로 줄이고 +5/+6 을 그대로 뒀더니 주스탯이면서
   * trait 인 스탯은 가산 합 +11 = 폭 전체라 **170/170(100%)** 이 상한에 박혀 롤이 무의미한
   * **상수**가 됐다. 같은 (포지션, trait) 조합 카드가 그 스탯에서 전부 동일해지는 다양성 손실이다.
   * 이 계약이 그 상태로의 회귀를 막는다: 가산 합이 폭을 덮으면 안 된다.
   */
  it("degenerate 가드 — 바이어스 합(주스탯+trait) < 밴드 폭 (교집합 스탯이 상수가 되지 않는다)", () => {
    const width = 11; // = hi − lo + 1
    expect(3 + 4, "주스탯+trait 가산 합").toBeLessThan(width);
    // 산출물로도 확인 — 교집합 스탯이 전부 상한이면 그 스탯은 상수다.
    let both = 0, bothAtHi = 0;
    playersV25.forEach((p, i) => {
      const hi = V25_BANDS[p.grade][1];
      const pr = new Set(PRIMARY[p.position] as string[]);
      for (const k of ROSTER[i]!.traits) {
        if (!pr.has(k)) continue;
        both++;
        if (p.attributes[k] === hi) bothAtHi++;
      }
    });
    expect(both, "주스탯∩trait 표본").toBeGreaterThan(0);
    expect(bothAtHi / both, "주스탯∩trait 클램프율 < 100%").toBeLessThan(1);
  });

  it("바이어스가 무차별이 아니다 — 바이어스 없는 스탯은 밴드 하한까지 실제로 내려간다", () => {
    // 위 두 계약은 "가산 대상이 높다"만 본다. 반대편(비대상)이 정말 밴드 바닥을 쓰는지 확인해야
    // "전 스탯에 +6 을 발라 놨다"는 상태와 구별된다.
    let sawFloor = 0;
    playersV25.forEach((p, i) => {
      const lo = V25_BANDS[p.grade][0];
      const biased = new Set<string>([...PRIMARY[p.position], ...(ROSTER[i]!.traits as string[])]);
      for (const k of ATTR_KEYS) {
        if (!biased.has(k) && p.attributes[k] === lo) sawFloor++;
      }
    });
    expect(sawFloor, "밴드 하한을 찍는 비바이어스 스탯이 존재").toBeGreaterThan(0);
  });

  it("모든 행이 shared PlayerCard 스키마로 파싱된다(하향 밴드가 계약을 안 깬다)", () => {
    for (const p of playersV25) {
      const card = PlayerCard.parse({
        playerId: p.id, name: p.name, position: p.position, attributes: p.attributes,
      });
      expect(card.playerId).toBe(p.id);
    }
  });

  // ── 결정론 + 과거 발행물 불변 ───────────────────────────────────────────
  it("v2.5 재생성 바이트 동일 — 같은 SEED → 같은 산출물", () => {
    const a = generateAll();
    const b = generateAll();
    expect(JSON.stringify(a.playersV25, null, 2)).toBe(JSON.stringify(b.playersV25, null, 2));
    // 디스크 발행물과도 동일해야 한다(재생성 누락 검출 — 동기화 describe 와 이중 가드).
    expect(readFileSync(join(here, "players.v2.5.json"), "utf8")).toBe(
      JSON.stringify(a.playersV25, null, 2) + "\n",
    );
  });

  it("과거 발행물 5종(v2·v2.1·v2.2·v2.3·v2.4)이 디스크와 바이트 동일 — v2.5 가 과거를 안 흔들었다", () => {
    const cases: readonly [string, unknown][] = [
      ["players.v2.json", playersV2],
      ["players.v2.1.json", playersV21],
      ["players.v2.2.json", playersV22],
      ["players.v2.3.json", playersV23],
      ["players.v2.4.json", playersV24],
    ];
    for (const [file, data] of cases) {
      expect(readFileSync(join(here, file), "utf8"), file).toBe(
        JSON.stringify(data, null, 2) + "\n",
      );
    }
  });

  it("구 밴드 롤(v2/…/v2.4)은 계속 구 밴드로 돈다 — GRADE_BANDS 는 손대지 않았다", () => {
    // v2.4 행이 여전히 **구** 밴드 안이고 신규 밴드 밖이라는 것 = 두 밴드가 분리돼 있다는 증거.
    for (const p of diskV24) {
      const [lo, hi] = BANDS[p.grade];
      for (const k of ATTR_KEYS) {
        expect(p.attributes[k], `${p.id} ${k} 구 밴드`).toBeGreaterThanOrEqual(lo);
        expect(p.attributes[k], `${p.id} ${k} 구 밴드`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("economy starterPack / 봇 덱 / starterTop 이 v2.5 에서도 전부 실재 id 를 가리킨다", () => {
    const ids = new Set(playersV25.map((p) => p.id));
    for (const id of economy.starterPack) expect(ids.has(id), `starterPack ${id}`).toBe(true);
    for (const b of [...bots, ...botsV3]) {
      for (const st of b.deck.starters) expect(ids.has(st.playerId), `${b.id} ${st.playerId}`).toBe(true);
      for (const id of b.deck.bench) expect(ids.has(id), `${b.id} bench ${id}`).toBe(true);
    }
    for (const id of economyV3.starterTop!.pool) expect(ids.has(id), `starterTop ${id}`).toBe(true);
  });
});

// ── #406 요구 6 — 선수명 전역 한글화 (hero 확정 2026-08-02 "안 C 하이브리드") ──────────────
//
// ⚠️ **발행 번호가 v2.5 → v2.6 으로 밀렸다.** #405 W1(성장 재설계)이 능력치 재롤을 `v2.5` 로
// 먼저 발행했고 data/CLAUDE.md 는 발행 후 수정을 금지한다 → 표시명 레이어는 **다음 버전**이다.
// 두 축은 직교한다: #405 = `attributes` · #406 = `name`/`shortName`. 아래 계약이 그 직교성을
// 직접 박제한다("이름 축 밖은 디스크 v2.5 와 완전 동일").
//
// 결정: **실선수 172명은 한글 음역 · 패러디 10명(P173~P182)은 현행 유지.**
// 아래 상수는 전부 **이슈 결정표에서 직접 박제**한다 — names-ko.ts 나 generate.ts 를 재사용하면
// 자기참조라 결정과 코드가 어긋나도 못 잡는다(NEW_UNITS·V24_NEW_UNITS 와 같은 규율).

/** v2.6 에서 **이름이 바뀌지 않는** 유닛 = 패러디 10종. 안 C 의 경계. */
const V26_PARODY_IDS: readonly string[] = [
  "P173", "P174", "P175", "P176", "P177", "P178", "P179", "P180", "P181", "P182",
];

/**
 * **denylist 와 정면으로 겹치는 실명 음역 6건**(#406 목업 게이트 실측). 이 6건이 v2.6 에서
 * 정상 통과하는 것이 안 C 의 핵심이다 — `PARODY_REAL_NAME_KO_DENYLIST` 를 실선수 축에 적용하면
 * 여기가 먼저 터진다. 즉 이 배열은 "denylist 범위를 패러디로 좁혔다"의 실행 가능한 증거다.
 */
const V26_DENYLIST_COLLIDING_REAL_NAMES: readonly { id: string; ko: string }[] = [
  { id: "P001", ko: "레프 야신" },
  { id: "P005", ko: "디에고 마라도나" },
  { id: "P010", ko: "호나우두 나자리우" },
  { id: "P025", ko: "주드 벨링엄" },
  { id: "P032", ko: "킬리안 음바페" },
  { id: "P033", ko: "비니시우스 주니오르" },
];

/**
 * 짧은 이름 중복 **허용 2쌍**(#406 목업 게이트에서 hero 에게 보고된 실측). 성만 남기면 겹치는
 * 실제 동성 선수라 구분이 필요한 화면은 풀네임을 쓴다. **그 외 신규 중복은 실패**여야 한다 —
 * 새 중복은 큐레이션 실수이거나 UI 가 두 선수를 구분 못 하게 되는 회귀다.
 */
const V26_ALLOWED_SHORT_DUPES: readonly { short: string; ids: readonly string[] }[] = [
  { short: "오나나", ids: ["P074", "P105"] },
  { short: "루이스", ids: ["P101", "P118"] },
];

/** 밀집 UI 폭 상한(목업 실측 = 풀 12자 · 짧은 7자). 여유 2자를 두되 무한 확장은 막는다. */
const V26_MAX_NAME_LEN = 14;
const V26_MAX_SHORT_LEN = 8;

/** 한글(공백 허용) 전용 — 라틴 문자·숫자·기호가 섞이면 불통과. */
const HANGUL_ONLY_RE = /^[가-힣]+(?: [가-힣]+)*$/;

describe("players.v2.6 — 선수명 한글화 + shortName (#406 요구 6, 안 C 하이브리드)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  /**
   * 디스크의 **발행된** v2.5 — 대조 기준을 코드가 아니라 파일에서 가져온다(자기참조 회피).
   * ⚠️ v2.4 가 아니라 **v2.5** 다: #405 W1 이 v2.5 로 능력치를 재롤해 먼저 발행했으므로 표시명
   * 레이어의 입력은 그 발행물이다. `name` 은 v2.4 와 동일하게 승계되므로 `names-ko.ts` 의 `from`
   * 앵커(v2.4 영문명)는 그대로 성립하고, `attributes` 는 #405 재롤값이 그대로 실린다.
   */
  const diskV25 = JSON.parse(readFileSync(join(here, "players.v2.5.json"), "utf8")) as {
    id: string;
    name: string;
    position: Position;
    grade: Grade;
    attributes: PlayerSeed["attributes"];
    personality: Personality;
    active: boolean;
  }[];
  const byId = new Map(playersV26.map((p) => [p.id, p]));

  // ── 이 웨이브의 진짜 게이트: 과거 발행 축이 안 흔들렸나 ────────────────────
  it("발행물 v2 ~ v2.5 가 여전히 **바이트 동일** 재현된다 — 한글화가 과거 축을 안 건드렸다", () => {
    // ROSTER 의 영문 name 을 덮어썼다면 여기가 통째로 터진다(그래서 덮지 않고 v2.6 레이어를 얹었다).
    // ⚠️ v2.5(#405 능력치 재롤)까지 포함한다 — 그 발행물이 v2.6 의 **입력**이므로 여기가
    //    무너지면 표시명 레이어가 엉뚱한 스탯 위에 얹힌다.
    expect(readFileSync(join(here, "players.v2.json"), "utf8")).toBe(
      JSON.stringify(playersV2, null, 2) + "\n",
    );
    expect(readFileSync(join(here, "players.v2.1.json"), "utf8")).toBe(
      JSON.stringify(playersV21, null, 2) + "\n",
    );
    expect(readFileSync(join(here, "players.v2.2.json"), "utf8")).toBe(
      JSON.stringify(playersV22, null, 2) + "\n",
    );
    expect(readFileSync(join(here, "players.v2.3.json"), "utf8")).toBe(
      JSON.stringify(playersV23, null, 2) + "\n",
    );
    expect(readFileSync(join(here, "players.v2.4.json"), "utf8")).toBe(
      JSON.stringify(playersV24, null, 2) + "\n",
    );
    expect(readFileSync(join(here, "players.v2.5.json"), "utf8")).toBe(
      JSON.stringify(playersV25, null, 2) + "\n",
    );
  });

  it("이름 축 밖은 디스크 v2.5 와 **완전 동일** — 표시명 레이어다(#405 재롤 스탯·성격·active 무변경)", () => {
    expect(playersV26).toHaveLength(TOTAL);
    expect(diskV25).toHaveLength(TOTAL);
    const strip = (p: Record<string, unknown>) => {
      const { name: _n, shortName: _s, ...rest } = p;
      return rest;
    };
    expect(JSON.stringify(playersV26.map(strip), null, 2)).toBe(
      JSON.stringify(diskV25.map(strip), null, 2),
    );
  });

  it("v2.6 = v2.5 + shortName 하나만 — 필드 순서·개수(신설 1)", () => {
    for (const p of playersV26) {
      expect(Object.keys(p)).toEqual([
        "id", "name", "position", "grade", "attributes", "personality", "active", "shortName",
      ]);
    }
  });

  // ── 안 C ① 실선수 172명은 한글 음역 ────────────────────────────────────
  it(`실선수 ${FROZEN_TOTAL}명 전원이 개명됐다 — 디스크 v2.5(로마자)와 다르고 한글 전용`, () => {
    let renamed = 0;
    for (const p of playersV26.slice(0, FROZEN_TOTAL)) {
      const old = diskV25.find((x) => x.id === p.id)!;
      expect(p.name, `${p.id} 개명됨`).not.toBe(old.name);
      expect(p.name, `${p.id} 빈 문자열 금지`).not.toBe("");
      expect(p.name, `${p.id} 한글 포함`).toMatch(/[가-힣]/);
      expect(p.name, `${p.id} 라틴 문자 잔류 금지`).not.toMatch(/[A-Za-z]/);
      expect(p.name, `${p.id} 한글(공백 허용) 전용`).toMatch(HANGUL_ONLY_RE);
      expect(p.name.length, `${p.id} 표시명 길이 상한`).toBeLessThanOrEqual(V26_MAX_NAME_LEN);
      renamed++;
    }
    expect(renamed).toBe(FROZEN_TOTAL);
  });

  it("182명 전원 한글 표기 — 로마자 이름이 한 건도 안 남았다(전역 한글화 요구 6)", () => {
    for (const p of playersV26) expect(p.name, `${p.id} 라틴 잔류`).not.toMatch(/[A-Za-z]/);
    expect(playersV26.filter((p) => /[가-힣]/.test(p.name))).toHaveLength(TOTAL);
  });

  // ── 안 C ② 패러디 10명은 현행 유지 ─────────────────────────────────────
  it("패러디 10종은 **이름이 안 바뀐다** — 디스크 v2.5 와 동일(개명 대상 아님)", () => {
    expect(V26_PARODY_IDS).toHaveLength(TOTAL - FROZEN_TOTAL);
    for (const id of V26_PARODY_IDS) {
      const old = diskV25.find((x) => x.id === id)!;
      expect(byId.get(id)?.name, `${id} 현행 유지`).toBe(old.name);
    }
    // v2.3 정정본이 그대로 실린다(되돌아가지 않았다) — 이름 축의 회귀 스팟체크.
    expect(byId.get("P175")?.name).toBe("열라도나");
    expect(byId.get("P179")?.name).toBe("욱링엄");
  });

  it("패러디 10종엔 여전히 실명 denylist 0 — 가드의 원래 목적은 살아 있다", () => {
    for (const id of V26_PARODY_IDS) {
      const name = byId.get(id)!.name;
      expect(name, `${id} 한글 전용 패러디명`).toMatch(/^[가-힣]{2,}$/);
      for (const banned of PARODY_REAL_NAME_KO_DENYLIST) {
        expect(name.includes(banned), `${id} 실명 "${banned}" 포함 금지`).toBe(false);
      }
    }
  });

  // ── denylist 범위 축소가 의도대로 작동하는가 ───────────────────────────
  it("실명 음역 6건이 정상 통과 — denylist 적용 범위 = 패러디 유닛뿐(#406 hero 확정)", () => {
    for (const c of V26_DENYLIST_COLLIDING_REAL_NAMES) {
      expect(byId.get(c.id)?.name, `${c.id} 음역`).toBe(c.ko);
      // 이 이름들은 denylist 와 실제로 겹친다 — 겹치는데도 통과하는 것이 이 계약의 요점이다.
      const hits = PARODY_REAL_NAME_KO_DENYLIST.filter((b) => c.ko.includes(b));
      expect(hits.length, `${c.id} 는 denylist 와 겹쳐야 이 테스트가 의미 있다`).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠️ **이 가드의 적용 범위는 로마자 축(ROSTER) + v2~v2.6 발행물뿐이다**(#450 §6-1-8).
   * v2.7 은 표시 축에서 실명을 제거하는 것이 목적이라 이 8명과 **정면으로 충돌**한다 —
   * 5명 은퇴(P143 박지성 · P144 차범근 · P145 이강인 · P170 양민혁 · P037 손흥민) ·
   * 3명 개명(P022 김민재 → 다니엘 오르베 · P151 황희찬 → 곽재율 · P161 조현우 → 탁서온).
   * **가드를 지우지 않고 범위를 명시해서 남긴다** — 여기서는 계속 참이고, v2.7 축에서는
   * `v2.7 describe` 의 "EXPECTED_KOREANS 8명의 v2.7 처분" 이 그 사실을 따로 박제한다.
   */
  it("한국 선수 대표 8명이 한글로 나온다(#84 존재 검증의 한글 축 — v2.6 까지의 범위)", () => {
    const byEnName = new Map(diskV25.map((p) => [p.name, p]));
    for (const k of EXPECTED_KOREANS) {
      const old = byEnName.get(k.name);
      expect(old, `${k.name} 존재(로마자 축)`).toBeDefined();
      const now = byId.get(old!.id)!;
      expect(now.name, `${k.name} 한글 표기`).toBe(k.ko);
      expect(now.grade, `${k.ko} 등급`).toBe(k.grade);
    }
  });

  // ── 한글 이름 자체의 무결성 ────────────────────────────────────────────
  it("id 182개 유일 + P001..P182 순서 유지 — 개명이 행을 섞지 않았다", () => {
    const ids = playersV26.map((p) => p.id);
    expect(new Set(ids).size).toBe(TOTAL);
    expect(ids).toEqual(
      Array.from({ length: TOTAL }, (_, i) => `P${String(i + 1).padStart(3, "0")}`),
    );
  });

  it("표시명 182개 전역 유일 — 도감 중복 0", () => {
    expect(new Set(playersV26.map((p) => p.name)).size).toBe(TOTAL);
  });

  it("shortName 전원 존재 · 한글 전용 · 풀네임보다 길지 않다 · 길이 상한", () => {
    for (const p of playersV26) {
      expect(p.shortName, `${p.id} shortName 존재`).toBeTruthy();
      expect(p.shortName, `${p.id} 한글(공백 허용) 전용`).toMatch(HANGUL_ONLY_RE);
      expect(p.shortName.length, `${p.id} shortName ≤ 표시명`).toBeLessThanOrEqual(p.name.length);
      expect(p.shortName.length, `${p.id} shortName 길이 상한`).toBeLessThanOrEqual(
        V26_MAX_SHORT_LEN,
      );
    }
  });

  it("shortName 중복은 알려진 2쌍(오나나·루이스)뿐 — 신규 중복은 실패", () => {
    const groups = new Map<string, string[]>();
    for (const p of playersV26) {
      groups.set(p.shortName, [...(groups.get(p.shortName) ?? []), p.id]);
    }
    const dupes = [...groups.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([short, ids]) => ({ short, ids }))
      .sort((a, b) => a.short.localeCompare(b.short));
    const expected = [...V26_ALLOWED_SHORT_DUPES]
      .map((d) => ({ short: d.short, ids: [...d.ids] }))
      .sort((a, b) => a.short.localeCompare(b.short));
    expect(dupes).toEqual(expected);
    // 중복 쌍은 풀네임으로는 구분된다 — 그래서 "구분이 필요하면 풀네임"이 성립한다.
    for (const d of V26_ALLOWED_SHORT_DUPES) {
      const names = d.ids.map((id) => byId.get(id)!.name);
      expect(new Set(names).size, `${d.short} 쌍 풀네임 구분`).toBe(d.ids.length);
    }
  });

  it("shortName 이 풀네임의 부분문자열 — 엉뚱한 별명이 아니라 축약이다(패러디 축약 2건 제외)", () => {
    // 예외 = 5자 패러디명의 밀집 UI 축약(#406 목업): 덕브라이너→덕브라 · 경니시우스→경니시.
    // 이 둘도 접두어라 부분문자열 규칙을 만족한다 — 예외 목록 없이 전원에 걸 수 있는지 확인한다.
    for (const p of playersV26) {
      expect(p.name.includes(p.shortName), `${p.id} "${p.shortName}" ⊂ "${p.name}"`).toBe(true);
    }
  });

  it("zod PlayerCard 호환 유지 — 한글 이름·신설 필드가 계약을 깨지 않는다", () => {
    for (const p of playersV26) {
      const parsed = PlayerCard.safeParse({
        playerId: p.id,
        name: p.name,
        position: p.position,
        attributes: p.attributes,
      });
      expect(parsed.success, `${p.id} ${p.name}`).toBe(true);
    }
  });
});

// ── #450 W1 · players.v2.7 / bots.v4 / economy.v4 ─────────────────────────────
// 명세 SoT = `docs/plan-v5/roster-v27-spec.md`. 아래 상수는 **전부 그 문서에서 손으로 옮긴 리터럴**이다 —
// 생성기 상수(`V27_ACTIVE_CARDS` 등)를 재사용하면 자기참조가 되어 표가 틀려도 못 잡는다(NEW_UNITS 규율).

/**
 * v2.7 발행물의 행 수. ⚠️ **네 번째 동결 경계가 아니다**(명세 §6-1) — v2.7 은 ROSTER 에 append 하지
 * 않고 기존 id 만 재사용하므로 `rng.ts`·`roster.ts` 무접촉이고 RNG 스트림이 1비트도 안 움직인다.
 * 이름을 남기는 이유는 "v2.7 은 182행을 그대로 싣는다"를 계약이 부르는 이름이 필요해서다.
 */
const FROZEN_ROSTER_COUNT_V27 = 182;
/** v2.7 활성 종수(명세 §1-1 격자 합). 나머지는 전부 은퇴(비활성). */
const V27_ACTIVE_TOTAL = 62;
const V27_INACTIVE_TOTAL = FROZEN_ROSTER_COUNT_V27 - V27_ACTIVE_TOTAL;

/** 명세 §1-1 확정 격자 — 등급 × 포지션 종수. 하드코딩(생성기 재사용 금지). */
const V27_GRID: Record<Grade, Record<Position, number>> = {
  LEGEND: { GK: 2, DF: 1, MF: 3, FW: 4 },
  DIA: { GK: 2, DF: 4, MF: 4, FW: 3 },
  GOLD: { GK: 2, DF: 4, MF: 4, FW: 3 },
  SILVER: { GK: 2, DF: 4, MF: 4, FW: 3 },
  BRONZE: { GK: 2, DF: 4, MF: 4, FW: 3 },
};
/** 격자의 포지션 합(명세 부록 A) — 격자를 다른 축으로 한 번 더 검산한다. */
const V27_POSITION_TOTALS: Record<Position, number> = { GK: 10, DF: 17, MF: 19, FW: 16 };

/** 명세 §2-2 — 활성 62종 id 전량(등급 → 포지션 → fit 내림차순). */
const V27_ACTIVE_IDS: readonly string[] = [
  "P182", "P178", "P181", "P177", "P175", "P179", "P176", "P174", "P173", "P180",
  "P013", "P014", "P021", "P020", "P015", "P022", "P030", "P024", "P025", "P029", "P036", "P033", "P031",
  "P038", "P040", "P050", "P043", "P148", "P150", "P055", "P065", "P056", "P147", "P066", "P073", "P151",
  "P074", "P161", "P079", "P080", "P078", "P077", "P093", "P094", "P096", "P095", "P106", "P108", "P107",
  "P116", "P169", "P122", "P120", "P121", "P125", "P127", "P129", "P134", "P131", "P171", "P139", "P136",
];

/** 명세 §3-2 — 은퇴(비활성) 120종 id 전량. 표 순서 그대로. */
const V27_RETIRED_IDS: readonly string[] = [
  "P001", "P002", "P003", "P004", "P007", "P005", "P008", "P006", "P143", "P012", "P009", "P144", "P011", "P010",
  "P016", "P018", "P017", "P019", "P026", "P023", "P027", "P028", "P037", "P034", "P035", "P032",
  "P039", "P041", "P044", "P051", "P047", "P042", "P052", "P046", "P045", "P149", "P048", "P049",
  "P061", "P057", "P145", "P054", "P146", "P064", "P063", "P053", "P060", "P059", "P062", "P058",
  "P152", "P067", "P070", "P069", "P068", "P072", "P071", "P153", "P154",
  "P076", "P075", "P085", "P082", "P087", "P088", "P160", "P081", "P091", "P089", "P159", "P083", "P086", "P090", "P084",
  "P103", "P097", "P101", "P104", "P156", "P157", "P100", "P092", "P155", "P158", "P098", "P102", "P105", "P099",
  "P164", "P114", "P109", "P115", "P162", "P163", "P112", "P110", "P111", "P113",
  "P117", "P168", "P123", "P119", "P124", "P126", "P118", "P166", "P135", "P167", "P133", "P165", "P132", "P130", "P128",
  "P142", "P138", "P141", "P140", "P172", "P137", "P170",
];

/** 명세 §2-1-b — 한국식 가상명 7종(hero H1 확정). 성 1자 + 이름 2자 · `short == name`. */
const V27_KOREAN_STYLE: readonly { id: string; name: string }[] = [
  { id: "P147", name: "한태겸" },
  { id: "P148", name: "노시운" },
  { id: "P150", name: "표유안" },
  { id: "P151", name: "곽재율" },
  { id: "P161", name: "탁서온" },
  { id: "P169", name: "진하람" },
  { id: "P171", name: "여은결" },
];

/** 명세 §5-2 — `starterPack` v4 (GK2 / DF5 / MF4 / FW3). */
const V27_STARTER_PACK: readonly string[] = [
  "P074", "P161", "P077", "P078", "P079", "P080", "P122",
  "P093", "P094", "P095", "P096", "P106", "P107", "P108",
];
/** 명세 §5-3 — `starterTop.pool` v4 = 활성 LEGEND 10종 전량. */
const V27_STARTER_TOP: readonly string[] = [
  "P173", "P174", "P175", "P176", "P177", "P178", "P179", "P180", "P181", "P182",
];

/** 명세 §6-4 "교체 후 봇 덱 전문". */
const V27_BOT_DECKS: Record<string, { formation: string; starters: readonly string[]; bench: readonly string[] }> = {
  BOT_ATK: {
    formation: "4-3-3",
    starters: ["P116", "P125", "P122", "P120", "P121", "P127", "P131", "P129", "P136", "P139", "P106"],
    bench: ["P074", "P077", "P094", "P107"],
  },
  BOT_DEF: {
    formation: "5-3-2",
    starters: ["P116", "P121", "P120", "P077", "P078", "P079", "P096", "P093", "P094", "P106", "P107"],
    bench: ["P074", "P080", "P095", "P108"],
  },
  BOT_BAL: {
    formation: "4-4-2",
    starters: ["P116", "P125", "P122", "P120", "P121", "P127", "P131", "P129", "P134", "P136", "P139"],
    bench: ["P169", "P077", "P095", "P171"],
  },
};

describe("players.v2.7 — 표시명 가상화 + active 재편 (#450 W1)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  /** 디스크의 **발행된** v2.6 — 대조 기준을 코드가 아니라 파일에서 가져온다(자기참조 회피). */
  const diskV26 = JSON.parse(readFileSync(join(here, "players.v2.6.json"), "utf8")) as {
    id: string;
    name: string;
    position: Position;
    grade: Grade;
    attributes: PlayerSeed["attributes"];
    personality: Personality;
    active: boolean;
    shortName: string;
  }[];
  const byId = new Map(playersV27.map((p) => [p.id, p]));
  const activeSet = new Set(V27_ACTIVE_IDS);
  const parodySet = new Set(V26_PARODY_IDS);
  const activeRows = playersV27.filter((p) => p.active);
  /** 개명 대상 52종 = 활성 62 − 패러디 10. */
  const renamed = activeRows.filter((p) => !parodySet.has(p.id));

  // v2.6 발행물에서 **직접 도출**하는 실명 축(하드코딩하면 스테일해진다 — 명세 §6-1-6).
  const realRows = diskV26.filter((p) => !parodySet.has(p.id));
  /** 실명 토큰 전집합 = 풀네임 공백분해 토큰 + shortName. */
  const realTokens = new Set<string>();
  for (const p of realRows) {
    for (const t of p.name.split(" ")) realTokens.add(t);
    realTokens.add(p.shortName);
  }
  const realFullNames = new Set(realRows.map((p) => p.name));
  /** 한국식(공백 없는) 실명에서 도출한 성·이름 집합. 비한국 3자명(알리송·페드리…)도 포함하는 **초집합**이라 더 보수적이다. */
  const realNoSpace = realRows.filter((p) => !p.name.includes(" "));
  const realSurnames = new Set(realNoSpace.map((p) => p.name[0]!));
  const realGivenNames = new Set(realNoSpace.map((p) => p.name.slice(1)));
  const parodySurnames = new Set(V26_PARODY_IDS.map((id) => diskV26.find((p) => p.id === id)!.name[0]!));

  // ── ① 이 웨이브의 최상위 게이트: 과거 발행 축이 안 흔들렸나 ────────────────
  it("발행물 v2 ~ v2.6 이 여전히 **바이트 동일** 재현된다 — 가상화가 과거 축을 안 건드렸다", () => {
    // 이름 축은 RNG 에 안 들어가고 ROSTER 도 무접촉이라 **깨질 이유가 없다. 깨지면 로스터를 건드린 것.**
    const cases: readonly [string, unknown][] = [
      ["players.v2.json", playersV2],
      ["players.v2.1.json", playersV21],
      ["players.v2.2.json", playersV22],
      ["players.v2.3.json", playersV23],
      ["players.v2.4.json", playersV24],
      ["players.v2.6.json", playersV26],
    ];
    for (const [file, data] of cases) {
      expect(readFileSync(join(here, file), "utf8"), file).toBe(JSON.stringify(data, null, 2) + "\n");
    }
    // v2.5 는 v2.6 의 입력이라 따로 한 번 더(무너지면 가상화가 엉뚱한 스탯 위에 얹힌다).
    expect(readFileSync(join(here, "players.v2.5.json"), "utf8")).toBe(
      JSON.stringify(playersV25, null, 2) + "\n",
    );
  });

  it("이름·shortName·active 축 **밖**은 디스크 v2.6 과 완전 동일 — 스탯·성격·포지션·등급 무접촉", () => {
    expect(playersV27).toHaveLength(FROZEN_ROSTER_COUNT_V27);
    expect(diskV26).toHaveLength(FROZEN_ROSTER_COUNT_V27);
    const strip = (p: { [k: string]: unknown }) => {
      const { name: _n, shortName: _s, active: _a, ...rest } = p;
      return rest;
    };
    expect(JSON.stringify(playersV27.map((p) => strip({ ...p })), null, 2)).toBe(
      JSON.stringify(diskV26.map((p) => strip({ ...p })), null, 2),
    );
  });

  it("v2.7 = v2.6 과 **필드 순서·개수 동일**(additive 필드 0)", () => {
    for (const p of playersV27) {
      expect(Object.keys(p)).toEqual([
        "id", "name", "position", "grade", "attributes", "personality", "active", "shortName",
      ]);
    }
  });

  it("id 182개 유일 + P001..P182 순서 유지 — 가상화가 행을 섞지 않았다", () => {
    const ids = playersV27.map((p) => p.id);
    expect(new Set(ids).size).toBe(FROZEN_ROSTER_COUNT_V27);
    expect(ids).toEqual(
      Array.from({ length: FROZEN_ROSTER_COUNT_V27 }, (_, i) => `P${String(i + 1).padStart(3, "0")}`),
    );
  });

  // ── ② 활성 격자 (명세 §1-1) ───────────────────────────────────────────────
  it(`활성 ${V27_ACTIVE_TOTAL}종 / 비활성 ${V27_INACTIVE_TOTAL}종 — 은퇴는 행 삭제가 아니라 비활성화다`, () => {
    expect(activeRows).toHaveLength(V27_ACTIVE_TOTAL);
    expect(playersV27.filter((p) => !p.active)).toHaveLength(V27_INACTIVE_TOTAL);
    // 총 행 수 불변 = `AdminCatalogService.purge` 가 참조 있으면 409 라 삭제가 구조적으로 불가능하다.
    expect(playersV27).toHaveLength(FROZEN_ROSTER_COUNT_V27);
  });

  it("활성 id 집합이 명세 §2-2 62종과 정확히 일치", () => {
    expect(V27_ACTIVE_IDS).toHaveLength(V27_ACTIVE_TOTAL);
    expect(new Set(V27_ACTIVE_IDS).size).toBe(V27_ACTIVE_TOTAL);
    expect(activeRows.map((p) => p.id).sort()).toEqual([...V27_ACTIVE_IDS].sort());
  });

  it("은퇴 id 집합이 명세 §3-2 120종과 정확히 일치 — 전량 박제", () => {
    expect(V27_RETIRED_IDS).toHaveLength(V27_INACTIVE_TOTAL);
    expect(new Set(V27_RETIRED_IDS).size).toBe(V27_INACTIVE_TOTAL);
    expect(playersV27.filter((p) => !p.active).map((p) => p.id).sort()).toEqual(
      [...V27_RETIRED_IDS].sort(),
    );
    // 두 목록이 서로 배타 + 합집합이 전체 = 빠뜨린 id 0.
    expect(V27_ACTIVE_IDS.filter((id) => V27_RETIRED_IDS.includes(id))).toEqual([]);
  });

  it("등급 × 포지션 격자가 명세 §1-1 과 완전 일치 (LEGEND GK2/DF1/MF3/FW4 · 나머지 GK2/DF4/MF4/FW3)", () => {
    for (const g of GRADES) {
      for (const pos of POSITIONS) {
        const n = activeRows.filter((p) => p.grade === g && p.position === pos).length;
        expect(n, `${g}/${pos}`).toBe(V27_GRID[g][pos]);
      }
    }
    // 격자를 포지션 축으로 한 번 더 검산(명세 부록 A: GK10 · DF17 · MF19 · FW16).
    for (const pos of POSITIONS) {
      expect(activeRows.filter((p) => p.position === pos).length, pos).toBe(V27_POSITION_TOTALS[pos]);
    }
    // 등급별 합 = LEGEND 10 + 나머지 각 13.
    expect(activeRows.filter((p) => p.grade === "LEGEND")).toHaveLength(10);
    for (const g of GRADES.filter((x) => x !== "LEGEND")) {
      expect(activeRows.filter((p) => p.grade === g), g).toHaveLength(13);
    }
  });

  // ── ③ 이름 가드 — 3분기 각각 (명세 §2-1) ─────────────────────────────────
  it("(a) 패러디 10종: 이름·shortName 이 디스크 v2.6 과 **동일** · 전원 활성", () => {
    expect(V26_PARODY_IDS).toHaveLength(10);
    for (const id of V26_PARODY_IDS) {
      const old = diskV26.find((x) => x.id === id)!;
      const now = byId.get(id)!;
      expect(now.name, `${id} 이름 무변경`).toBe(old.name);
      expect(now.shortName, `${id} shortName 무변경`).toBe(old.shortName);
      expect(now.active, `${id} 활성`).toBe(true);
      for (const banned of PARODY_REAL_NAME_KO_DENYLIST) {
        expect(now.name.includes(banned), `${id} 실명 "${banned}" 포함 금지`).toBe(false);
      }
    }
    // ⚠️ P178 석신은 v2.6 에서 **비활성**이었고 v2.7 에서 `active` 만 뒤집힌다(hero H3).
    expect(diskV26.find((x) => x.id === "P178")!.active).toBe(false);
    expect(byId.get("P178")!.active).toBe(true);
  });

  it("(b) 한국식 7종: 한글 3자 · short == name · 실명 성/이름 집합과 충돌 0 · 패러디 성 회피", () => {
    expect(V27_KOREAN_STYLE).toHaveLength(7);
    for (const k of V27_KOREAN_STYLE) {
      const p = byId.get(k.id)!;
      expect(p.name, `${k.id} 확정 표시명`).toBe(k.name);
      expect(p.active, `${k.id} 활성`).toBe(true);
      expect(p.name, `${k.id} 성1+이름2`).toMatch(/^[가-힣]{3}$/);
      expect(p.shortName, `${k.id} short == name`).toBe(p.name);
      // 실존 회피 ①②③ — 집합은 v2.6 발행물에서 직접 도출한다(하드코딩 금지).
      expect(realFullNames.has(p.name), `${k.id} 성+이름 전체 일치 금지`).toBe(false);
      expect(realSurnames.has(p.name[0]!), `${k.id} 성 "${p.name[0]}" 충돌`).toBe(false);
      expect(realGivenNames.has(p.name.slice(1)), `${k.id} 이름 "${p.name.slice(1)}" 충돌`).toBe(false);
      // 실존 회피 ④ — 패러디 성(권·석·오·경·욱 …)과 겹치면 패러디와 혼동된다.
      expect(parodySurnames.has(p.name[0]!), `${k.id} 패러디 성 충돌`).toBe(false);
    }
    // 내부 유일성 — 성 7개·이름 7개 전부 다름.
    expect(new Set(V27_KOREAN_STYLE.map((k) => k.name[0])).size).toBe(7);
    expect(new Set(V27_KOREAN_STYLE.map((k) => k.name.slice(1))).size).toBe(7);
    // 이 가드가 무의미해지지 않게: 도출 집합이 실제로 비어 있지 않은지 확인(빈 집합이면 전부 통과한다).
    expect(realSurnames.size).toBeGreaterThan(10);
    expect(realGivenNames.size).toBeGreaterThan(20);
  });

  it("(c) 무국적 45종: 한글 2토큰 · short == 마지막 토큰 · 길이 상한", () => {
    const foreign = renamed.filter((p) => !V27_KOREAN_STYLE.some((k) => k.id === p.id));
    expect(foreign).toHaveLength(45);
    for (const p of foreign) {
      const parts = p.name.split(" ");
      expect(parts, `${p.id} "${p.name}" 2토큰`).toHaveLength(2);
      expect(p.shortName, `${p.id} short = 성(뒤 토큰)`).toBe(parts[1]);
      expect(p.name.length, `${p.id} 풀네임 상한`).toBeLessThanOrEqual(V26_MAX_NAME_LEN);
      expect(p.shortName.length, `${p.id} short 상한`).toBeLessThanOrEqual(V26_MAX_SHORT_LEN);
    }
  });

  // ── ④ 전 62종 공통 — 실명 잔존 0 / 유일성 ────────────────────────────────
  it("활성 62종 표시명이 전부 한글 전용 · 라틴 문자 0", () => {
    for (const p of activeRows) {
      expect(p.name, `${p.id} 한글(공백 허용) 전용`).toMatch(HANGUL_ONLY_RE);
      expect(p.shortName, `${p.id} short 한글 전용`).toMatch(HANGUL_ONLY_RE);
      expect(p.name, `${p.id} 라틴 잔류 금지`).not.toMatch(/[A-Za-z]/);
      expect(p.shortName.length, `${p.id} short ≤ 풀네임`).toBeLessThanOrEqual(p.name.length);
    }
  });

  it("🔴 실명 잔존 0 — 신규명 52종의 **어떤 토큰도** v2.6 실명 토큰과 완전 일치하지 않는다", () => {
    // 명세 §2-1-a "실명 회피" 의 기계 축. **신규 denylist 를 만들지 않는다**(§6-1-9) — 리포에는
    // 실명이 계속 있으므로(D5=ㄱ) 전역 denylist 는 roster/names-ko/personality 와 충돌한다.
    // 대신 "v2.6 실명 토큰과의 완전일치 0" 을 건다 = 실제로 막고 싶은 것.
    expect(renamed).toHaveLength(52);
    expect(realTokens.size).toBeGreaterThan(100); // 도출 집합이 비면 이 계약이 공허해진다
    for (const p of renamed) {
      expect(realFullNames.has(p.name), `${p.id} "${p.name}" 풀네임 실명 일치`).toBe(false);
      for (const t of p.name.split(" ")) {
        expect(realTokens.has(t), `${p.id} 토큰 "${t}" 가 실명 토큰과 일치`).toBe(false);
      }
      expect(realTokens.has(p.shortName), `${p.id} short "${p.shortName}" 실명 토큰 일치`).toBe(false);
    }
  });

  it("활성 62종에 `PARODY_REAL_NAME_KO_DENYLIST` 부분문자열 0", () => {
    for (const p of activeRows) {
      for (const banned of PARODY_REAL_NAME_KO_DENYLIST) {
        expect(p.name.includes(banned), `${p.id} "${p.name}" ⊃ "${banned}"`).toBe(false);
      }
    }
  });

  it("표시명 182 전역 유일 · shortName 활성 62 유일 (V26 허용 중복 2쌍은 활성 구간에서 소멸)", () => {
    expect(new Set(playersV27.map((p) => p.name)).size).toBe(FROZEN_ROSTER_COUNT_V27);
    expect(new Set(activeRows.map((p) => p.shortName)).size).toBe(V27_ACTIVE_TOTAL);
    // ⚠️ shortName **전역** 유일은 성립하지 않는다 — v2.6 허용 중복 2쌍 중 "오나나"는 P105 은퇴 +
    // P074 개명으로 소멸하지만, "루이스"(P101·P118)는 **둘 다 은퇴**라 비활성 구간에 그대로 남는다.
    // 그 사실을 숨기지 않고 박제한다(활성 도감에서는 중복 0 이 참이다 = 명세 §2-1-a 가 요구한 것).
    const dupes = new Map<string, string[]>();
    for (const p of playersV27) dupes.set(p.shortName, [...(dupes.get(p.shortName) ?? []), p.id]);
    const remaining = [...dupes.entries()].filter(([, ids]) => ids.length > 1);
    expect(remaining).toEqual([["루이스", ["P101", "P118"]]]);
    for (const [, ids] of remaining) {
      for (const id of ids) expect(byId.get(id)!.active, `${id} 는 은퇴 카드다`).toBe(false);
    }
  });

  it("은퇴 120종의 표시명은 v2.6 그대로 — 명세가 그들에게 새 이름을 주지 않는다(§3-2 가 v2.6 명으로 식별)", () => {
    for (const p of playersV27.filter((x) => !x.active)) {
      const old = diskV26.find((x) => x.id === p.id)!;
      expect(p.name, `${p.id} 은퇴 카드 이름 무변경`).toBe(old.name);
      expect(p.shortName, `${p.id} 은퇴 카드 short 무변경`).toBe(old.shortName);
    }
  });

  it("EXPECTED_KOREANS 8명의 v2.7 처분 — 5명 은퇴 · 3명 개명(#84 가드가 v2.7 축에 안 걸리는 이유)", () => {
    // 명세 §6-1-8. 이 사실을 박제하지 않으면 다음 사람이 "#84 가드가 왜 v2.7 엔 없나"를 다시 묻는다.
    const byKo = new Map(diskV26.map((p) => [p.name, p]));
    const retired: string[] = [];
    const renamedKo: string[] = [];
    for (const k of EXPECTED_KOREANS) {
      const row = byKo.get(k.ko);
      expect(row, `${k.ko} 존재(v2.6 한글 축)`).toBeDefined();
      const now = byId.get(row!.id)!;
      if (!now.active) retired.push(row!.id);
      else {
        expect(now.name, `${k.ko} 개명됨`).not.toBe(k.ko);
        renamedKo.push(row!.id);
      }
    }
    expect(retired.sort()).toEqual(["P037", "P143", "P144", "P145", "P170"]);
    expect(renamedKo.sort()).toEqual(["P022", "P151", "P161"]);
  });

  it("zod PlayerCard 호환 유지 — 가상명이 계약을 깨지 않는다", () => {
    for (const p of playersV27) {
      const parsed = PlayerCard.safeParse({
        playerId: p.id,
        name: p.name,
        position: p.position,
        attributes: p.attributes,
      });
      expect(parsed.success, `${p.id} ${p.name}`).toBe(true);
    }
  });
});

describe("players.v2.8 — 은퇴 120종 표시명 가상화 = 실명 잔존 0 (#483)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  /** 디스크의 **발행된** v2.7 — 대조 기준을 코드가 아니라 파일에서 가져온다(자기참조 회피, v2.7 선례). */
  const diskV27 = JSON.parse(readFileSync(join(here, "players.v2.7.json"), "utf8")) as {
    id: string;
    name: string;
    position: Position;
    grade: Grade;
    attributes: PlayerSeed["attributes"];
    personality: Personality;
    active: boolean;
    shortName: string;
  }[];
  /** 디스크의 발행된 v2.6 — 실명 축의 SoT. 하드코딩하면 스테일해진다(명세 §6-1-6). */
  const diskV26 = JSON.parse(readFileSync(join(here, "players.v2.6.json"), "utf8")) as typeof diskV27;

  const parodySet = new Set(V26_PARODY_IDS);
  const byId = new Map(playersV28.map((p) => [p.id, p]));
  const retiredIds = diskV27.filter((p) => !p.active).map((p) => p.id);
  /** 개명 대상 = v2.7 비활성 120종. */
  const renamed = playersV28.filter((p) => !p.active);

  // v2.6 발행물에서 **직접 도출**하는 실명 축.
  const realRows = diskV26.filter((p) => !parodySet.has(p.id));
  const realTokens = new Set<string>();
  for (const p of realRows) {
    for (const t of p.name.split(" ")) realTokens.add(t);
    realTokens.add(p.shortName);
  }
  const realFullNames = new Set(realRows.map((p) => p.name));
  /** 한국식(공백 없는) 실명에서 도출한 성·이름 집합. 비한국 3자명(로드리·알리송…)도 포함하는 **초집합**. */
  const realNoSpace = realRows.filter((p) => !p.name.includes(" "));
  const realSurnames = new Set(realNoSpace.map((p) => p.name[0]!));
  const realGivenNames = new Set(realNoSpace.map((p) => p.name.slice(1)));

  // ── ① 이 웨이브의 존재 이유: 실명이 한 건도 안 남는다 ─────────────────────
  it("🔴 v2.8 전 182행에 v2.6 실명(풀네임·shortName)이 **0건** 남는다", () => {
    // 이 트랙의 목적 그 자체. `active` 로는 못 가린다 — 도감·덱은 보유분을 계속 보여준다
    // (`CatalogController` `WHERE p.active = 1 OR 보유수 > 0`, #207 U-D7).
    const leaked = playersV28.filter((p) => realFullNames.has(p.name) || realTokens.has(p.shortName));
    expect(leaked.map((p) => `${p.id}:${p.name}`)).toEqual([]);
  });

  it("개명 표가 v2.7 비활성 집합과 **정확히 일치** — 한 명도 빠지지 않는다", () => {
    expect(V28_RETIRED_CARDS).toHaveLength(120);
    expect(V28_RETIRED_CARDS.map((c) => c.id).sort()).toEqual([...retiredIds].sort());
    // 활성은 한 건도 표에 없다(스코프 경계).
    for (const c of V28_RETIRED_CARDS) {
      expect(diskV27.find((p) => p.id === c.id)!.active, `${c.id} 는 비활성이어야 개명 대상`).toBe(false);
    }
  });

  it("`from` 앵커가 v2.7 발행물의 현재 이름과 일치 — 행이 밀리면 여기서 터진다", () => {
    const v27ById = new Map(diskV27.map((p) => [p.id, p]));
    for (const c of V28_RETIRED_CARDS) {
      expect(v27ById.get(c.id)!.name, `${c.id} 앵커`).toBe(c.from);
    }
  });

  // ── ② 활성 62종은 한 글자도 안 바뀐다 (v2.7 계약 승계) ────────────────────
  it("활성 62종이 v2.7 발행물과 **바이트 동일** — 이 레이어는 은퇴 구간만 만진다", () => {
    const a = diskV27.filter((p) => p.active);
    const b = playersV28.filter((p) => p.active);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("`active` 격자 62/120 불변 · 표시명 밖 축은 v2.7 과 완전 동일", () => {
    expect(playersV28).toHaveLength(diskV27.length);
    expect(playersV28.filter((p) => p.active)).toHaveLength(62);
    expect(playersV28.filter((p) => !p.active)).toHaveLength(120);
    for (let i = 0; i < diskV27.length; i++) {
      const { name: _n, shortName: _s, ...before } = diskV27[i]!;
      const { name: _m, shortName: _t, ...after } = playersV28[i]!;
      expect(after, `${diskV27[i]!.id} 표시명 밖 축`).toEqual(before);
    }
  });

  // ── ③ 작명 규칙 (spec §2-1-a / §2-2 승계) ────────────────────────────────
  it("신규명의 **모든 토큰**이 v2.6 실명 토큰과 완전 일치 0", () => {
    for (const c of V28_RETIRED_CARDS) {
      for (const t of new Set([...c.to.split(" "), c.short])) {
        expect(realTokens.has(t), `${c.id} "${c.to}" 의 토큰 "${t}"`).toBe(false);
      }
    }
  });

  it("PARODY_REAL_NAME_KO_DENYLIST 9건이 **부분문자열로도** 안 들어간다", () => {
    for (const c of V28_RETIRED_CARDS) {
      for (const d of PARODY_REAL_NAME_KO_DENYLIST) {
        expect(c.to.includes(d), `${c.id} "${c.to}" ⊃ "${d}"`).toBe(false);
        expect(c.short.includes(d), `${c.id} short "${c.short}" ⊃ "${d}"`).toBe(false);
      }
    }
  });

  it("형식 — 한글 전용 · 길이 상한 · shortName 은 풀네임의 토큰", () => {
    const HANGUL_ONLY = /^[가-힣]+(?: [가-힣]+)*$/;
    for (const c of V28_RETIRED_CARDS) {
      expect(HANGUL_ONLY.test(c.to), `${c.id} "${c.to}" 한글 전용`).toBe(true);
      expect(HANGUL_ONLY.test(c.short), `${c.id} short "${c.short}" 한글 전용`).toBe(true);
      expect(c.to.length, `${c.id} 풀네임 길이`).toBeLessThanOrEqual(14);
      expect(c.short.length, `${c.id} short 길이`).toBeLessThanOrEqual(8);
      expect(c.short.length).toBeLessThanOrEqual(c.to.length);
      expect(c.short === c.to || c.to.split(" ").includes(c.short), `${c.id} short ⊂ 풀네임`).toBe(true);
    }
  });

  it("한국식 24종 — 3자 · `short == name` · v2.6 실명 성/이름 집합과 충돌 0", () => {
    const kor = V28_RETIRED_CARDS.filter((c) => !c.to.includes(" "));
    expect(kor).toHaveLength(24);
    for (const c of kor) {
      expect(/^[가-힣]{3}$/.test(c.to), `${c.id} "${c.to}" 3자`).toBe(true);
      expect(c.short, `${c.id} short == name`).toBe(c.to);
      expect(realSurnames.has(c.to[0]!), `${c.id} 성 "${c.to[0]}"`).toBe(false);
      expect(realGivenNames.has(c.to.slice(1)), `${c.id} 이름 "${c.to.slice(1)}"`).toBe(false);
    }
    // 나머지는 외국식 2토큰(`short` = 뒤 토큰).
    const foreign = V28_RETIRED_CARDS.filter((c) => c.to.includes(" "));
    expect(foreign).toHaveLength(96);
    for (const c of foreign) expect(c.short).toBe(c.to.split(" ").at(-1));
  });

  // ── ④ 유일성 — v2.7 이 못 걸던 것을 **전역으로 올린다** ────────────────────
  it("풀네임·shortName 이 **182 전역 유일** — v2.7 의 비활성 중복 2쌍이 개명으로 해소됐다", () => {
    // v2.7 은 shortName 유일을 활성 62 안에서만 걸었다: 비활성에 "루이스"(P101·P118)가 남아서다.
    // 그 두 행이 이번에 개명되므로 전역 유일이 **성립하고**, 그래서 계약을 전역으로 올린다.
    expect(new Set(playersV28.map((p) => p.name)).size).toBe(playersV28.length);
    expect(new Set(playersV28.map((p) => p.shortName)).size).toBe(playersV28.length);
    // 회귀 방향 박제: v2.7 에서는 실제로 중복이었다(계약이 느슨했던 게 아니라 사실이 그랬다).
    expect(new Set(diskV27.map((p) => p.shortName)).size).toBeLessThan(diskV27.length);
  });

  // ── ⑤ 과거 발행 축 무회귀 ────────────────────────────────────────────────
  it("발행물 v2 ~ v2.7 이 여전히 **바이트 동일** 재현된다 — v2.8 이 과거 축을 안 건드렸다", () => {
    const cases: readonly [string, unknown][] = [
      ["players.v2.json", playersV2],
      ["players.v2.1.json", playersV21],
      ["players.v2.2.json", playersV22],
      ["players.v2.3.json", playersV23],
      ["players.v2.4.json", playersV24],
      ["players.v2.5.json", playersV25],
      ["players.v2.6.json", playersV26],
      ["players.v2.7.json", playersV27],
    ];
    for (const [file, data] of cases) {
      expect(readFileSync(join(here, file), "utf8"), file).toBe(JSON.stringify(data, null, 2) + "\n");
    }
  });

  it("bots.v4 · economy.v4 의 활성 참조가 v2.8 에서도 성립한다 (`active` 무접촉의 귀결)", () => {
    const activeIds = new Set(playersV28.filter((p) => p.active).map((p) => p.id));
    for (const bot of botsV4) {
      // ⚠️ 두 축의 모양이 다르다 — starters 는 `{playerId, slotIndex}` 객체, bench 는 id 문자열.
      const ids = [...bot.deck.starters.map((s) => s.playerId), ...bot.deck.bench];
      for (const id of ids) expect(activeIds.has(id), `bots.v4 ${bot.id} ${id}`).toBe(true);
    }
    for (const id of [...economyV4.starterPack, ...economyV4.starterTop!.pool]) {
      expect(activeIds.has(id), `economy.v4 ${id}`).toBe(true);
    }
  });

  it("zod PlayerCard 호환 유지 — 가상명이 계약을 깨지 않는다", () => {
    for (const p of playersV28) {
      const parsed = PlayerCard.safeParse({
        playerId: p.id,
        name: p.name,
        position: p.position,
        attributes: p.attributes,
      });
      expect(parsed.success, `${p.id} ${p.name}`).toBe(true);
    }
  });

  it("개명이 **행마다 1:1** — 두 행의 이름이 뒤바뀌지 않았다(기계가 잡을 수 있는 부분만)", () => {
    // ⚠️ 이 계약은 "올바른 행에 붙었나"를 **완전히는 못 잡는다** — `from` 앵커가 id 별이라
    // 두 행의 `to` 를 통째로 맞바꿔도 전 가드가 통과한다(#406 독립검증 minor-2, `data/CLAUDE.md` 명시).
    // 사람이 눈으로 본 근거 = `epics/483-fictional-rename/naming-log.md`. 여기서는 표가 실제로
    // 발행물에 반영됐는지(빠뜨림·중복 적용 0)만 건다.
    for (const c of V28_RETIRED_CARDS) {
      const row = byId.get(c.id)!;
      expect(row.name, `${c.id} 적용`).toBe(c.to);
      expect(row.shortName, `${c.id} short 적용`).toBe(c.short);
    }
    expect(renamed).toHaveLength(120);
  });
});

describe("bots.v4 — 은퇴 참조 재매핑 (#450 §6-4)", () => {
  const byId = new Map(playersV27.map((p) => [p.id, p]));
  const sum = (id: string) =>
    Object.values(byId.get(id)!.attributes).reduce((a: number, b: number) => a + b, 0);
  const startersOfV4 = (b: (typeof botsV4)[number]) => b.deck.starters.map((s) => s.playerId);

  it("id 3종은 v3 와 같다 — matches.bot_id FK 가 과거 매치에서 이 id 를 참조한다", () => {
    expect(botsV4.map((b) => b.id)).toEqual(botsV3.map((b) => b.id));
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 덱 전문이 명세 §6-4 와 일치", (botId) => {
    const b = botsV4.find((x) => x.id === botId)!;
    const spec = V27_BOT_DECKS[botId]!;
    expect(b.deck.formation).toBe(spec.formation);
    expect(startersOfV4(b)).toEqual([...spec.starters]);
    expect(b.deck.bench).toEqual([...spec.bench]);
  });

  it("봇 3덱 45슬롯에 **중복 playerId 0** — deck_slots PK 위반 방지", () => {
    for (const b of botsV4) {
      const all = [...startersOfV4(b), ...b.deck.bench];
      expect(all).toHaveLength(15);
      expect(new Set(all).size, `${b.id} 중복`).toBe(15);
    }
    expect(botsV4.flatMap((b) => [...startersOfV4(b), ...b.deck.bench])).toHaveLength(45);
  });

  it("🔴 봇 참조 **전량이 v2.7 활성** — 없으면 다음 개편에서 같은 사고가 조용히 난다", () => {
    const active = new Set(playersV27.filter((p) => p.active).map((p) => p.id));
    for (const b of botsV4) {
      for (const id of [...startersOfV4(b), ...b.deck.bench]) {
        expect(active.has(id), `${b.id} → ${id} 비활성 참조`).toBe(true);
      }
    }
    // 대조: v3 는 은퇴 카드를 실제로 참조하고 있었다(이 계약이 무의미하지 않다는 증거).
    const v3refs = botsV3.flatMap((b) => [...b.deck.starters.map((s) => s.playerId), ...b.deck.bench]);
    expect(v3refs.filter((id) => !active.has(id)).length).toBeGreaterThan(0);
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 선발 11 의 포지션 구성이 formation 과 정합", (botId) => {
    const b = botsV4.find((x) => x.id === botId)!;
    const pos = startersOfV4(b).map((id) => byId.get(id)!.position);
    expect(pos.filter((x) => x === "GK"), `${botId} GK`).toHaveLength(1);
    // formation "4-3-3" = DF-MF-FW. 5-3-2 는 DF5, 4-4-2 는 MF4 — 필드 10명이 그 합이어야 한다.
    const [df, mf, fw] = b.deck.formation.split("-").map(Number) as [number, number, number];
    expect(df + mf + fw).toBe(10);
    expect(pos.filter((x) => x === "DF").length, `${botId} DF`).toBe(df);
    // ⚠️ MF/FW 는 formation 과 **1명 어긋난다**(BOT_ATK MF3/FW3 vs 3-3 은 맞고, BOT_DEF·BOT_BAL 은
    // v3 부터 MF 가 하나 적고 FW 가 하나 많거나 그 반대다). 그건 v3 가 만든 성질이고 이 웨이브는
    // **등급 교체만** 했으므로, 계약은 "v3 와 같은 구성인가"로 건다(아래 별도 it).
    expect(pos.filter((x) => x === "MF").length + pos.filter((x) => x === "FW").length).toBe(mf + fw);
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 포지션 구성이 v3 와 동일 — 교체는 카드만", (botId) => {
    const key = (ids: readonly string[]) => ids.map((id) => byId.get(id)!.position).sort().join(",");
    expect(key(startersOfV4(botsV4.find((x) => x.id === botId)!))).toBe(
      key(botsV3.find((x) => x.id === botId)!.deck.starters.map((s) => s.playerId)),
    );
  });

  it("🔴 선발 평균 총합 변동 = 기대 델타 박제 — #252 상대 밸런스를 다시 열지 않는다", () => {
    // 명세 §6-4 실측: BOT_ATK 352.4→353.5 · BOT_DEF 406.5→406.7 · BOT_BAL 343.9→344.4.
    //
    // ⚠️ 초판은 `≤0.5%` 임계였는데 **회귀 신호가 0 이었다**(독립검증 minor-7) — 같은 describe 의
    // "덱 전문이 명세 §6-4 와 일치" 가 선발 11 을 id 단위로 박제하므로, 그 뒤에서 이 임계는 항상 참이다.
    // 완화 자체의 위험은 0 이지만 **탐지력도 0** 이라 임계를 없애고 **기대 델타 3값을 직접 박는다.**
    // 이러면 덱 계약이 갱신되는 미래 웨이브에서 전력 변동이 실제로 움직였는지가 이 줄에서 드러난다.
    const EXPECTED_PCT: Readonly<Record<string, number>> = {
      BOT_ATK: 0.00310,
      BOT_DEF: 0.00067,
      BOT_BAL: 0.00132,
    };
    for (const b4 of botsV4) {
      const b3 = botsV3.find((x) => x.id === b4.id)!;
      const before = b3.deck.starters.reduce((a, s) => a + sum(s.playerId), 0) / 11;
      const after = startersOfV4(b4).reduce((a, id) => a + sum(id), 0) / 11;
      const pct = Math.abs(after - before) / before;
      expect(pct, `${b4.id} ${before.toFixed(2)}→${after.toFixed(2)}`).toBeCloseTo(
        EXPECTED_PCT[b4.id]!,
        5,
      );
      // 방향 무관하게 "#252 를 다시 여는 크기"는 아니라는 상한도 같이 남긴다(문서적 하한선).
      expect(pct, `${b4.id} 상한`).toBeLessThanOrEqual(0.005);
    }
  });

  it("BOT_BAL 벤치에만 SILVER 2장 — 잔류 BRONZE 13종 제약의 처방(봇 무교체라 전력 영향 0)", () => {
    const bal = botsV4.find((b) => b.id === "BOT_BAL")!;
    // 선발 11 은 전원 BRONZE 여야 한다(그게 "전력 영향 0"의 근거다).
    for (const id of startersOfV4(bal)) expect(byId.get(id)!.grade, id).toBe("BRONZE");
    const benchGrades = bal.deck.bench.map((id) => byId.get(id)!.grade);
    expect(benchGrades.filter((g) => g === "SILVER")).toHaveLength(2);
    expect(benchGrades.filter((g) => g === "BRONZE")).toHaveLength(2);
    // 제약의 실체: 활성 BRONZE 가 13종뿐이라 15장을 BRONZE 로 못 채운다.
    expect(playersV27.filter((p) => p.active && p.grade === "BRONZE")).toHaveLength(13);
  });

  it("persona·analysisText·strengthMul·formation·slotIndex·promptText 무변경 — 교체는 playerId 뿐", () => {
    for (const b4 of botsV4) {
      const b3 = botsV3.find((x) => x.id === b4.id)!;
      expect(b4.name).toBe(b3.name);
      expect(b4.persona).toBe(b3.persona);
      expect(b4.analysisText).toBe(b3.analysisText);
      expect(b4.strengthMul ?? 1).toBe(b3.strengthMul ?? 1);
      expect(b4.deck.formation).toBe(b3.deck.formation);
      expect(b4.deck.starters.map((s) => s.slotIndex)).toEqual(b3.deck.starters.map((s) => s.slotIndex));
      expect(b4.deck.starters.map((s) => s.promptText ?? null)).toEqual(
        b3.deck.starters.map((s) => s.promptText ?? null),
      );
    }
    // BOT_ATK 슬롯 8·9 "적극 침투" 가 그대로 살아 있는지 명시(명세 §6-4 검증줄).
    const atk = botsV4.find((b) => b.id === "BOT_ATK")!;
    expect(atk.deck.starters.filter((s) => s.promptText === "적극 침투").map((s) => s.slotIndex)).toEqual([8, 9]);
  });

  it("v3 는 바이트 불변 — v4 는 새 파일이다(발행 후 수정 금지)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(join(here, "bots.v3.json"), "utf8")).toBe(
      JSON.stringify(botsV3, null, 2) + "\n",
    );
  });
});

describe("economy.v4 — 스타터 재설계 (#450 §5)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  /**
   * ⚠️ **승계 원본은 디스크 v3 발행물**이다(생성기의 메모리 `economyV3` 가 아니다).
   * `economy.v3.json` 은 발행 후 세 웨이브(#251 · #368 · #408)가 **JSON 을 직접 편집**해 확장했고
   * 생성기는 안 고쳤다 — 그래서 메모리 객체에는 `league.dailyReward`·`mission` 이 아예 없다.
   * 여기서 디스크를 기준으로 잡는 것이 "그 외 전 필드 v3 바이트 승계"(명세 §6-5)의 유일한 해석이다.
   */
  const diskV3 = JSON.parse(readFileSync(join(here, "economy.v3.json"), "utf8")) as Record<string, unknown>;
  const v4 = JSON.parse(readFileSync(join(here, "economy.v4.json"), "utf8")) as Record<string, unknown>;

  it("version = v4 · 디스크 v3 대비 **바뀐 키가 정확히 3개**(version · starterPack · starterTop)", () => {
    expect(v4["version"]).toBe("v4");
    expect(Object.keys(v4)).toEqual(Object.keys(diskV3)); // 키 순서·개수까지 동일(additive 0)
    const changed = Object.keys(diskV3).filter(
      (k) => JSON.stringify(diskV3[k]) !== JSON.stringify(v4[k]),
    );
    expect(changed.sort()).toEqual(["starterPack", "starterTop", "version"]);
  });

  it("🔴 `gacha.rates` · `star.copies` · `tenPityMinGrade` **무접촉** — 종수 축소만으로 D2 를 달성한다", () => {
    // 명세 §1-6. 확률을 건드리면 밸런스(#252)·리그 디비전 편성이 같이 움직인다.
    const g3 = diskV3["gacha"] as Record<string, unknown>;
    const g4 = v4["gacha"] as Record<string, unknown>;
    expect(g4).toEqual(g3);
    expect(g4["rates"]).toEqual({ BRONZE: 0.45, SILVER: 0.3, GOLD: 0.15, DIA: 0.08, LEGEND: 0.02 });
    expect(g4["tenPityMinGrade"]).toBe("GOLD");
    expect((v4["star"] as Record<string, unknown>)["copies"]).toEqual({ "2": 2, "3": 3, "4": 5 });
    expect(v4["star"]).toEqual(diskV3["star"]);
  });

  it("🔴 나중 웨이브가 v3 에 얹은 블록이 살아 있다 — #251 시즌 다이아 · #368 리그 18칸 · #408 미션", () => {
    // 이 계약이 없으면 "메모리 economyV3 로 v4 를 빚는" 실수가 조용히 세 기능을 지운다(실제로 밟았다).
    expect(v4["mission"]).toEqual(diskV3["mission"]);
    const l4 = v4["league"] as Record<string, unknown>;
    expect(l4).toEqual(diskV3["league"]);
    expect(l4["dailyReward"], "#368 리그 매판 보상 트랙").toBeDefined();
    expect((l4["gemReward"] as Record<string, unknown>)["completion"], "#251 시즌 종료 다이아").toBeDefined();
    expect(v4["mission"], "#408 원정 데일리 미션").toBeDefined();
  });

  it("starterPack v4 = 14장 (GK2 / DF5 / MF4 / FW3) · 명세 §5-2 목록 그대로", () => {
    expect(v4["starterPack"]).toEqual([...V27_STARTER_PACK]);
    const byId = new Map(playersV27.map((p) => [p.id, p]));
    const pack = V27_STARTER_PACK.map((id) => byId.get(id)!);
    expect(pack).toHaveLength(14);
    expect(new Set(V27_STARTER_PACK).size).toBe(14);
    const count = (pos: Position) => pack.filter((p) => p.position === pos).length;
    expect({ GK: count("GK"), DF: count("DF"), MF: count("MF"), FW: count("FW") }).toEqual({
      GK: 2, DF: 5, MF: 4, FW: 3,
    });
    // hero 가 지목한 결함: 현행은 GK 1장이라 대다수가 골키퍼를 한 번도 못 바꿨다 → 2장.
    expect((diskV3["starterPack"] as string[]).filter((id) => byId.get(id)!.position === "GK")).toHaveLength(1);
    // SILVER 13종 전량(H7) + 5백 편성용 BRONZE DF 1장(P122).
    expect(pack.filter((p) => p.grade === "SILVER")).toHaveLength(13);
    expect(pack.filter((p) => p.grade === "BRONZE").map((p) => p.id)).toEqual(["P122"]);
    expect(playersV27.filter((p) => p.active && p.grade === "SILVER").map((p) => p.id).sort()).toEqual(
      pack.filter((p) => p.grade === "SILVER").map((p) => p.id).sort(),
    );
  });

  it("starterTop.pool = 활성 LEGEND 10종 **전량** · count 1 — 비활성 지급 0(#207 사고 부류)", () => {
    const top = v4["starterTop"] as { pool: string[]; count: number };
    expect(top.pool).toEqual([...V27_STARTER_TOP]);
    expect(top.count).toBe(1);
    const activeLegend = playersV27.filter((p) => p.active && p.grade === "LEGEND").map((p) => p.id);
    expect([...top.pool].sort()).toEqual([...activeLegend].sort());
    // 핵심: LEGEND GK 2종이 pool 에 있어 신규 유저의 1/5 이 최상위 골키퍼로 시작한다(§5-3).
    const byId = new Map(playersV27.map((p) => [p.id, p]));
    expect(top.pool.filter((id) => byId.get(id)!.position === "GK").sort()).toEqual(["P178", "P182"]);
    expect(top.pool.filter((id) => byId.get(id)!.position === "DF")).toEqual(["P181"]);
  });

  it("가입 지급 전량이 v2.7 활성 — starterPack + starterTop 어느 쪽도 비활성 유닛을 주지 않는다", () => {
    const active = new Set(playersV27.filter((p) => p.active).map((p) => p.id));
    const top = v4["starterTop"] as { pool: string[] };
    for (const id of [...(v4["starterPack"] as string[]), ...top.pool]) {
      expect(active.has(id), `${id} 비활성 지급`).toBe(true);
    }
    // 대조: 구 v3 팩은 은퇴 카드 2종(P081 · P092)을 주고 있었다 = 이 계약이 실제로 무언가를 막는다.
    expect((diskV3["starterPack"] as string[]).filter((id) => !active.has(id)).sort()).toEqual([
      "P081", "P092",
    ]);
  });

  it("v3 는 바이트 불변 — 생성기가 더 이상 v3 를 덮어쓰지 않는다(#450 W1 발견)", () => {
    // ⚠️ 이 웨이브 전까지 CLI 가 매 실행마다 `economy.v3.json` 을 **재생성**했고, 그 출력에는
    // #251/#368/#408 의 세 블록이 없다 = 실행할 때마다 조용히 세 기능이 지워진다(실제로 한 번 밟았다).
    // 대조 계약이 발행 파일 동기화 목록에서도 빠져 있어 어디서도 안 걸렸다.
    // 지금은 CLI 가 v3 를 쓰지 않는다 — 그 사실을 "디스크 v3 ≠ 메모리 economyV3" 로 박제한다.
    expect(JSON.stringify(diskV3)).not.toBe(JSON.stringify(economyV3));
    expect((diskV3["mission"] as unknown) !== undefined).toBe(true);
    expect((economyV3 as unknown as Record<string, unknown>)["mission"]).toBeUndefined();
  });

  it("생성기 소스에 v3 쓰기가 없다 — 재유입 창을 정적으로 막는다(독립검증 minor-2)", () => {
    // ⚠️ 위 계약만으로는 부족하다. 그것은 **런타임 상태**(디스크 ≠ 메모리)를 재는 것이라,
    // `writeFileSync(economy.v3.json, …)` 이 소스에 재유입돼도 **누군가 generate 를 돌리기 전까지는
    // green** 이다 = #453 이 조용히 재발할 창이 열려 있다. 그 창을 소스 정적 검사로 닫는다.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "generate.ts"), "utf8");
    const writes = [...src.matchAll(/writeFileSync\(\s*\n?\s*join\([^)]*`economy\.\$\{(\w+)\}\.json`/g)]
      .map((m) => m[1]);
    expect(writes, "생성기가 쓰는 economy 버전 상수").not.toContain("ECONOMY_V3_VERSION");
    // 공허 방지 — 이 정규식이 실제로 무언가를 잡고 있음을 증명한다(v2·v4 는 계속 쓴다).
    expect(writes.length, "economy 쓰기가 하나도 안 잡히면 정규식이 죽은 것").toBeGreaterThanOrEqual(2);
    expect(writes).toContain("ECONOMY_V4_VERSION");
  });
});

describe("동결 발행물 불변 — 기존 172명 바이트 동일 (#207 결정론 가드)", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("v2.2 앞 172명이 디스크의 players.v2.1.json 과 바이트 동일 — append 가 RNG 스트림을 밀지 않았다", () => {
    // 이게 §1 결정론 가드의 핵심: ROSTER 중간 삽입이면 172명 attributes 가 전부 shift 되어
    // 기보유 유저 카드가 통째로 바뀐다. 발행 파일과 직접 대조해 그걸 원천 차단한다.
    const onDisk = readFileSync(join(here, "players.v2.1.json"), "utf8");
    const parsed = JSON.parse(onDisk) as unknown[];
    expect(parsed).toHaveLength(FROZEN_TOTAL);
    const head = playersV22.slice(0, FROZEN_TOTAL).map(({ active, ...rest }) => rest);
    expect(JSON.stringify(head, null, 2) + "\n").toBe(onDisk);
  });

  it("v2.2 앞 172명의 name/position/grade/attributes 가 v2.1 과 필드 단위로 동일", () => {
    const onDisk = JSON.parse(
      readFileSync(join(here, "players.v2.1.json"), "utf8"),
    ) as { id: string; name: string; position: Position; grade: Grade; attributes: PlayerSeed["attributes"] }[];
    onDisk.forEach((old, i) => {
      const now = playersV22[i]!;
      expect(now.id, `#${i} id`).toBe(old.id);
      expect(now.name, `${old.id} name`).toBe(old.name);
      expect(now.position, `${old.id} position`).toBe(old.position);
      expect(now.grade, `${old.id} grade`).toBe(old.grade);
      expect(now.attributes, `${old.id} attributes`).toEqual(old.attributes);
    });
  });

  it("economy starterPack / 봇 덱이 신규 8종을 참조하지 않는다(등급 축·구성 무변경)", () => {
    const newIds = new Set(NEW_UNITS.map((u) => u.id));
    for (const id of economy.starterPack) expect(newIds.has(id), `starterPack ${id}`).toBe(false);
    for (const b of bots) {
      for (const s of b.deck.starters) expect(newIds.has(s.playerId), `${b.id} ${s.playerId}`).toBe(false);
      for (const id of b.deck.bench) expect(newIds.has(id), `${b.id} bench ${id}`).toBe(false);
    }
  });

  it("economy 등급 축 무변경 — gacha.rates·gradeXpMult·trade 등급표 (U-D1 조합안)", () => {
    expect(economy.gacha.rates).toEqual({
      BRONZE: 0.45,
      SILVER: 0.3,
      GOLD: 0.15,
      DIA: 0.08,
      LEGEND: 0.02,
    });
    expect(economy.growth.gradeXpMult).toEqual({
      BRONZE: 0.4,
      SILVER: 0.4,
      GOLD: 1.0,
      DIA: 1.5,
      LEGEND: 3.0,
    });
    expect(economy.trade.waitHours.LEGEND).toBe(72);
    // #212 재화 정돈이 byGrade·attrSumCoeff 를 함께 ×10 했다(카드 대 카드 비율은 불변, 환율만 이동).
    // 그 커밋이 생성기만 올리고 이 기대값을 놓쳐 main 이 red 였다 — 리스케일이 의도이므로 값을 맞춘다.
    expect(economy.trade.value.byGrade.LEGEND).toBe(30000);
    expect(economy.trade.targetRarityWeights.LEGEND).toBe(0.05);
    expect(economy.potential.linesByGrade.LEGEND).toBe(3);
    expect(economy.potential.gradeTierCap.LEGEND).toBe("UNIQUE");
  });
});

describe("league.v1 — 봇 리그 시드(클럽명·성향·보상)", () => {
  it("version === 'v1'", () => {
    expect(league.version).toBe("v1");
  });

  it("가상 클럽명 20개+ · 전부 유일", () => {
    expect(league.clubNames.length).toBeGreaterThanOrEqual(20);
    expect(new Set(league.clubNames).size).toBe(league.clubNames.length);
    for (const n of league.clubNames) expect(n.trim().length).toBeGreaterThan(0);
  });

  it("실클럽 denylist — 어떤 클럽명도 실클럽 풀네임과 정확 일치하지 않음(대소문자 무시)", () => {
    const deny = new Set(REAL_CLUB_NAMES.map((n) => n.toLowerCase()));
    for (const n of league.clubNames) {
      expect(deny.has(n.toLowerCase()), `가상 클럽명 "${n}" 이 실클럽과 일치`).toBe(false);
    }
  });

  it("실클럽 고유 도시/식별 토큰 미포함(일반 접미사 제외) — 실명 유출 방지", () => {
    for (const n of league.clubNames) {
      for (const tok of REAL_CLUB_TOKENS) {
        expect(n.includes(tok), `클럽명 "${n}" 에 실클럽 토큰 "${tok}" 포함`).toBe(false);
      }
    }
  });

  it("팀 성향 프리셋 6종+ · id 유일 · tactics 4축 0..1", () => {
    expect(league.personaPresets.length).toBeGreaterThanOrEqual(6);
    const ids = league.personaPresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of league.personaPresets) {
      expect(preset.name.length, `${preset.id} name`).toBeGreaterThan(0);
      expect(preset.description.length, `${preset.id} description`).toBeGreaterThan(0);
      expect(preset.formation.length, `${preset.id} formation`).toBeGreaterThan(0);
      for (const axis of ["line", "press", "tempo", "width"] as const) {
        const v = preset.tactics[axis];
        expect(v, `${preset.id}.${axis}`).toBeGreaterThanOrEqual(0);
        expect(v, `${preset.id}.${axis}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("순위 보상표 — rank 1..10 연속 · 포인트 단조 감소 · 전원 양수", () => {
    expect(league.rewards.length).toBe(10);
    league.rewards.forEach((r, i) => {
      expect(r.rank, `보상[${i}].rank`).toBe(i + 1);
      expect(r.points, `rank ${r.rank} points>0`).toBeGreaterThan(0);
      if (i > 0) {
        expect(r.points, `rank ${r.rank} < rank ${i}`).toBeLessThan(league.rewards[i - 1]!.points);
      }
    });
  });

  // #212 hero 목표 곡선의 마지막 구간: "리그 최종성적은 성적 따라 많이, 잘할수록 가파르게".
  // 단조 감소만으로는 부족하다 — 이전 곡선(3000→200)도 단조였지만 매판 누적에 묻혔다.
  // 그래서 **우승의 지배력**과 **상위 구간의 급감**을 수치로 박제한다.
  it("우승이 압도적 — rank1 ≥ rank2 × 4 (통 크게)", () => {
    const [first, second] = league.rewards;
    expect(first!.points).toBeGreaterThanOrEqual(second!.points * 4);
  });

  it("상위 구간이 가파르다 — rank1 ≥ rank10 × 50 (하위는 참가 보상 수준)", () => {
    const first = league.rewards[0]!;
    const last = league.rewards[league.rewards.length - 1]!;
    expect(first.points).toBeGreaterThanOrEqual(last.points * 50);
  });

  it("우승 1회 > 리그 18R 전승 매판 합계 (최종성적이 지배 레버)", () => {
    const perWin = economy.rewards.byMode.league.win;
    expect(league.rewards[0]!.points).toBeGreaterThan(perWin * 18);
  });
});

describe("economy.v2 — 트레이드 수치(P2-D9 / LLD-p2-server §5)", () => {
  const t = economy.trade;

  it("슬롯 3 · kindWeights 합=1", () => {
    expect(t.slots).toBe(3);
    expect(t.kindWeights.FA + t.kindWeights.TRADE).toBeCloseTo(1, 10);
  });

  it("레어도별 대기시간 — BRONZE1/SILVER6/GOLD24/DIA48/LEGEND72 (h)", () => {
    expect(t.waitHours).toEqual({ BRONZE: 1, SILVER: 6, GOLD: 24, DIA: 48, LEGEND: 72 });
  });

  it("대기시간 단조 증가 — 레어도 높을수록 길다", () => {
    const order: Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];
    for (let i = 1; i < order.length; i++) {
      expect(t.waitHours[order[i]!]).toBeGreaterThan(t.waitHours[order[i - 1]!]);
    }
  });

  it("target 레어도 가중 합=1 · 전부 양수 · 저등급이 더 흔함", () => {
    const w = t.targetRarityWeights;
    const sum = (Object.values(w) as number[]).reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(1, 10);
    for (const g of GRADES) expect(w[g], `${g} weight>0`).toBeGreaterThan(0);
    expect(w.LEGEND).toBeLessThan(w.DIA);
    expect(w.DIA).toBeLessThan(w.GOLD);
  });

  it("단축 비용 계수 — pointsPerHour>0, minPoints>0 (잔여시간 비례, AC-D4)", () => {
    expect(t.speedup.pointsPerHour).toBeGreaterThan(0);
    expect(t.speedup.minPoints).toBeGreaterThan(0);
  });

  it("FA 확률 곡선 — base/k 범위 · minProb<maxProb · 쿨타임>0 (AC-D2)", () => {
    expect(t.fa.base).toBeGreaterThanOrEqual(0);
    expect(t.fa.base).toBeLessThanOrEqual(1);
    expect(t.fa.k).toBeGreaterThan(0);
    expect(t.fa.minProb).toBeGreaterThanOrEqual(0);
    expect(t.fa.maxProb).toBeLessThanOrEqual(1);
    expect(t.fa.minProb).toBeLessThan(t.fa.maxProb);
    expect(t.fa.reproposalCooldownHours).toBeGreaterThan(0);
  });

  it("TRADE 수락 확률 = 0.8 (AC-D3) · 0..1", () => {
    expect(t.tradeOffer.acceptProb).toBe(0.8);
    expect(t.tradeOffer.acceptProb).toBeGreaterThan(0);
    expect(t.tradeOffer.acceptProb).toBeLessThanOrEqual(1);
  });

  it("가치함수 — 등급 기본값 단조 증가 · attrSumCoeff>0", () => {
    const v = t.value;
    const order: Grade[] = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"];
    for (let i = 1; i < order.length; i++) {
      expect(v.byGrade[order[i]!], `${order[i]} value`).toBeGreaterThan(v.byGrade[order[i - 1]!]);
    }
    expect(v.attrSumCoeff).toBeGreaterThan(0);
  });

  it("리그 보상 참조 — league.v1.json#rewards 를 가리킨다(단일 원천)", () => {
    expect(economy.league.rewardsFile).toBe("league.v1.json");
    expect(economy.league.rewardsRef).toBe("rewards");
  });
});

describe("발행 파일 동기화 — v2 파일 = generateAll() 직렬화 결과", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cases: readonly [string, unknown][] = [
    ["players.v2.json", playersV2],
    ["players.v2.1.json", playersV21],
    ["players.v2.2.json", playersV22],
    ["players.v2.3.json", playersV23],
    ["players.v2.4.json", playersV24],
    ["players.v2.5.json", playersV25],
    ["players.v2.6.json", playersV26],
    ["players.v2.7.json", playersV27],
    ["players.v2.8.json", playersV28],
    ["players.v2.8.1.json", playersV281],
    ["economy.v2.json", economy],
    ["bots.v2.json", bots],
    ["league.v1.json", league],
    ["bots.v3.json", botsV3],
    ["league.v2.json", leagueV2],
    ["bots.v4.json", botsV4],
    ["economy.v4.json", economyV4],
  ];
  // ⚠️ `economy.v3.json` 은 이 목록에 **넣을 수 없다** — 발행 후 세 웨이브(#251·#368·#408)가 JSON 을
  // 직접 편집해 확장했고 생성기는 안 고쳤다. 그 드리프트가 이 목록의 공백 때문에 어디서도 안 걸렸다
  // (#450 W1 발견).
  //
  // ⚠️ 반면 `economy.v4.json` 은 **반드시 넣는다**. 초판은 "v4 는 디스크 v3 를 입력으로 만들어지므로
  // 여기가 아니라 v4 describe 가 디스크 대 디스크로 대조한다"고 제외했는데 **그 논리는 성립하지 않는다**
  // — 생성기의 `economyV4` 도 같은 디스크 v3 를 읽으므로 목록에 넣으면 그대로 통과한다(실측 확인).
  // 제외해 두면 "생성기 출력 ≠ 디스크 v4" 가 되어도 red 가 안 뜨고 다음 `npm run generate` 가 출하물을
  // 조용히 바꾼다 = **이 웨이브가 밟은 #453 지뢰와 정확히 같은 부류의 구멍**이다(독립검증 minor-1).

  it.each(cases)("%s 가 디스크에서 바이트 동일(수정·재생성 누락 검출)", (file, data) => {
    const onDisk = readFileSync(join(here, file as string), "utf8");
    expect(onDisk).toBe(JSON.stringify(data, null, 2) + "\n");
  });
});

describe("재생성 결정론 (AC-PL1)", () => {
  it("generateAll()을 두 번 호출하면 바이트(JSON.stringify) 동일", () => {
    const a = generateAll();
    const b = generateAll();
    expect(JSON.stringify(a.players, null, 2)).toBe(JSON.stringify(b.players, null, 2));
    expect(JSON.stringify(a.playersV2, null, 2)).toBe(JSON.stringify(b.playersV2, null, 2));
    expect(JSON.stringify(a.playersV21, null, 2)).toBe(JSON.stringify(b.playersV21, null, 2));
    expect(JSON.stringify(a.playersV22, null, 2)).toBe(JSON.stringify(b.playersV22, null, 2));
    expect(JSON.stringify(a.playersV23, null, 2)).toBe(JSON.stringify(b.playersV23, null, 2));
    expect(JSON.stringify(a.playersV24, null, 2)).toBe(JSON.stringify(b.playersV24, null, 2));
    expect(JSON.stringify(a.playersV25, null, 2)).toBe(JSON.stringify(b.playersV25, null, 2));
    expect(JSON.stringify(a.playersV26, null, 2)).toBe(JSON.stringify(b.playersV26, null, 2));
    expect(JSON.stringify(a.playersV27, null, 2)).toBe(JSON.stringify(b.playersV27, null, 2));
    expect(JSON.stringify(a.economy, null, 2)).toBe(JSON.stringify(b.economy, null, 2));
    expect(JSON.stringify(a.economyV3, null, 2)).toBe(JSON.stringify(b.economyV3, null, 2));
    expect(JSON.stringify(a.economyV4, null, 2)).toBe(JSON.stringify(b.economyV4, null, 2));
    expect(JSON.stringify(a.botsV4, null, 2)).toBe(JSON.stringify(b.botsV4, null, 2));
    expect(JSON.stringify(a.bots, null, 2)).toBe(JSON.stringify(b.bots, null, 2));
    expect(JSON.stringify(a.league, null, 2)).toBe(JSON.stringify(b.league, null, 2));
    expect(JSON.stringify(a.leagueV2, null, 2)).toBe(JSON.stringify(b.leagueV2, null, 2));
    expect(JSON.stringify(a.botsV3, null, 2)).toBe(JSON.stringify(b.botsV3, null, 2));
  });
});

// ── #252 상대 밸런스 ───────────────────────────────────────────────────────
// 계약의 성격: **절대 수치가 아니라 관계식**으로 건다. 파워 상수는 카탈로그가 바뀌면 따라 움직이므로
// "밴드 안"만 단언하면 카탈로그 개편에서 거짓 실패가 난다. 대신 "구 발행물보다 약하다",
// "사다리가 단조 증가한다" 같은 성질을 건다 — 이게 깨지면 실제로 설계가 깨진 것이다.

const XI_POWER = (ids: readonly string[]): number => {
  const byId = new Map<string, PlayerSeed>(players.map((pp) => [pp.id, pp]));
  return ids.reduce((acc, id) => {
    const pl = byId.get(id);
    if (!pl) throw new Error(`unknown player ${id}`);
    return acc + Object.values(pl.attributes).reduce((x, y) => x + y, 0);
  }, 0);
};
const startersOf = (b: (typeof bots)[number]) => b.deck.starters.map((st) => st.playerId);

describe("bots.v3 — 연습 상대 입문 하향 (#252)", () => {
  const byId = new Map<string, PlayerSeed>(players.map((pp) => [pp.id, pp]));

  it("id 3종은 v2 와 **같다** — matches.bot_id FK 가 과거 매치에서 이 id 를 참조한다", () => {
    expect(botsV3.map((b) => b.id).sort()).toEqual(bots.map((b) => b.id).sort());
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 선발 11 + 벤치 4, 중복 없음, GK≥1", (botId) => {
    const bot = botsV3.find((b) => b.id === botId)!;
    expect(bot.deck.starters.length).toBe(11);
    expect(bot.deck.bench.length).toBe(4);
    const allIds = [...startersOf(bot), ...bot.deck.bench];
    expect(new Set(allIds).size).toBe(15);
    expect(startersOf(bot).filter((id) => byId.get(id)!.position === "GK").length).toBeGreaterThanOrEqual(1);
  });

  it.each(["BOT_ATK", "BOT_DEF", "BOT_BAL"])("%s: 포메이션 포지션 구성이 v2 와 동일(하향은 등급만)", (botId) => {
    const posOf = (deck: (typeof bots)[number]) =>
      startersOf(deck)
        .map((id) => byId.get(id)!.position)
        .sort()
        .join(",");
    expect(posOf(botsV3.find((b) => b.id === botId)!)).toBe(posOf(bots.find((b) => b.id === botId)!));
  });

  it("셋 다 v2 보다 약하다 — hero 요구 '연습 상대가 너무 강하다'의 계약", () => {
    for (const b3 of botsV3) {
      const b2 = bots.find((b) => b.id === b3.id)!;
      expect(XI_POWER(startersOf(b3)), `${b3.id} XI`).toBeLessThan(XI_POWER(startersOf(b2)));
    }
  });

  it("전원 GOLD 봇이 사라졌다 — v2 는 3봇 중 2개가 전원 GOLD 였다(기본값이 디비전 2 급)", () => {
    const allGold = (b: (typeof bots)[number]) =>
      startersOf(b).every((id) => byId.get(id)!.grade === "GOLD");
    expect(bots.filter(allGold).length).toBe(2); // 구 발행물의 사실 박제
    expect(botsV3.filter(allGold).length).toBe(0);
  });

  it("공격형 봇에는 배율이 걸려 있다 — 등급 하한(전원 BRONZE)으로도 못 내려간 유일한 봇", () => {
    // #252 독립검증 MAJ-3: 등급을 전원 브론즈급까지 내려도 레드 스톰만 유저 승률 37.5%(실점 2.79)로
    // 혼자 어려웠다. 페르소나가 파워와 무관하게 압박하기 때문(같은 문서 §1.2 "파워순 ≠ 난이도순").
    const atk = botsV3.find((b) => b.id === "BOT_ATK")!;
    expect(atk.strengthMul).toBeDefined();
    expect(atk.strengthMul!).toBeGreaterThan(0);
    expect(atk.strengthMul!).toBeLessThan(1);
    // 나머지는 배율을 쓰지 않는다(등급만으로 충분) — 배율은 최후 수단이지 기본 노브가 아니다.
    for (const b of botsV3.filter((x) => x.id !== "BOT_ATK")) {
      expect(b.strengthMul ?? 1).toBe(1);
    }
  });

  it("실효 XI 파워(배율 반영)가 셋 다 v2 보다 낮고, 최강 봇도 스타터팩 XI 근처다", () => {
    const eff = (b: (typeof bots)[number]) => XI_POWER(startersOf(b)) * ((b as any).strengthMul ?? 1);
    for (const b3 of botsV3) {
      const b2 = bots.find((b) => b.id === b3.id)!;
      expect(eff(b3), `${b3.id} 실효파워`).toBeLessThan(eff(b2));
    }
    const byId = new Map<string, PlayerSeed>(players.map((pp) => [pp.id, pp]));
    const sum = (id: string) => Object.values(byId.get(id)!.attributes).reduce((x, y) => x + y, 0);
    const pack = economy.starterPack.map((id) => byId.get(id)!);
    const gk = pack.filter((pp) => pp.position === "GK").sort((a, b) => sum(b.id) - sum(a.id))[0];
    const rest = pack.filter((pp) => pp !== gk).sort((a, b) => sum(b.id) - sum(a.id)).slice(0, 10);
    const packBest = sum(gk.id) + rest.reduce((a, pp) => a + sum(pp.id), 0);
    // 연습은 "이길 수 있어야" 하는 곳이다 — 최강 연습 봇도 스타터팩 최선 XI 를 크게 넘지 않는다.
    expect(Math.max(...botsV3.map(eff))).toBeLessThan(packBest);
  });

  it("가장 약한 연습 봇이 스타터팩 최선 XI 보다 약하다 — '첫 승리 가능' 계약", () => {
    const packBest = (() => {
      const pack = economy.starterPack.map((id) => byId.get(id)!);
      const gk = pack
        .filter((pp) => pp.position === "GK")
        .sort((a, b) => XI_POWER([b.id]) - XI_POWER([a.id]))[0];
      const rest = pack
        .filter((pp) => pp !== gk)
        .sort((a, b) => XI_POWER([b.id]) - XI_POWER([a.id]))
        .slice(0, 10);
      return XI_POWER([gk.id, ...rest.map((pp) => pp.id)]);
    })();
    const weakest = Math.min(...botsV3.map((b) => XI_POWER(startersOf(b))));
    expect(weakest).toBeLessThan(packBest);
  });
});

describe("league.v2 — 디비전 난이도 사다리 (#252)", () => {
  it("version === 'v2' 이고 v1 블록은 그대로 승계(additive)", () => {
    expect(leagueV2.version).toBe("v2");
    expect(leagueV2.clubNames).toEqual(league.clubNames);
    expect(leagueV2.rewards).toEqual(league.rewards);
    expect(leagueV2.personaPresets).toEqual(league.personaPresets);
  });

  it("리그 팀 수(10)와 같은 10단계, level 은 10..1 로 유일", () => {
    const levels = leagueV2.divisions.map((d) => d.level);
    expect(levels).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("모든 디비전의 gradeSlots 는 선발 11칸 + 알려진 등급만", () => {
    const known = new Set(["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"]);
    for (const d of leagueV2.divisions) {
      expect(d.gradeSlots.length, d.shortName).toBe(11);
      for (const g of d.gradeSlots) expect(known.has(g), `${d.shortName} ${g}`).toBe(true);
      expect(d.strengthMul).toBeGreaterThan(0);
      expect(d.strengthMul).toBeLessThanOrEqual(1);
    }
  });

  it("난이도가 level 이 낮아질수록 **단조 증가** — 사다리의 핵심 성질", () => {
    const gradeAvg = (() => {
      const acc: Record<string, number[]> = {};
      for (const pp of players) {
        (acc[pp.grade] ??= []).push(Object.values(pp.attributes).reduce((x, y) => x + y, 0));
      }
      return Object.fromEntries(
        Object.entries(acc).map(([g, v]) => [g, v.reduce((x, y) => x + y, 0) / v.length]),
      );
    })();
    const powerOf = (d: (typeof leagueV2.divisions)[number]) =>
      d.gradeSlots.reduce((a, g) => a + gradeAvg[g], 0) * d.strengthMul;
    const byLevelDesc = [...leagueV2.divisions].sort((a, b) => b.level - a.level);
    for (let i = 1; i < byLevelDesc.length; i++) {
      expect(
        powerOf(byLevelDesc[i]),
        `${byLevelDesc[i].shortName} > ${byLevelDesc[i - 1].shortName}`,
      ).toBeGreaterThan(powerOf(byLevelDesc[i - 1]));
    }
  });

  it("입문(최대 level)이 스타터팩+최상위 XI 보다 확실히 약하다 — '초반 5시즌 무난'의 뿌리", () => {
    const byId = new Map<string, PlayerSeed>(players.map((pp) => [pp.id, pp]));
    const sum = (id: string) =>
      Object.values(byId.get(id)!.attributes).reduce((x, y) => x + y, 0);
    const pack = economy.starterPack.map((id) => byId.get(id)!);
    const gk = pack.filter((pp) => pp.position === "GK").sort((a, b) => sum(b.id) - sum(a.id))[0];
    const rest9 = pack.filter((pp) => pp !== gk).sort((a, b) => sum(b.id) - sum(a.id)).slice(0, 9);
    const topAvg =
      economyV3.starterTop!.pool.reduce((a, id) => a + sum(id), 0) / economyV3.starterTop!.pool.length;
    const userBest = sum(gk.id) + rest9.reduce((a, pp) => a + sum(pp.id), 0) + topAvg;

    const gradeAvg: Record<string, number> = {};
    const acc: Record<string, number[]> = {};
    for (const pp of players) (acc[pp.grade] ??= []).push(sum(pp.id));
    for (const [g, v] of Object.entries(acc)) gradeAvg[g] = v.reduce((x, y) => x + y, 0) / v.length;

    const entry = leagueV2.divisions.reduce((a, b) => (a.level >= b.level ? a : b));
    const entryPower = entry.gradeSlots.reduce((a, g) => a + gradeAvg[g], 0) * entry.strengthMul;
    expect(entryPower).toBeLessThan(userBest);
  });

  it("최상위(level 1)는 **구 사다리보다 세다** — 잘하는 유저가 갈 곳이 있다", () => {
    // 구 동작 = 등급 라운드로빈 → 선발 XI ≈ 각 등급 2명씩 + GK. 라이브 실측 평균 6861.
    const gradeAvg: Record<string, number> = {};
    const acc: Record<string, number[]> = {};
    for (const pp of players) {
      (acc[pp.grade] ??= []).push(Object.values(pp.attributes).reduce((x, y) => x + y, 0));
    }
    for (const [g, v] of Object.entries(acc)) gradeAvg[g] = v.reduce((x, y) => x + y, 0) / v.length;
    const legacyXi =
      2 * (gradeAvg.BRONZE + gradeAvg.SILVER + gradeAvg.GOLD + gradeAvg.DIA + gradeAvg.LEGEND) +
      gradeAvg.GOLD; // GK 1(등급 무작위) 근사
    const top = leagueV2.divisions.reduce((a, b) => (a.level <= b.level ? a : b));
    const topPower = top.gradeSlots.reduce((a, g) => a + gradeAvg[g], 0) * top.strengthMul;
    expect(topPower).toBeGreaterThan(legacyXi);
  });
});

/**
 * #483 패널 blocker A 수리. **이 describe 의 존재 이유는 계약 하나**다 —
 * "개명이 자기 원본 실명을 물고 오지 않는다". 그 전까지 이 축의 방어선은 **사람 눈뿐**이었고,
 * 그래서 `naming-log.md` §2 부류④(given-name 연상)가 정확히 겨냥한 자리에서 1건이 통과해 출하됐다.
 */
describe("players.v2.8.1 — 개명이 원본 실명을 물고 오지 않는다 (#483 패널 수리)", () => {
  const PARODY = new Set(["P173", "P174", "P175", "P176", "P177", "P178", "P179", "P180", "P181", "P182"]);
  const toks = (s: string) => s.split(" ").filter((t) => t.length >= 2);
  /** id → 그 행이 대체한 **원본 실명**(v2.7 층은 v2.6 실명, v2.8 층은 v2.7 실명). */
  const originalRealName = new Map<string, string>();
  for (const c of V27_ACTIVE_CARDS) originalRealName.set(c.id, c.from);
  for (const c of V28_RETIRED_CARDS) originalRealName.set(c.id, c.from);

  it("발행물 182행 전량에서 자기-원본 토큰 캐리오버가 0 이다", () => {
    expect(originalRealName.size).toBeGreaterThan(150); // 표본이 비면 이 계약은 아무것도 안 본다
    const violations: string[] = [];
    for (const p of playersV281) {
      const orig = originalRealName.get(p.id);
      if (!orig || PARODY.has(p.id)) continue; // 패러디는 from == to 인 의도된 항등 행
      for (const ft of toks(orig)) {
        for (const tt of new Set([...toks(p.name), ...toks(p.shortName)])) {
          if (tt === ft || tt.startsWith(ft) || ft.startsWith(tt)) {
            violations.push(`${p.id} "${orig}" → "${p.name}" (${tt} ~ ${ft})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("⚠️ 그 계약은 v2.8 에서 실제로 깨져 있었다 — 박제(회귀 시 이 테스트가 먼저 죽는다)", () => {
    // 이 두 건이 패널이 잡은 것이고, 수리 전 상태를 그대로 남겨 "고쳤다"가 검정 가능하게 한다.
    const before = new Map(playersV28.map((p) => [p.id, p.name]));
    expect(before.get("P135")).toBe("앙헬로 킨타"); // ← 앙헬 고메스 (given 캐리오버, 패널 blocker)
    expect(before.get("P096")).toBe("알렉 페르잔"); // ← 알렉시스 맥 알리스터 (같은 부류, 프리즈된 v2.7)
    expect(playersV281.find((p) => p.id === "P135")!.name).not.toBe("앙헬로 킨타");
    expect(playersV281.find((p) => p.id === "P096")!.name).not.toBe("알렉 페르잔");
  });

  it("표에 있는 4행만 v2.8 과 다르고 나머지 178행은 표시명까지 바이트 동일", () => {
    const changed = playersV281
      .filter((p, i) => p.name !== playersV28[i]!.name || p.shortName !== playersV28[i]!.shortName)
      .map((p) => p.id);
    expect(changed.sort()).toEqual([...V281_FIX_CARDS].map((c) => c.id).sort());
    expect(changed).toHaveLength(4);
  });

  it("표시명 밖 축(id·등급·포지션·능력치·성격·active)은 v2.8 과 완전 동일", () => {
    expect(playersV281).toHaveLength(playersV28.length);
    for (let i = 0; i < playersV28.length; i++) {
      const { name: _a, shortName: _b, ...restBefore } = playersV28[i]!;
      const { name: _c, shortName: _d, ...restAfter } = playersV281[i]!;
      expect(restAfter).toEqual(restBefore);
    }
    expect(playersV281.filter((p) => p.active)).toHaveLength(62);
  });

  it("표시명·shortName 이 182 전역 유일", () => {
    expect(new Set(playersV281.map((p) => p.name)).size).toBe(182);
    expect(new Set(playersV281.map((p) => p.shortName)).size).toBe(182);
  });

  it("실명 잔존 0 이 유지된다 — v2.6 실명 토큰과 완전 일치 0 (v2.8 계약 승계)", () => {
    const real = new Set<string>();
    for (const p of playersV26) {
      if (PARODY.has(p.id)) continue;
      for (const t of p.name.split(" ")) real.add(t);
      if (p.shortName) real.add(p.shortName);
    }
    expect(real.size).toBeGreaterThan(100);
    const leaked = playersV281.filter(
      (p) => !PARODY.has(p.id) && [...p.name.split(" "), p.shortName].some((t) => real.has(t)),
    );
    expect(leaked.map((p) => `${p.id} ${p.name}`)).toEqual([]);
  });

  it("수리 4행의 from 앵커가 v2.8 발행물과 일치한다(행 밀림 검출)", () => {
    for (const c of V281_FIX_CARDS) {
      expect(playersV28.find((p) => p.id === c.id)!.name).toBe(c.from);
    }
  });

  it("⚠️ 활성 카드 1행을 의도적으로 바꾼다 — 예외를 두면 계약이 동어반복이 된다", () => {
    // P096 은 v2.7 활성(프리즈)인데 같은 부류였다. 은퇴 120종에만 계약을 걸고 이 행을 면제하면
    // 그 계약은 "내가 이번에 고른 값들은 내 규칙을 지킨다"가 된다 — 그래서 스코프를 넓혀 고쳤다.
    const p096 = playersV281.find((p) => p.id === "P096")!;
    expect(p096.active).toBe(true);
    expect(p096.name).toBe("네스토르 페르잔");
    // 표시명 축이므로 보유·성장·전적에 쓰이는 축은 그대로다.
    expect(p096.grade).toBe(playersV28.find((p) => p.id === "P096")!.grade);
    expect(p096.attributes).toEqual(playersV28.find((p) => p.id === "P096")!.attributes);
  });

  it("⚠️ 전역 부분문자열 금지는 채택하지 않았다 — 임계가 결함이 아니라 언어를 검정한다", () => {
    // 근거를 박제한다: 전역(모든 v2.6 실명 토큰 상대 부분문자열)으로 걸면 무해한 범용 이름이
    // 대량으로 걸려 작명 풀이 닫힌다. 자기-원본으로 좁히면 위반이 정확히 실제 결함만 남는다.
    const real = new Set<string>();
    for (const p of playersV26) {
      if (PARODY.has(p.id)) continue;
      for (const t of p.name.split(" ")) real.add(t);
      if (p.shortName) real.add(p.shortName);
    }
    let globalHits = 0;
    for (const p of playersV281) {
      if (PARODY.has(p.id)) continue;
      for (const tt of new Set([...toks(p.name), toks(p.shortName)[0] ?? ""])) {
        if (!tt) continue;
        for (const t of real) {
          if (t.length >= 2 && tt !== t && (tt.includes(t) || t.includes(tt))) globalHits++;
        }
      }
    }
    // 전역 기준이면 여전히 다수 걸린다(라스 ⊂ 라스무스 · 알렉 ⊂ 알렉산더 · 바스 ⊂ 바스토니 …).
    expect(globalHits).toBeGreaterThan(5);
  });
});
