/**
 * 성장 시스템 v2 응답 타입 (에픽 #179 — 메이플 피벗, V2-4). SoT = packages/shared/src/growth.ts (zod).
 * 3축: ①스탯 성장(경기·Lv) ②성★(1~4, 중복=천장) ③잠재능력(3줄·티어·다이스). 구 강화(enhance)/
 * 한계돌파(limitbreak) 계약은 **폐기**됐다 — 이 파일에 있던 EnhanceResult/ENHANCE_MAX_CODE 등은 제거.
 *
 * ⚠️ 이 엔드포인트들은 아직 openapi.yaml(generated schema.d.ts)에 없다 — server-java(GM2) 소관.
 * 그래서 여기서 shared 계약을 손으로 미러링하되 PlayerAttributes 는 generated schema 를 재사용해
 * 드리프트를 막는다. openapi 에 편입되면 이 파일을 generated 타입으로 교체한다.
 */
import type { components } from "./schema";

type PlayerAttributes = components["schemas"]["PlayerAttributes"];

export const GRADE_ORDER = ["BRONZE", "SILVER", "GOLD", "DIA", "LEGEND"] as const;
export type Grade = (typeof GRADE_ORDER)[number];

/** 성(★) 1~4. 전 등급 동일 — 등급 격차는 잠재 줄 수·티어 캡으로만. */
export type Star = 1 | 2 | 3 | 4;

/** 잠재 티어 (랙칫 — 내려가지 않음). */
export const POTENTIAL_TIERS = ["RARE", "EPIC", "UNIQUE"] as const;
export type PotentialTier = (typeof POTENTIAL_TIERS)[number];

/** 잠재 옵션 1줄. STAT_* 는 stat 지정, 나머지는 팀/컨디션 훅. */
export interface PotentialLine {
  slot: 1 | 2 | 3;
  tier: PotentialTier; // V2.1-1: 전줄 = 카드 잠재 티어(동일). 구 "2·3줄=한 단계 아래" 모델 폐기.
  type: "STAT_PCT" | "STAT_FLAT" | "CONDITION_RECOVERY" | "TEAM_MORALE";
  stat?: string; // PlayerAttributes 키 (STAT_* 만)
  value: number; // pct 는 % 단위(예 4 = +4%), flat 은 절대값
}

/**
 * 스탯 1종의 성장 상태 — **구 모델의 이력**이다.
 *
 * ⚠️ #405 W2b 부터 **유효스탯에 관여하지 않는다**. 스탯이 오르는 유일한 경로는 3지선다
 * 선택(`statAdd`)이고, `statLevels` 는 소급 이관의 입력이자 롤백 근거로만 남는다.
 * **화면에 "성장"으로 그리지 마라** — 안 움직이는 막대가 성장 화면의 주인공이 된다.
 */
export interface StatLevel {
  lv: number;
  xp: number; // 현재 레벨에서 쌓인 xp (임계 = xpLvBase × xpLvGrowth^lv)
}

/**
 * **왜 이 후보가 나왔나** — 그 스탯의 가중을 가장 크게 밀어올린 축 + 원자료(#405, 서버 `00b3586`).
 *
 * ⚠️ **서버는 구조만 내리고 문장을 만들지 않는다**(#232 와 같은 이유 — 문안이 서버 코드에 박히면
 * 문구 하나 바꾸는 데 배포가 필요하다). 표시 문장은 클라가 만든다 → `growth/choice-reason.ts`.
 *
 * ⚠️ **`null` 일 수 있다**: 이 필드는 W2b 초판 뒤에 붙었으므로 그때 만들어진 선택권 행에는 없다.
 * `BASE`(어느 축도 기여 안 함)와 같이 **줄을 생략**한다 — 없는 이유를 지어내지 않는다.
 */
export interface ChoiceReason {
  /** `EVENT` | `BEHAVIOR` | `POSITION` | `RESULT` | `LEGACY` | `BASE` — 모르는 값이면 줄 생략. */
  kind: string;
  detail?: Record<string, unknown> | null;
}

