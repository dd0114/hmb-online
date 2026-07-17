// standalone 빌드용 스냅샷 서브샘플(용량 축소). 뷰어가 사이 틱을 보간하므로 2개당 1개만 남긴다.
// #50: 단, **이벤트 참조 틱은 항상 보존**한다. 이벤트(코너/스로인/골 등)의 causeTick 이 홀수라
// 서브샘플에서 빠지면, 뷰어 idxOfTick(홀수) 가 다음 짝수틱으로 반올림되고, 선행 정지의 jump 가
// 그 causeTick 을 초과 착지해 해당 정지(자막/freeze)가 스킵된다(코너킥 자막 누락). 이벤트 틱을
// 유지하면 idxOfTick 이 정확해져 정지가 정상 트리거된다.
const r1 = (n) => Math.round(n * 10) / 10;

// 데드볼 재배치 이벤트(공 아웃/재시작). 이 causeTick 직전 몇 틱을 보존해야 뷰어가 공의
// "라이브 아웃 모션"과 연속/순간이동 판별(isContinuousOut)을 다운샘플에서도 정확히 한다(#51).
const REPOSITION_KINDS = new Set(["corner", "throw_in", "goal_kick", "free_kick", "penalty", "kickoff"]);
function isReposition(e) {
  const k = e.type === "kickoff" ? (e.detail || "kickoff") : e.type;
  return REPOSITION_KINDS.has(k);
}

export function subsampleSnapshots(tickSnapshots, events, step = 2) {
  const eventTicks = new Set(events.map((e) => e.tick));
  // #51: 데드볼 재배치 causeTick 직전 2틱(접근 궤적)도 보존 → 홀수 prev 가 다운샘플에서 사라져
  // prev→spot 거리가 뻥튀기돼 연속 아웃이 순간이동으로 오판되던 것 방지.
  const keepTicks = new Set(eventTicks);
  for (const e of events) if (isReposition(e)) { keepTicks.add(e.tick - 1); keepTicks.add(e.tick - 2); }
  const out = [];
  for (let i = 0; i < tickSnapshots.length; i++) {
    const s = tickSnapshots[i];
    if (i % step !== 0 && !keepTicks.has(s.tick)) continue; // 짝수 인덱스 또는 이벤트/접근 틱만 유지
    out.push({
      tick: s.tick,
      minute: s.minute,
      ball: { x: r1(s.ball.x), y: r1(s.ball.y) },
      ballOwner: s.ballOwner,
      players: s.players.map((p) => ({ playerId: p.playerId, team: p.team, pos: { x: r1(p.pos.x), y: r1(p.pos.y) } })),
    });
  }
  return out;
}
