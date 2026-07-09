// playback.mjs — 뷰어 재생 로직(순수 함수, DOM 무관). vitest 로 검증하고 뷰어가 인라인 사용한다.
// 핵심 원칙: "데드볼 재배치"에서만 공 보간을 끊는다. 빠른 슛 궤적은 이벤트로 구분되므로 끊지 않는다.

/** 이벤트 종류 키. kickoff+detail(corner/throw_in/goal_kick), shot+detail(saved/off_target/one_on_one) 를 펼친다. */
export function eventKind(e) {
  return e.type === "kickoff" ? (e.detail || "kickoff")
    : e.type === "shot" && e.detail ? "shot_" + e.detail
    : e.type;
}

// 공이 세트피스 스팟으로 "재배치(순간이동)"되는 이벤트들. 이 틱 경계에서만 보간을 컷.
// ⚠️ goal 은 여기 넣지 않는다: 슛 발사→네트로 "날아 들어가는" 마지막 비행 레그를 컷하면
//    공이 안 보이고 순간이동한다(V3 #16). 골 후 네트→센터 리셋은 뒤따르는 kickoff(집합 포함)가 컷하므로 안전.
const REPOSITION = new Set(["corner", "goal_kick", "throw_in", "free_kick", "penalty", "kickoff"]);

/** 데드볼 재배치가 일어나는 틱 집합. */
export function buildRestartTicks(events) {
  const s = new Set();
  for (const e of events) if (REPOSITION.has(eventKind(e))) s.add(e.tick);
  return s;
}

/**
 * 스냅샷 A(aTick)→B(bTick) 보간 구간에 데드볼 재배치가 있으면 true(그 구간은 컷).
 * 슛 궤적은 재배치 이벤트가 없으므로 거리와 무관하게 false → 부드럽게 보간된다.
 */
export function spansReposition(aTick, bTick, restartTicks) {
  for (let t = aTick + 1; t <= bTick; t++) if (restartTicks.has(t)) return true;
  return false;
}

/**
 * 데드볼 정지 시퀀스(원인 → 큰 자막 + freeze → 재시작으로 skip).
 * 골은 isGoal:true(GOAL 자막 + 색종이), 나머지(선방/빗나감/파울/오프사이드/PK)는 isGoal:false(상황 카드).
 * → '선방인데 골처럼' 방지: 골과 상황 자막을 데이터 레벨에서 구분.
 */
export function buildStoppages(events) {
  const CAUSE = {
    save: { big: "🧤 선방!", col: "#38bdf8", hold: 1300 },
    shot_off_target: { big: "빗나감!", col: "#94a3b8", hold: 1100 },
    foul: { big: "😠 파울!", col: "#fb923c", hold: 1100 },
    offside: { big: "🚩 오프사이드!", col: "#f59e0b", hold: 1300 },
    penalty: { big: "⚽ 페널티킥!", col: "#22c55e", hold: 1500 },
  };
  const RESTART = new Set(["corner", "goal_kick", "throw_in", "free_kick", "kickoff"]);
  const nextRestart = (fromIdx, fromTick, span) => {
    for (let j = fromIdx + 1; j < events.length && events[j].tick <= fromTick + span; j++)
      if (RESTART.has(eventKind(events[j]))) return events[j].tick;
    return fromTick + 6;
  };
  // 골 후에는 '킥오프' 이벤트로 skip(포메이션 리셋 지점). 없으면 아무 재시작으로 폴백.
  const nextKickoff = (fromIdx, fromTick, span) => {
    for (let j = fromIdx + 1; j < events.length && events[j].tick <= fromTick + span; j++)
      if (eventKind(events[j]) === "kickoff") return events[j].tick;
    return nextRestart(fromIdx, fromTick, span);
  };
  // 세트피스 "정지 비트": 자막 없이 짧게 freeze 만(공이 스팟에 놓인 걸 눈으로 확인). 배너는 annotation 이 담당.
  //  - 그 자리에서 재개(restartTick=causeTick)하므로 프레임 스킵 없음 = 순수 일시정지.
  // 코너·프리킥만(자주 나오는 골킥/스로인은 정지가 오히려 노이즈라 제외).
  const PAUSE_BEAT = { corner: 700, free_kick: 600 };
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const k = eventKind(events[i]);
    if (k === "goal") {
      // ⚽ 이모지 제거: 화면 중앙 큰 ⚽ 가 '공이 미드필드에 있는 것처럼' 오해를 유발. 텍스트만.
      out.push({ causeTick: events[i].tick, restartTick: nextKickoff(i, events[i].tick, 60), big: "GOAL!", bigCol: "#22c55e", hold: 1700, isGoal: true, done: false });
      continue;
    }
    const c = CAUSE[k];
    if (c) {
      out.push({ causeTick: events[i].tick, restartTick: nextRestart(i, events[i].tick, 45), big: c.big, bigCol: c.col, hold: c.hold, isGoal: false, done: false });
      continue;
    }
    const beat = PAUSE_BEAT[k];
    if (beat) {
      // pauseOnly: 상황카드 없이 그 틱에서 freeze 후 제자리 재개. 배너(annotation)만 보인다.
      out.push({ causeTick: events[i].tick, restartTick: events[i].tick, big: "", bigCol: "", hold: beat, isGoal: false, pauseOnly: true, done: false });
    }
  }
  return out;
}

