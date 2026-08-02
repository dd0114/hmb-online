// 게임 로그(FM식 코멘터리) 투영 — MatchEvent[] → 표시 라인. **투영 규칙의 SoT(런타임).**
//
// P4-D3: web(React LogPanel)·QA dev-viewer(티커) 가 모두 이 함수를 소비한다. 규칙을 바꿀 땐 여기만 고친다.
// 타입 표면은 log-lines.ts 가 이 .mjs 를 감싸 제공한다(stats.ts↔stats.mjs 와 같은 패턴).
// dev-viewer 셸은 이 파일을 인라인(build-standalone/build-test-viewer 가 export 제거)해 renderTicker 가 소비.
//
// 순수 함수 — DOM·프레임워크·시간·난수 의존 0(루트 CLAUDE §2-5 결정론 원칙과 같은 규율).

/*
 * ⚠️ `clearance`(#314) 는 **일부러 빠져 있다** — #406 W5 에서 캔버스 이펙트·토스트를 붙이면서
 * 같이 검토하고 **넣지 않기로** 했다. 이유 셋:
 *   ① 이 표를 넓히면 소비자 계약이 **모듈 밖에서** 먼저 깨진다 — `apps/web` 이
 *      *"코어가 안 보여주는 타입도 매핑은 있다"* 를 `lineFor("clearance") === undefined` 로
 *      **리터럴 박제**해 뒀다(`apps/web/src/match/stage/log-labels.test.ts`). 그 파일은 다른 웨이브
 *      소유라 여기서 같이 고칠 수 없다(#57 원칙) → 넓힐 거면 **한 웨이브에서 둘 다** 고쳐야 한다.
 *   ② 요구 4-2 는 "피치 위 행동이 보이게"이지 티커 항목 추가가 아니다. 걷어내기는 경기당 ~32건
 *      이라 `pass`(395건)와 같은 급의 **저신호 대량 이벤트**에 가깝다 — 티커에 올리면 골·카드가
 *      묻힌다(web 이 #325 에서 실제로 겪은 모양).
 *   ③ 화면이 데이터에 없는 말을 하는 게 아니다 — 반대로 **데이터에 있는 것을 티커가 요약**하는
 *      층이므로, 캔버스에만 있고 티커에 없는 것은 인지 갭(§2-2)이 아니라 편집 판단이다.
 * 넓히기로 결정하면 `EV_LABEL`(영어) + web `koLogLabel`(한글, 이미 있다) + 저 리터럴 계약을 같이 고쳐라.
 */
/** 티커에 노출하는 이벤트 타입(그 외는 소음). */
const SHOWN = new Set([
  "goal", "shot", "tackle", "interception", "kickoff", "foul", "offside",
  "free_kick", "penalty", "card", "save", "substitution", "half_whistle", "full_whistle",
]);

const MAJOR_EV = new Set(["goal", "penalty", "card", "substitution", "half_whistle", "full_whistle"]);
const MINOR_EV = new Set(["tackle", "interception", "kickoff"]);

const EV_LABEL = {
  goal: "⚽ Goal", shot: "Shot", tackle: "Tackle", interception: "Interception",
  foul: "Foul", offside: "🚩 Offside", free_kick: "Free kick",
  penalty: "⚽ Penalty!", save: "🧤 Save", card: "Card",
  half_whistle: "Half-time", full_whistle: "Full-time",
};

const SHOT_LABEL = {
  saved: "Shot · saved 🧤",
  off_target: "Shot · off target",
  one_on_one: "1-on-1 chance!",
  penalty: "Penalty shot",
};

const RESTART_LABEL = {
  corner: "Corner",
  goal_kick: "Goal kick",
  throw_in: "Throw-in",
};

/** 코멘터리 중요도 — major=골/PK/카드/교체/휘슬, minor=세트피스·태클·차단·빗나간슛. */
export function eventTier(e) {
  if (MAJOR_EV.has(e.type)) return "major";
  if (MINOR_EV.has(e.type)) return "minor";
  if (e.type === "shot" && e.detail === "off_target") return "minor";
  return "normal";
}

/** 티커에 나오는 이벤트인가 — 경기중 무-detail 킥오프(재시작 노이즈)는 숨긴다. */
export function isLogged(e) {
  if (!SHOWN.has(e.type)) return false;
  if (e.type === "kickoff" && e.detail == null && e.minute > 0) return false;
  return true;
}