/**
 * 3지선다 후보 1개 (#405 §2.5) — **레벨업 순간 서버가 박제**한다(`candidates_json`).
 * `gain`·`reason`·**순서·`core` 까지** 박제되므로 미뤘다가 골라도 화면에 보였던 것이 그대로다.
 *
 * ⚠️ **배열 순서에 의미가 있다 — 클라가 다시 정렬하지 마라**(서버 `619d18b`).
 * 서버가 `positionBaseline[pos][stat] × gain` 내림차순으로 내린다. 화면에서 가장 크고 눈에 띄는
 * 숫자는 `gain` 배지인데, 감쇠 특성상 gain 이 큰 쪽은 **낮은 스탯**이라 gain 순으로 그리면
 * **화면이 유도하는 선택이 전력(OVR)으로는 지는 선택**이 된다(GK 에게 `shooting` 이 그 예).
 * 정렬 기준인 `positionBaseline` **값 자체는 안 내려온다** — 무배포 조정 대상이라 클라가 미러하면
 * 노브를 돌린 뒤 화면만 옛 기준으로 정렬한다(§2.8). 서버가 끝낸 결과만 받는다.
 */
export interface ChoiceCandidate {
  stat: string;
  gain: number;
  reason?: ChoiceReason | null;
  /**
   * 그 포지션의 **핵심 스탯**인가(상위 `candidate.coreStatCount`).
   *
   * ⚠️ **키가 없으면 표시를 생략한다 — `false` 로 눕히지 마라.** 구 박제분에는 이 값이 없고,
   * "없음"을 "핵심이 아니다"로 읽으면 없는 사실을 단언하게 된다(`reason` 과 같은 패턴).
   */
  core?: boolean | null;
}

/** 대기 중인 레벨업 선택권 1건. 레벨업 1회 = 선택 1회(같은 경기에 여러 건이 날 수 있다). */
export interface PendingChoice {
  choiceId: string;
  playerId: string;
  level: number;
  candidates: ChoiceCandidate[];
}

/**
 * POST /api/growth/choices/{choiceId} 결과.
 *
 * ⚠️ **`card` 가 같이 온다 — 재조회하지 마라.** 서버가 갱신된 카드를 응답에 실어 주므로
 * 훅이 그대로 캐시에 넣는다(왕복 1회 + 화면이 옛 값을 한 프레임 보여주는 일이 없다).
 */
export interface ChoiceResult {
  choiceId: string;
  playerId: string;
  level: number;
  stat: string;
  gain: number;
  card: CardEffective;
}

/** 이미 고른 선택권에 다시 보냈다 — 409. 화면은 목록을 새로 받아 그 항목을 지운다. */
export const CHOICE_ALREADY_MADE_CODE = "CHOICE_ALREADY_MADE";

