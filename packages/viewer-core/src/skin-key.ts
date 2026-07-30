/**
 * 스킨 조회 키 규약 (#324) — 타입 표면. 런타임 원본은 `./skin-key.mjs`.
 *
 * 같은 `playerId` 가 양 팀에 동시 출전하므로(유저 덱·봇 로스터가 선수 카탈로그를 공유)
 * 스킨/등번호 조회는 **팀까지 포함한 키**여야 한다. 구 페이로드(단독 키)는 폴백으로 계속 읽힌다.
 */
import * as impl from "./skin-key.mjs";

/** 스킨 조회 키(`"home:P078"`). team 이 없으면 playerId 단독 키. */
export const skinKeyOf: (team: string | undefined | null, playerId: string) => string = impl.skinKeyOf;

/** 팀 키 우선 → 단독 키 폴백 조회. */
export const skinLookup: <T>(
  map: Record<string, T> | null | undefined,
  team: string | undefined | null,
  playerId: string,
) => T | undefined = impl.skinLookup;