function labelOf(e) {
  switch (e.type) {
    case "goal": return "⚽ GOAL";
    case "penalty": return "⚽ PENALTY awarded";
    case "card": return e.detail === "red" ? "🟥 Red card" : "🟨 Yellow card";
    case "substitution": return "🔄 Substitution";
    case "kickoff": return RESTART_LABEL[e.detail ?? ""] ?? "Kick-off";
    case "shot": return SHOT_LABEL[e.detail ?? ""] ?? "Shot on goal";
    case "free_kick": return e.detail ? `Free kick (${e.detail})` : "Free kick";
    default: return EV_LABEL[e.type] ?? e.type;
  }
}

/**
 * uptoTick(포함)까지의 로그 라인. uptoTick 을 주지 않으면 전체.
 * 골 라인에는 그 시점의 스코어를 함께 계산해 붙인다(진행 중 스코어 = 재생 시점 기준).
 *
 * `baseline` = **이 로그 앞에 이미 끝난 하프의 스코어**(#233). 하프 로그는 그 하프의 골만 갖기
 * 때문에, 후반 로그를 그대로 세면 골 라인이 `0-1` 부터 다시 시작한다. 생략하면 하프 로컬 그대로다
 * (dev-viewer 는 하프 하나를 통짜로 보므로 인자를 주지 않는다 = 무회귀).
 */
export function logLines(events, uptoTick, baseline) {
  const upto = uptoTick ?? Number.POSITIVE_INFINITY;
  const out = [];
  let h = baseline?.home ?? 0;
  let a = baseline?.away ?? 0;
  for (const e of events) {
    // 정렬 가정을 하지 않는다(break 대신 continue) — 로그가 어떤 순서로 오든 결과가 같다.
    if (e.tick > upto) continue;
    if (e.type === "goal") {
      if (e.team === "home") h++;
      else if (e.team === "away") a++;
    }
    if (!isLogged(e)) continue;
    const line = {
      tick: e.tick,
      minute: e.minute,
      type: e.type,
      tier: eventTier(e),
      label: labelOf(e),
    };
    if (e.type === "goal") line.score = `${h}-${a}`;
    if (e.playerId) {
      // #334: id 파생이 **등번호로 읽힐 때만** 번호로 내보낸다. 실경기 id 는 "P108" 이라 이 치환이
      // 아무것도 못 지우고, 그대로 화면 로그 탭에 `#P108` 로 찍혔다(라이브 한 하프 152/152).
      // 코어는 피치 위 토큰엔 이미 같은 방어선이 있었다(#218) — 자막·로그만 빠져 있었다.
      // ⚠️ 판정은 **길이가 아니라 숫자성**이다(독립검증 minor-2). 길이로 걸면 `"XY"` 같은 값이
      // 등번호 행세를 하고, 카드 자막에선 `"PH7"` → `#P7` 처럼 **잘린 id** 가 찍힌다.
      // 지금 카탈로그(P###)에선 도달 불가지만, 의도("등번호로 읽힐 때만")는 이 술어가 정확하다.
      const derived = e.playerId.replace(/[HA]/, "");
      if (/^\d{1,2}$/.test(derived)) line.number = derived;
      // 부모(web)는 팀별 등번호 표를 갖고 있다(#324 jerseyNumbers) → 진짜 번호를 붙이도록 재료를 준다.
      line.playerId = e.playerId;
    }
    if (e.team) line.team = e.team;
    if (e.type === "shot" && typeof e.xg === "number") line.xg = e.xg.toFixed(2);
    out.push(line);
  }
  return out;
}

/**
 * uptoTick 까지의 스코어(골 이벤트 누적). 스코어바가 재생 진행에 맞춰 쓰는 값.
 * `baseline` = 이 로그 앞에 이미 끝난 하프의 스코어(#233) — 생략하면 하프 로컬(무회귀).
 */
export function scoreAt(events, uptoTick, baseline) {
  let home = baseline?.home ?? 0;
  let away = baseline?.away ?? 0;
  for (const e of events) {
    if (e.type !== "goal" || e.tick > uptoTick) continue;
    if (e.team === "home") home++;
    else if (e.team === "away") away++;
  }
  return { home, away };
}
