import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SelectData, TacticalInput, type MatchLog, type TeamSide } from "@hmb/shared";
import type { EngineConfig } from "../config";
import { runMatch } from "../match";
import { computeMatchStats, type MatchStats } from "../../dev-viewer/match-stats";

/**
 * realism/live-inputs — **라이브 실입력 표본**으로 밴드를 재는 하네스 (#370-B).
 *
 * ## 왜 있는가 (사고의 본질)
 * 0.28.0 배포에서 라이브 슛이 79% 붕괴했다(56 → 12). 그런데 **엔진의 밴드 판정은
 * 전부 픽스처 입력**(`fixtures.makeSelectData`/`makeTacticalInput`)으로만 돌았다.
 * 60시드는 **시드 분산**만 넓힐 뿐 **입력 분포는 하나로 고정**이라, 입력 의존적 붕괴를
 * **원리적으로** 못 잡는다. 실제로 `contest.shootXgThreshold=0.197` 은 픽스처 xG 분포에서는
 * "하위 절반을 자르는" 위치였고 문제 덱의 분포에서는 **거의 전부의 위**였다.
 *
 * 그래서 이 하네스는 라이브 DB 에서 뜬 **고정 실입력 표본**(`fixtures/live-inputs.json`)을
 * 그대로 돌린다. 덱(능력치 분포)·AI 생성 전술 파라미터·시드가 전부 실물이다.
 *
 * ## ⚠️ 평균으로 판정하지 않는다
 * 이 사고에서 라이브 24하프 **평균**이 붕괴를 가렸다(문제 케이스 하나를 평균이 흡수).
 * 그래서 판정 지표는 **표본별 최솟값(worst case)** 이다 — "어떤 실덱에서도 슛이 N 밑으로
 * 안 떨어진다". 평균은 참고로만 같이 낸다.
 *
 * ## 표본
 * `fixtures/live-inputs.json` — 14 하프(사용자 7명 · 상대 5종 · 포메이션 5종 · 전술 극단 포함).
 * **익명화**: 팀명 → `HOME`/`AWAY`, 선수명 → `playerId`, `meta` → `{}`, user/bot id 미수록.
 * 익명화가 **동작을 바꾸지 않는다**는 것은 `live-input-volume.test.ts` 가 계약으로 박제한다
 * (엔진이 SelectData 에서 읽는 것은 `playerId` 와 `attributes` 뿐이다).
 *
 * ## 하프 입력을 풀매치로 돌린다
 * DB 는 하프 단위로 (seed, selectData, home/awayInput) 를 저장한다. 여기서는 그 입력 한 벌을
 * `runMatch` 에 통째로 넣어 **90분 경기 1개**를 돌린다 — 그래야 픽스처 밴드(팀-경기 단위)와
 * 같은 축에서 비교된다. 하프 절반만 재면 밴드와 축이 달라져 대조가 불가능하다.
 */

const GK_IDS = new Set<string>(); // 실입력은 id 가 카탈로그 id(P0xx) 라 슬롯 규칙이 없다.

export interface LiveSample {
  id: string;
  note: string;
  matchId: string;
  half: number;
  engineVersion: string;
  opponentKind: string;
  formations: string;
  seed: string;
  select: SelectData;
  home: TacticalInput;
  away: TacticalInput;
}

interface RawFile {
  samples: unknown[];
}

let cache: LiveSample[] | null = null;

/** 고정 실입력 표본을 읽는다(zod 로 계약 검증 — 스키마가 바뀌면 여기서 터진다). */
export function loadLiveInputs(): LiveSample[] {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(join(here, "fixtures", "live-inputs.json"), "utf8")) as RawFile;
  cache = raw.samples.map((s) => {
    const o = s as Record<string, unknown>;
    return {
      id: String(o.id),
      note: String(o.note),
      matchId: String(o.matchId),
      half: Number(o.half),
      engineVersion: String(o.engineVersion),
      opponentKind: String(o.opponentKind),
      formations: String(o.formations),
      seed: String(o.seed),
      select: SelectData.parse(o.select),
      home: TacticalInput.parse(o.home),
      away: TacticalInput.parse(o.away),
    };
  });
  return cache;
}

export interface LiveTeamRow {
  sampleId: string;
  side: TeamSide;
  shots: number;
  onTarget: number;
  goals: number;
  passSuccessPct: number;
  fouls: number;
  corners: number;
  throwIns: number;
  avgWidthM: number;
}

export interface LiveResult {
  rows: LiveTeamRow[];
  /** 표본별 (양팀 합산이 아니라) 팀-경기 행 → 최솟값/평균. */
  minShots: number;
  meanShots: number;
  /** 표본(경기) 단위 슛 합 — 최솟값. 한 팀만 죽은 경우와 둘 다 죽은 경우를 가른다. */
  minMatchShots: number;
  meanGoalsPerMatch: number;
  /** 표본별 요약(보고·진단용). */
  perSample: { id: string; shots: [number, number]; goals: [number, number]; note: string }[];
}

export function runLive(config: EngineConfig, samples: LiveSample[] = loadLiveInputs()): LiveResult {
  const rows: LiveTeamRow[] = [];
  const perSample: LiveResult["perSample"] = [];
  let goalSum = 0;
  let minMatchShots = Number.POSITIVE_INFINITY;
  for (const s of samples) {
    const log: MatchLog = runMatch(s.seed, s.home, s.away, s.select, config);
    const stats: MatchStats = computeMatchStats(log, GK_IDS, {
      pitchWidthM: config.pitch.width,
      finalThirdLine: config.setPiece.finalThirdLine,
    });
    for (const side of ["home", "away"] as TeamSide[]) {
      const t = stats[side];
      rows.push({
        sampleId: s.id,
        side,
        shots: t.shots,
        onTarget: t.onTarget,
        goals: t.goals,
        passSuccessPct: t.passSuccessPct,
        fouls: t.fouls,
        corners: t.corners,
        throwIns: t.throwIns,
        avgWidthM: t.avgWidthM,
      });
    }
    goalSum += stats.home.goals + stats.away.goals;
    minMatchShots = Math.min(minMatchShots, stats.home.shots + stats.away.shots);
    perSample.push({
      id: s.id,
      shots: [stats.home.shots, stats.away.shots],
      goals: [stats.home.goals, stats.away.goals],
      note: s.note,
    });
  }
  const shots = rows.map((r) => r.shots);
  return {
    rows,
    minShots: Math.min(...shots),
    meanShots: shots.reduce((a, b) => a + b, 0) / shots.length,
    minMatchShots,
    meanGoalsPerMatch: goalSum / samples.length,
    perSample,
  };
}