/** 카드 상세/주입용 유효 상태 (GET /api/growth/card). */
export interface CardEffective {
  playerId: string;
  grade: Grade; // 등급 불변(승급 없음)
  star: Star;
  attributes: PlayerAttributes; // 잠재 반영 최종 유효 스탯
  prePotential: PlayerAttributes; // 잠재 반영 전(base+성장, cap 클램프)
  base: PlayerAttributes; // 뽑기 롤 원본
  caps: PlayerAttributes; // 성★ 이 개방한 스탯별 천장 = growCeil[grade] + star.ceilBonus[star]
  statLevels: Record<string, StatLevel>; // 9종 키 — **구 이력**(위 StatLevel 주석)
  /**
   * ── #405 W2b additive (설계 §3) ─────────────────────────────────────────────────────
   * 전부 **옵셔널**이다. W2b 이전 서버·구 목이 이 키들을 안 보내는데, 필수로 선언하면 타입만
   * 안심시키고 화면은 `undefined` 를 그린다(`Lv undefined / undefined`). 타입이 호출부에
   * 가드를 강제하게 둔다.
   */
  /** 3지선다 누적(소수) = 막대의 **성장분** 층. 유효스탯을 움직이는 유일한 성장 축이다. */
  statAdd?: Record<string, number>;
  /** 카드 레벨(1..maxLevel). 스탯별 레벨이 아니다 — 카드 하나에 하나. */
  cardLevel?: number;
  /** 현재 레벨에서 쌓인 XP. */
  cardXp?: number;
  /** 다음 레벨까지의 **임계**(cardXp / xpToNext = 진행률). 만렙이면 0. */
  xpToNext?: number;
  maxLevel?: number;
  /** 이 카드에 남아 있는 선택권(강화탭 배너). */
  pendingChoices?: PendingChoice[];
  /**
   * 천장의 **분해** — `caps = min(growCeil + starCeilBonus, attrHardCap)`.
   * `caps` 만으로는 `천장 73 = 72 + ★2 보너스 1` 라벨을 만들 수 없어서 셋을 따로 받는다.
   * ⚠️ 클라가 밴드 표를 미러해 재구성하면 무배포 조정에 조용히 어긋난다(§2.8) — 받은 값만 쓴다.
   */
  growCeil?: number;
  starCeilBonus?: number;
  attrHardCap?: number;
  /**
   * 등급 **시작 밴드 하한** — 후보 막대의 좌측 앵커 (서버 `619d18b`).
   *
   * 감쇠가 `r = (v − startLo)/(ceiling − startLo)` 라 **이 값이 원점이어야** gain 차이가 막대
   * 길이로 읽힌다. 없으면(구 서버) 근사 앵커로 그리되 `시작 N` 라벨은 붙이지 않는다 —
   * 근사치에 정확한 이름을 붙이는 것이 곧 화면의 거짓말이다.
   */
  startLo?: number;
  potential: {
    unlocked: boolean; // 2★ 이상
    tier: PotentialTier;
    maxTier: PotentialTier; // min(등급 캡, 성 캡)
    lines: PotentialLine[]; // 길이 = 등급별 줄 수(브/실1·골2·다/레3)
    rollsSinceTierUp: number;
    ceilingAt: number; // 이 횟수 도달 시 다음 노말 롤 확정 티어업
  };
  ovr: number;
  completion: number; // 0..1, 성장 진행률 Σlv/Σ(cap−base)
}

/** 성★ 승급 결과 (POST /api/growth/star). */
export interface StarUpResult {
  playerId: string;
  star: Star;
  spentCopies: number; // 2★=2 / 3★=3 / 4★=5 (config)
  potentialUnlocked: boolean; // 이번 승급으로 잠재 첫 해금?
  maxTier: PotentialTier; // 승급 후 티어 캡
}

/**
 * 잠재 리롤 결과 (POST /api/growth/dice).
 *
 * ⚠️ **#247: 구매 단계가 사라졌다** — 다이스는 사는 물건이 아니라 롤 비용이다. 그래서 응답에서
 * `diceLeft`(재고 잔여)가 빠지고 `wallet`(차감 후 지갑)이 들어왔다. 재고 필드를 되살리지 마라 —
 * 되살아나는 순간 화면에 "보유 n개"가 다시 그려진다.
 */
export interface DiceRollResult {
  playerId: string;
  kind: "NORMAL" | "CASH";
  tierBefore: PotentialTier;
  tierAfter: PotentialTier; // 노말만 승급 가능. 랙칫
  tierUp: boolean;
  byCeiling: boolean; // 천장(1.5배) 보장 발동 여부
  lines: PotentialLine[];
  rollsSinceTierUp: number;
  ceilingAt: number;
  wallet: WalletBalance; // 롤 비용 차감 후 잔액(재화를 정하는 쪽이 잔액도 준다, #232)
  /**
   * 무료 쿠폰(`FREE_ENHANCE`)으로 나갔다 (#493 W6-v3 additive) — **지갑이 안 줄어든 이유**다.
   *
   * ⚠️ 이 필드가 없으면 화면은 "값이 안 바뀌었네"를 버그로 읽거나, 반대로 차감을 약속해 놓고
   * 안 깎는 화면이 된다. 서버는 `kind:"NORMAL"` 에서만 참을 줄 수 있다 — 쿠폰은 골드 비용만
   * 대신 내고 유상재화(CASH)는 절대 대신 내지 않는다. 구 서버는 안 준다 → optional.
   */
  freeByCoupon?: boolean;
}

