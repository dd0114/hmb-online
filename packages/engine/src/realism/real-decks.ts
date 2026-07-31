import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SelectData, TacticalInput } from "@hmb/shared";

/**
 * 실덱 판정 픽스처 로더 — #374 / #377 M0-2
 *
 * ## 왜 있나
 * 엔진의 밸런스 판정이 전부 **픽스처 입력 하나**로만 이뤄졌다. 60시드는 시드 분산만 넓히고
 * 입력 분포는 고정이라, "덱마다 달라지는 결함"을 **원리적으로 못 잡는다**. 그 구멍으로
 * #370 이 나갔다 — `contest.shootXgThreshold` 를 0.197 로 올렸더니 픽스처에서는 팀당 12.68 슛
 * (밴드 안)인데 **실덱에서는 90% 가 게이트아웃**돼 라이브 슛이 79% 붕괴했다.
 *
 * ## 이 파일이 하는 일
 * `real-decks/*.json` 을 읽어 준다. 그뿐이다 — **값을 만들지 않는다.** 그 JSON 은
 * `tools/extract-real-decks.mjs` 가 라이브 DB 사본에서 **서버가 만든 입력을 그대로** 옮긴
 * 것이다(TS 재구현 금지 — 재구현하면 검증이 구현과 같은 실수를 공유한다.
 * `tools/league-difficulty-sweep.ts` 가 세운 선례).
 *
 * ## 판정 규율
 * **평균이 아니라 최악 케이스**로 본다. #370 을 한 번 놓친 것이 정확히 라이브 24하프 **평균**으로
 * "붕괴 없음"이라 판단해서였다 — 평균이 입력 의존 붕괴를 가린다.
 *
 * ## 익명화 — 무엇을 남겼고 왜 (#374 "식별자 익명화"에 대한 명시적 판단)
 * | 항목 | 처리 | 근거 |
 * |---|---|---|
 * | 덱/팀 이름 | **치환**(`USER-DECK-*`) | 테스터가 직접 지은 것 = 유일한 유저 표현 |
 * | 선수 이름·id·능력치 | 유지 | 배포되는 게임 카탈로그 콘텐츠이고 **엔진이 실제로 읽는 값**이다 |
 * | `live.matchId` | 유지 | ULID(비의미). #374 가 붕괴 케이스를 **이 id 로 지정**했고 추적에 쓴다 |
 * | `meta.promptHash` | 유지 | 전술 라벨 + 선수 id 조합(예: `away-433-possession-…`). 자유 텍스트가 아니다 |
 * | user_id · 세션 · 이메일 | **애초에 안 가져온다** | 추출 SQL 에 없다 |
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "real-decks");

/** 픽스처 1건 = 라이브 하프 하나의 재현 입력 3종세트 + 출처. */
export interface RealDeckCase {
  schemaVersion: number;
  id: string;
  label: string;
  note: string;
  /** 그 하프의 실제 시드(라이브 `match_halves.half_seed`). */
  seed: string;
  live: {
    matchId: string;
    half: number;
    mode: string;
    /** ⚠️ 라이브에서 이 입력이 돌던 엔진 버전. 지금 엔진과 다르다 — 점수 재현은 기대하지 않는다. */
    engineVersion: string;
    state: string;
    score: { home: number | null; away: number | null };
  };
  selectData: SelectData;
  homeInput: TacticalInput;
  awayInput: TacticalInput;
}

/** 목록용 경량 서술(로스터를 통째로 읽지 않는다). */
export interface RealDeckSummary {
  id: string;
  label: string;
  note: string;
  seed: string;
  live: RealDeckCase["live"];
}

interface RealDeckIndex {
  schemaVersion: number;
  note: string;
  cases: RealDeckSummary[];
}

let indexCache: RealDeckIndex | null = null;
const caseCache = new Map<string, RealDeckCase>();

function loadIndex(): RealDeckIndex {
  if (indexCache) return indexCache;
  indexCache = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as RealDeckIndex;
  return indexCache;
}

/** 픽스처 목록(선언 순서 = 추출 시 선정 순서, `collapse-370` 이 항상 첫 번째). */
export function listRealDeckCases(): RealDeckSummary[] {
  return loadIndex().cases;
}

export function loadRealDeckCase(id: string): RealDeckCase {
  const hit = caseCache.get(id);
  if (hit) return hit;
  const known = loadIndex().cases.some((c) => c.id === id);
  if (!known) {
    throw new Error(`알 수 없는 실덱 픽스처: "${id}" (있는 것: ${loadIndex().cases.map((c) => c.id).join(", ")})`);
  }
  const parsed = JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")) as RealDeckCase;
  caseCache.set(id, parsed);
  return parsed;
}

export function loadAllRealDeckCases(): RealDeckCase[] {
  return listRealDeckCases().map((c) => loadRealDeckCase(c.id));
}

/**
 * #370 붕괴 케이스. **이 한 건이 T0 에 들어가는 이유** — #376 이 남긴 교훈 3번:
 * "이번 사고의 유일한 필수 AC 는 붕괴 케이스 1경기 입력 1회였다. 그건 480ms 다.
 *  4.8분짜리 사다리보다 먼저 돌았어야 했다."
 */
export const COLLAPSE_CASE_ID = "collapse-370";

/** 디스크에 있는 픽스처 파일 목록(인덱스 정합성 계약이 쓴다). */
export function realDeckFilesOnDisk(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .sort();
}