/** 액션 토스트(선수 근처) + 상황 배너(상단) + 돌파 추론 주석. */
export function buildAnnotations(events, snaps) {
  const annos = [];
  for (const e of events) {
    const k = eventKind(e);
    const T = (text, col) => annos.push({ kind: "toast", tick: e.tick, at: e.tick, text, col });
    const B = (text, col) => annos.push({ kind: "banner", tick: e.tick, text, col });
    if (k === "shot") T("슛!", "#fbbf24");
    else if (k === "shot_one_on_one") T("1:1 찬스!", "#fbbf24");
    else if (k === "save") T("🧤 선방!", "#38bdf8");
    else if (k === "shot_off_target") T("빗나감", "#94a3b8");
    else if (k === "tackle") T("태클", "#cbd5e1");
    else if (k === "interception") T("차단", "#cbd5e1");
    else if (k === "foul") { T("파울", "#fb923c"); B("😠 파울 → 프리킥", "#fb923c"); }
    else if (k === "card") T(e.detail === "red" ? "🟥 레드!" : "🟨 옐로", e.detail === "red" ? "#ef4444" : "#fde047");
    else if (k === "offside") B("🚩 오프사이드", "#f59e0b");
    else if (k === "penalty") B("⚽ 페널티킥!", "#22c55e");
    else if (k === "corner") B("코너킥", "#e7edf6");
    else if (k === "goal_kick") B("골킥", "#e7edf6");
    else if (k === "throw_in") B("스로인", "#e7edf6");
    else if (k === "free_kick") B("프리킥", "#e7edf6");
    else if (k === "kickoff" && e.minute > 0) B("▶ 킥오프", "#e7edf6");
  }
  // 돌파(롱 드리블) 추론: 같은 소유자 유지 + 전진.
  let start = 0;
  for (let i = 1; i <= snaps.length; i++) {
    const prevO = snaps[i - 1] ? snaps[i - 1].ballOwner : null;
    const curO = snaps[i] ? snaps[i].ballOwner : null;
    if (curO !== prevO || i === snaps.length) {
      const run = i - start;
      if (prevO && run >= 6) {
        const a = snaps[start].ball, b = snaps[i - 1].ball;
        const fwd = prevO[0] === "H" ? b.x - a.x : a.x - b.x;
        const mid = snaps[start + Math.floor(run / 2)];
        if (fwd >= 9 && mid) annos.push({ kind: "toast", tick: mid.tick, at: mid.tick, text: "돌파!", col: "#a78bfa" });
      }
      start = i;
    }
  }
  return annos;
}

/** 뷰어가 loadLog 에서 한 번 호출. */
export function buildPlayback(events, snaps) {
  return {
    annos: buildAnnotations(events, snaps),
    stoppages: buildStoppages(events),
    restartTicks: buildRestartTicks(events),
  };
}