/**
 * 매치 후 성장 1인분 (#405 W2b) — **보상 봉투 `GROWTH` 섹션 엔트리와 같은 자료**다
 * (`GrowthService.growthEntries` 하나가 둘 다 만든다). 두 화면이 같은 경기를 다르게 말하지
 * 않으려면 타입도 하나여야 한다.
 *
 * ⚠️ **구 모델 필드(`statXp`·`levelUps`·`ovrBefore/After`)는 사라졌다.** 서버가 더는 만들지
 * 않는다 — 신 모델의 결과는 "유저가 무엇을 골랐나"에 달려 있어 매치 로그로 복원되지 않기
 * 때문이다. 되살리지 마라(구 `GrowthReportSection` 은 `Object.entries(e.statXp)` 로 그 부재에
 * 그대로 터졌다 = 결과 화면 흰 화면).
 *
 * ⚠️ `levelBefore`/`levelAfter` 는 **null 일 수 있다** — W2b 이전 정산분은 스냅샷이 없어
 * 서버가 xp 만 싣는다. 0 으로 때우면 "Lv 0" 이라는 거짓이 뜬다.
 */
export interface MatchGrowthEntry {
  playerId: string;
  name: string;
  /** 카탈로그에 없는 선수면 null(발행 사고) — 그 경우 아트 정책은 fail-closed 로 닫힌다. */
  position?: string | null;
  grade?: string | null;
  /** 이 경기에서 얻은 카드 XP. **0 = 미투입**(안 뛰면 안 큰다 — 화면이 그걸 말해야 한다). */
  xpGained: number;
  levelBefore?: number | null;
  levelAfter?: number | null;
  /**
   * 정산 **직후** 레벨 안에서의 진행도 — 행 XP 바는 `cardXp / xpToNext` 다.
   *
   * ⚠️ **서버가 계산해 스냅샷에 박는다**(클라가 `xp.lvBase`/`lvPow` 곡선을 미러하면 무배포
   * 조정이 화면에서만 옛 곡선으로 남는다, §2.8). **만렙이면 `xpToNext === 0`** → 나누지 말고
   * 꽉 찬 상태로. W2b 초판 정산분은 둘 다 `null` → **바를 안 그린다**(레벨 전이 표시는 유지).
   */
  cardXp?: number | null;
  xpToNext?: number | null;
  /**
   * 출전 구분 `starter` | `partial`(교체 인/아웃) | `bench`(미투입).
   * 초판 정산분은 `null` → `xpGained === 0` 로 벤치를 추정한다(그때 알 수 있는 전부다).
   */
  minutes?: string | null;
  /** 이 경기 레벨업으로 생긴 선택권(정산 스냅샷 = **그때 무엇이 생겼나**). */
  pendingChoices?: PendingChoice[];
}

export interface MatchGrowthReport {
  matchId: string;
  entries: MatchGrowthEntry[];
}

/**
 * 지갑 — V2.2 재화 이원화(에픽 #179, hero 확정 2026-07-26): P(무료 게임머니) + 젬(충전형, 목업
 * 충전). SoT = packages/shared/src/growth.ts WalletBalance. openapi 미편입이라 여기서도 손 미러링.
 */
export interface WalletBalance {
  points: number;
  gems: number;
}

/**
 * 젬 충전(목업) 결과 (POST /api/shop/gems/topup). 실결제 없음 — mock 지급, 즉시 반영.
 * SoT = packages/shared/src/growth.ts GemTopupResult.
 */
export interface GemTopupResult {
  packId: string;
  granted: number;
  wallet: WalletBalance;
}

/**
 * 성★ 승급 시 중복 부족 4xx 코드 (V2-4 명시).
 *
 * ⚠️ 잔액 부족(`INSUFFICIENT_POINTS`/`INSUFFICIENT_GEMS`)에는 대응 상수가 **일부러 없다**.
 * #247 로 리롤이 지갑 결제가 되면서 그 문구는 **서버가 표기 메타로 만든 것을 그대로** 띄우므로
 * (#232), 클라가 코드를 분기해 자기 문구를 지어낼 자리가 없어졌다. 상수를 되살리면 그 분기가
 * 같이 돌아온다.
 */
export const INSUFFICIENT_MATERIALS_CODE = "INSUFFICIENT_MATERIALS";
