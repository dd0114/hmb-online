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
const TOTAL = 180;
/** players.v2 / players.v2.1 이 동결된 시점의 총원. 이 경계 앞은 절대 변하지 않는다. */
const FROZEN_TOTAL = 172;
// 신규 8종 = GK+1 / MF+3 / FW+4 (DF +0). 구 분포 GK13/DF53/MF59/FW47 에 가산.
const POSITION_TOTALS: Record<Position, number> = { GK: 14, DF: 53, MF: 62, FW: 51 };
const GRADE_TOTALS: Record<Grade, number> = {
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
 * 패러디 유닛명에 실명이 새어 들어오지 않는지 — 소스 실선수의 한글 표기 denylist(부분문자열 금지).
 * 실명 유입 차단이 목적이므로 가드를 지우지 않고 **한글 축으로 확장**한다.
 */
const REAL_NAME_KO_DENYLIST: readonly string[] = [
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

// hero 요청(#84): 한국 유명 선수 추가. 대표 선수의 존재·등급을 명시 검증(도감 반영 보장).
const EXPECTED_KOREANS: readonly { name: string; grade: Grade }[] = [
  { name: "Son Heung-min", grade: "DIA" },
  { name: "Kim Min-jae", grade: "DIA" },
  { name: "Park Ji-sung", grade: "LEGEND" },
  { name: "Cha Bum-kun", grade: "LEGEND" },
  { name: "Lee Kang-in", grade: "GOLD" },
  { name: "Hwang Hee-chan", grade: "GOLD" },
  { name: "Cho Hyun-woo", grade: "SILVER" },
  { name: "Yang Min-hyuk", grade: "BRONZE" },
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
  players, playersV2, playersV21, playersV22, playersV23, economy, economyV3, bots, league,
  leagueV2, botsV3,
} = generateAll();

describe("players 카탈로그 — counts/distribution (AC-PL1)", () => {
  it(`총 ${TOTAL}명`, () => {
    expect(players.length).toBe(TOTAL);
  });

  it("포지션 분포 GK14/DF53/MF62/FW51 (신규 8종 GK1/MF3/FW4 가산)", () => {
    const counts: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const p of players) counts[p.position]++;
    expect(counts).toEqual(POSITION_TOTALS);
  });

  it("GK 비중이 낮다 — 컬렉션의 12% 미만(팀당 선발 1명, hero 지적 반영)", () => {
    const gk = players.filter((p) => p.position === "GK").length;
    expect(gk / players.length).toBeLessThan(0.12);
  });

  it("등급 분포 BRONZE35/SILVER52/GOLD46/DIA25/LEGEND22 (레전드 희소)", () => {
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
      for (const banned of REAL_NAME_KO_DENYLIST) {
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

  it("한국 유명 선수 포함(hero 요청 #84) — 대표 선수 존재 + 등급 일치", () => {
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

  it(`v2.2 = ${TOTAL}명 (동결 ${FROZEN_TOTAL} + 신규 8)`, () => {
    expect(playersV22.length).toBe(TOTAL);
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
    expect(new Set(playersV23.map((p) => p.name)).size).toBe(TOTAL);
    for (const r of V23_RENAMES) {
      const name = byId.get(r.id)!.name;
      expect(name, `${r.id} 한글 전용 패러디명`).toMatch(/^[가-힣]{2,}$/);
      for (const banned of REAL_NAME_KO_DENYLIST) {
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
    expect(JSON.stringify(derived, null, 2)).toBe(
      JSON.stringify(playersV23.map((p) => p.attributes), null, 2),
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
    expect(playersV23.filter((p) => p.active)).toHaveLength(TOTAL - 17);
  });

  // ── 축 무변경(활성 여부는 등급/포지션 축과 독립) ──────────────────
  it(`총원 ${TOTAL} · LEGEND 22 · 등급/포지션 분포 무변경`, () => {
    expect(playersV23).toHaveLength(TOTAL);
    const grades: Record<Grade, number> = { BRONZE: 0, SILVER: 0, GOLD: 0, DIA: 0, LEGEND: 0 };
    const positions: Record<Position, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const p of playersV23) {
      grades[p.grade]++;
      positions[p.position]++;
    }
    expect(grades).toEqual(GRADE_TOTALS);
    expect(grades.LEGEND).toBe(22);
    expect(positions).toEqual(POSITION_TOTALS);
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
    ["economy.v2.json", economy],
    ["bots.v2.json", bots],
    ["league.v1.json", league],
    ["bots.v3.json", botsV3],
    ["league.v2.json", leagueV2],
  ];

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
    expect(JSON.stringify(a.economy, null, 2)).toBe(JSON.stringify(b.economy, null, 2));
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
