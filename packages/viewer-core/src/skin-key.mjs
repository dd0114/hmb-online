// @hmb/viewer-core — 스킨 페이로드 조회 키 규약 (#324).
//
// 왜 팀이 키에 들어가나: 유저 덱과 봇 로스터가 **같은 선수 카탈로그를 공유**해서 같은 `playerId` 가
// 양 팀에 동시에 뛴다(라이브 101하프 중 38% 가 중복 1명 이상). `playerId` 단독 키로 조회하면
// 두 인스턴스가 같은 칸을 가리켜, 실제로 어웨이 11명 중 6명이 **홈 선수 등번호**를 달고 뛰었다
// (라이브 실측 away = 1,2,3,4,3,2,8,7,5,9,11 — 팀 안에 #2·#3 중복).
//
// ⚠️ 구 페이로드 호환: 예전 부모(구 web·QA 셸)는 `playerId` 단독 키로 페이로드를 만든다. 조회는
// **팀 키 우선 → 단독 키 폴백**이라 구 페이로드에서도 종전 그대로 그려진다(무회귀).

/** 스킨 조회 키. `team` 이 없으면(구 소비자) playerId 단독 키로 떨어진다. */
export function skinKeyOf(team, playerId) {
  return team ? `${team}:${playerId}` : playerId;
}

/** 팀 키 우선, 없으면 단독 키(구 페이로드) 로 조회. `map` 이 없으면 undefined. */
export function skinLookup(map, team, playerId) {
  if (!map) return undefined;
  const keyed = map[skinKeyOf(team, playerId)];
  return keyed !== undefined ? keyed : map[playerId];
}
