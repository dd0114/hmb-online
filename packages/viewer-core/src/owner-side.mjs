// @hmb/viewer-core — "공을 가진 선수는 어느 팀인가" (#324 후속).
//
// `MatchLog.tickSnapshots[].ballOwner` 는 **순수 playerId** 다(shared 계약 — #231 이 엔진 내부만
// `(side, playerId)` 로 바꾸고 직렬화 계약은 그대로 뒀다). 그래서 문자열만 보고 팀을 알 수 없다.
//
// 종전 코드는 `id[0] === "H" ? "home" : "away"` 로 **추측**했다. 엔진 픽스처 id(`H9`/`A3`)에선
// 맞지만 **실경기 id 는 `P077`** 이라 첫 글자가 절대 "H" 가 아니다 → **항상 away**.
// 라이브 실측(01KYSQP…S0RFTD 전반): 누적 점유가 home 0 : away 2219 로 집계돼 게임화면 점유율 바가
// **home 0%** 로 떴다(실제로는 home 우세). 같은 추측이 공 트레일 색·SURGE 방향에도 쓰이고 있었다.
//
// 옳은 방법은 하나뿐이다 — **그 스냅샷의 players 에서 찾는다**. 같은 id 가 양 팀에 동시에 있으면
// (유저 덱과 봇이 선수 카탈로그를 공유해 라이브 하프의 38% 가 그렇다) **공에 더 가까운 쪽**을
// 소유자로 본다. 소유자를 못 찾으면 **null** 이다 — 모르는 것을 "away" 라고 답하지 않는다.

/** 두 점 사이 거리(제곱근 생략 없이 — 비교 대상이 몇 개뿐이라 가독성을 택한다). */
function dist(p, b) {
  return Math.hypot(p.pos.x - b.x, p.pos.y - b.y);
}

/**
 * 스냅샷의 공 소유팀. `"home" | "away" | null`.
 * @param {{ballOwner?:string|null, players?:Array<{playerId:string,team:string,pos:{x:number,y:number}}>, ball?:{x:number,y:number}}} snap
 */
export function ownerSideOf(snap) {
  const id = snap && snap.ballOwner;
  if (!id) return null;
  const players = snap.players || [];
  let found = null;
  let best = Infinity;
  let count = 0;
  for (const p of players) {
    if (p.playerId !== id) continue;
    count++;
    if (count === 1) {
      found = p;
      continue;
    }
    // 중복 id — 공에 더 가까운 쪽이 실제 소유자다.
    const ball = snap.ball || { x: 0, y: 0 };
    if (best === Infinity) best = dist(found, ball);
    const d = dist(p, ball);
    if (d < best) {
      best = d;
      found = p;
    }
  }
  return found ? found.team || null : null;
}
