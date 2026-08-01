/**
 * 관전 화면 셸의 순수 상태 로직 (P4-E1 S1, #169 → #284 재편).
 * 설계 = docs/plan-v5/layout-game-screen.md §2·§3.
 *
 * ── #284: 토글이 없어졌다 (hero 결정) ──────────────────────────────────────────────────────
 * 원래는 정보 패널 3개(통계·로그·후반지시)가 **유저 소유 토글**이었고 기본 off 였다(#169 AC-W1-1
 * "기본은 경기장면만"). 그래서 화면 아래 토글바가 상시로 있고, 두 개 이상 켜면 시트 위에 탭바가
 * 또 생겨 **똑같이 생긴 줄이 두 개**였다.
 *
 * hero: *"탭 구조면 그 안에서 조정하면 되지 껐다켰다 할 필요가 없다."* → 토글바를 없애고 탭바
 * 하나만 남긴다. **무엇이 탭으로 뜨는지는 이제 매치 상태가 정한다**(유저 설정이 아니다):
 *
 *   FIRST_HALF   → 통계 · 로그 · 후반 지시
 *   HALFTIME     → 감독 · 경기장면 · 통계 · 로그     (후반 지시는 **감독 탭이 소유**한다 — 아래)
 *   SECOND_HALF  → 통계 · 로그
 *   FINISHED     → 결과 · 통계 · 로그
 *
 * 패널은 여전히 두 종류다:
 *  · **정보 탭**(stats/log/brief): 항상 보인다. 다만 `brief` 는 **써서 의미가 있는 상태에서만**
 *    (= 전반). 만져도 아무 데도 안 가는 손잡이를 남기지 않는다(#254 의 `hideTeamTune` 과 같은 규칙).
 *  · **상태 패널**(halftime/result): 매치 상태 소유. 유저가 지금 해야 하는 일이라 맨 앞에 오고
 *    기본으로 열린다.
 */

import { suppressHalftimePanel } from "../auto-mode";

export type InfoTabKey = "stats" | "log" | "brief";
export type StatePanelKey = "halftime" | "result";
/**
 * `stage` = **경기장면 탭**(감독시간 전용, #244).
 * 감독시간에는 무대를 상시 띄우지 않고 탭 하나로 내린다 — hero 결정. 이유는 두 가지다:
 *  ① 이 상태에선 경기가 멈춰 있고 유저가 하는 일은 전부 패널 안(라인업·교체·프롬프트)이다.
 *  ② 무대가 세로를 118~490px 먹으면 **감독시간만 덱 화면과 다른 레이아웃**이 된다 —
 *     "덱 만들 때와 형식이 같아야 한다"(hero)를 지키려면 그 자리를 비워야 한다.
 * 관전(전·후반)에서는 여전히 무대가 상시다 — 이 탭은 감독시간에만 나타난다(#169 AC-W1-1 유지).
 */
export type StageTabKey = "stage";
export type TabKey = InfoTabKey | StatePanelKey | StageTabKey;

/** 정보 탭의 **표시 순서**(내용과 무관한 고정 순서 — 화면마다 달라지면 근육기억이 깨진다). */
export const INFO_TAB_KEYS: readonly InfoTabKey[] = ["stats", "log", "brief"];

/**
 * 상태 패널이 없을 때 기본으로 열리는 탭 (#284 hero 확정 = 로그).
 * 관전 중 가장 자연스러운 동반 정보이고, 경기가 흐르면 내용이 채워져 빈 화면이 되지 않는다
 * (통계는 초반에 0-0/0슛이라 한동안 빈 표처럼 보인다).
 */
export const DEFAULT_INFO_TAB: InfoTabKey = "log";

/** #244: 이모지를 뺀다 — 색·아이콘이 의미 없이 알록달록해지던 축(재설계 원칙 "색은 4개만"). */
export const TAB_LABELS: Record<TabKey, string> = {
  stats: "통계",
  log: "로그",
  brief: "후반 지시",
  halftime: "감독",
  result: "결과",
  stage: "경기장면",
};

/**
 * 감독시간인가 — **상태 이름이 둘**이다. `HALFTIME` 이 현행(P4-E2 #170)이고 `H1_BREAK` 은 그 자리의
 * 레거시 이름(P4 이전 배포본의 진행 중 매치)이다.
 *
 * ⚠️ 이 판정을 인라인으로 다시 쓰지 말고 여기를 불러라. #226 이 정확히 그 사고였다 — 헤더의
 * "확정 스코어 우선" 규칙이 `H1_BREAK` 만 보고 있어서, 실제 배포본이 쓰는 `HALFTIME` 에서는 규칙이
 * 통째로 빠진 채 헤더가 재생 플레이헤드를 따라갔다(API 는 0:4 인데 화면은 0:0/0').
 */
export function isHalftimeState(state: string | undefined): boolean {
  return state === "HALFTIME" || state === "H1_BREAK";
}

/**
 * 매치 상태가 소유하는 패널(없으면 null).
 *
 * `auto` 는 오토 모드(#249). 오토 매치는 감독 패널을 열지 않는다 — 서버가 감독시간을 0초로 열고
 * 같은 스윕에서 후반으로 잇기 때문에 그 상태는 **이미 지나간 것**인데, 스위퍼와 1초 폴링이 어긋난
 * 프레임이나 두 전이 사이 재시작 같은 틈에서는 화면에 올 수 있다. 그때 감독 패널이 번쩍이면
 * "오토인데 감독시간이 열렸다"로 보인다. 판정은 `suppressHalftimePanel`(../auto-mode) 이 소유한다.
 */
export function statePanelFor(
  state: string | undefined,
  auto?: boolean,
): StatePanelKey | null {
  if (isHalftimeState(state)) return suppressHalftimePanel(state, auto) ? null : "halftime";
  if (state === "FINISHED") return "result";
  return null;
}

/** 이 상태에서 무대가 재생할 하프. 후반이 열린 뒤로는 후반을 튼다. */
export function halfForState(state: string | undefined): 1 | 2 {
  return state === "SECOND_HALF" || state === "FINISHED" ? 2 : 1;
}

/**
 * 이 하프 로그가 끝나는 절대 틱 (#226). 감독시간 헤더 시계가 여기에 고정된다.
 *
 * 값은 **로그에서 파생**한다 — 웹에 "45분"을 상수로 적으면 엔진 하프 길이가 바뀐 날 문구만 거짓말이
 * 된다(리얼 하프는 0..2699 = 45', 데모 로그는 그 길이대로). 계약(shared `MatchLog`)은 `tick` 을
 * 필수로 두지만 openapi 생성 타입은 느슨해서, 실제로 없으면 `undefined` 를 흘려보내지 않고 접는다.
 */
export function halfEndTickOf(log: unknown): number | null {
  const snaps = snapshotsOf(log);
  if (!snaps) return null;
  const last = snaps[snaps.length - 1];
  return typeof last?.tick === "number" && Number.isFinite(last.tick) ? last.tick : null;
}

/**
 * ─── 헤더 시계의 축 (#388) ──────────────────────────────────────────────────────────────
 *
 * **분은 로그가 이미 굽고 있다 — 화면이 다시 계산하지 않는다.**
 *
 * 엔진은 45분(하프 1350틱)을 돌리고 표기만 0~90' 로 스케일해(`displayMinutes`, #365) 스냅샷과
 * 이벤트에 `minute` 을 구워서 내린다. 로그줄·타임라인은 그 값을 읽는데 헤더만 `floor(tick / 60)` 로
 * **틱을 분으로 직독**했다 → 라이브에서 헤더 25' 옆에 로그줄 48' 이 뜬다(한 화면이 두 시각을 말한다).
 *
 * ⚠️ 여기서 스케일을 다시 유도하지 마라(`minute = tick × displayMinutes / matchMinutes / 60`).
 * 그건 규칙을 두 곳에 두는 것이고, 엔진이 표기 규칙을 바꾸는 날 **화면만 조용히 어긋난다** —
 * 정확히 이 결함이 그렇게 생겼다(engine@0.23.0 까지는 하프 2700틱이라 `tick/60` 이 우연히 맞았다).
 * 축은 하나다: **로그가 구운 `minute`**.
 */
interface SnapshotLike {
  tick?: unknown;
  minute?: unknown;
}

/**
 * 로그의 스냅샷 배열 — 모양이 아니면 null.
 *
 * ⚠️ 타입이 지켜 주지 않는다: 생성된 openapi 타입에서 `tickSnapshots` 는 `{[key:string]: unknown}[]`
 * 이고, 구 서버·프록시가 200 `{}` 를 줄 수도 있다. 여기서 흡수하지 않으면 헤더 하나가 관전 화면
 * 전체를 흰 화면으로 만든다(#274 부류).
 */
function snapshotsOf(log: unknown): SnapshotLike[] | null {
  const snaps = (log as { tickSnapshots?: unknown } | null | undefined)?.tickSnapshots;
  return Array.isArray(snaps) && snaps.length > 0 ? (snaps as SnapshotLike[]) : null;
}

function eventsOf(log: unknown): { tick?: unknown; minute?: unknown; type?: unknown }[] {
  const evs = (log as { events?: unknown } | null | undefined)?.events;
  return Array.isArray(evs) ? evs : [];
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * 플레이헤드 틱의 **표기 분** = `tick` 이하인 마지막 스냅샷의 구운 `minute`.
 *
 * 실서버 로그는 **틱당 스냅샷 1개**라(`simulateRange`) 사실상 정확히 그 틱의 값이다. 그런데 리포
 * 테스트 픽스처는 트림본이라 성기다 — 그래서 "그 틱의 스냅샷"이 아니라 **"tick 이하의 마지막"**
 * 으로 찾는다. 둘 다 견디는 규칙이고, 성긴 로그에서 미래 분을 앞당겨 말하지도 않는다(스포일러 규율).
 */
export function displayMinuteAt(log: unknown, tick: number | null): number | null {
  if (tick == null) return null;
  const snaps = snapshotsOf(log);
  if (!snaps) return null;
  let found: number | null = null;
  for (const s of snaps) {
    const t = finiteOrNull(s?.tick);
    if (t == null || t > tick) continue;
    const m = finiteOrNull(s?.minute);
    if (m != null) found = m;
  }
  return found;
}

/**
 * 이 하프가 끝난 **표기 분**. 감독시간 헤더(#226)가 쓴다.
 *
 * ⚠️ **마지막 스냅샷이 아니라 종료 휘슬 이벤트가 먼저다.** 전반 마지막 스냅샷은 틱 1349 → 구운
 * 분 44 인데 로그줄은 `45' 전반 종료`(`half_whistle minute 45`)라고 말한다. 스냅샷을 쓰면 그
 * 화면이 또 두 시각을 말한다. 휘슬이 없는(트림·손상) 로그에서만 마지막 스냅샷으로 폴백한다.
 */
export function halfEndMinuteOf(log: unknown): number | null {
  for (const e of eventsOf(log)) {
    if (e?.type !== "half_whistle" && e?.type !== "full_whistle") continue;
    const m = finiteOrNull(e?.minute);
    if (m != null) return m;
  }
  const snaps = snapshotsOf(log);
  if (!snaps) return null;
  for (let i = snaps.length - 1; i >= 0; i -= 1) {
    const m = finiteOrNull(snaps[i]?.minute);
    if (m != null) return m;
  }
  return null;
}

/**
 * 헤더 시계가 말할 **표기 분** (#226 규칙 유지 + #388 축 교정).
 *
 * 감독시간에는 **그 하프가 끝난 지점**을 고정으로 가리킨다 — 그 하프는 이미 끝났고(스코어도 확정)
 * 그 밑에서 도는 재생은 자유 리뷰라, 플레이헤드를 따라가면 헤더가 "전반 결과"가 아니라 "지금 어디까지
 * 다시 보는 중"을 말하게 된다(되감으면 그대로 `0'` — hero 제보 화면).
 * 하프 끝을 모르면(로그 미도착) 플레이헤드로 **되돌아가지 않고** null 이다 — 틀린 숫자보다 없는 게 낫다.
 */
export function headerMinute(
  state: string | undefined,
  log: unknown,
  playheadTick: number | null,
): number | null {
  return isHalftimeState(state) ? halfEndMinuteOf(log) : displayMinuteAt(log, playheadTick);
}

export const CLOCK_PLACEHOLDER = "--'";

/**
 * 헤더 시계 문구 (#233 스코프 추가). **경기 분은 상시 보인다** — 배포본은 12px muted 로 구석에
 * 있는 데다 플레이헤드가 오기 전엔 요소 자체가 사라져서 hero 가 "경기 시간이 안 보인다"고 했다.
 *
 * 값은 **재생 위치 기준 게임 분**이다(실경과 시간이 아니다 — 한 하프는 압축돼 흐르므로 실시간을
 * 그리면 34' 장면에서 7' 이 뜬다). 재생 위치를 넘는 분을 보여주지 않으므로 스포일러 규칙과도 정합.
 *
 * 두 가지 "모름"을 구분한다:
 *  · 감독시간인데 하프 끝을 모른다 → **null**(시계를 접는다). 그 화면의 시계는 "전반이 끝난 지점"을
 *    뜻하므로 모르면 틀린 숫자를 쓰느니 접는 게 낫다(#226 결정).
 *  · 라이브/다시보기인데 플레이헤드가 아직 없다 → **`--'`**(자리는 지킨다). 곧 채워질 값이고,
 *    슬롯이 사라졌다 나타나면 헤더가 흔들린다.
 */
export function clockLabel(state: string | undefined, minute: number | null): string | null {
  // ⚠️ 인자는 **표기 분**이다(#388). 틱을 넘기면 정확히 절반이 그려진다 — 그게 이 결함이었다.
  if (isHalftimeState(state)) return minute == null ? null : `${minute}'`;
  return minute == null ? CLOCK_PLACEHOLDER : `${minute}'`;
}

/**
 * ─── 사이드 ↔ 팀 이름 (#322) ────────────────────────────────────────────────────────────────
 *
 * **홈은 매치 소유자가 아니다.** 리그 어웨이 라운드에서는 서버가 유저를 away 사이드에 앉힌다
 * (`MatchOrchestrator.userIsHome()` — 픽스처 `home_team` 이 계약이고, 홈 어드밴티지가 봇에게 간다).
 * 스코어(`scoreHome/Away`)·이벤트 `team`·뷰어 렌더가 **전부 그 축**인데, web 만 `homeName = ownerName`
 * 으로 "홈 = 나"를 못 박고 있어서 리그 어웨이 라운드 화면이 통째로 뒤집혔다:
 * 스코어 반전 · 로그 팀 라벨 반전 · 좌우 반전(뷰어는 엔진 home 을 **항상 왼쪽**에 그린다).
 * 결과 카드가 `승리` 옆에 `축구왕여르 1 : 5 Thunder Bay United` 를 띄웠다.
 *
 * ⚠️ **여기서 사이드를 추론하지 않는다.** 서버가 `homeName`/`awayName` 을 **사이드 라벨 그대로** 준다.
 * 불리언(`userWasHome`) 하나만 받아 클라가 이름을 배치하면 관전자 경로(#245 — 홈이 공격자다)에서
 * 해석이 한 번 더 갈린다. 그 갈림이 정확히 이 버그를 만들었다.
 */
export interface TeamNameSource {
  /** 서버가 주는 **사이드 기준** 이름(#322 additive). 없으면 구 서버 → 폴백. */
  homeName?: string | null;
  awayName?: string | null;
  /** 폴백용 — 매치 소유자(#245). 연습·유저홈 리그에서는 이게 곧 홈이라 폴백이 정답이다. */
  ownerName?: string | null;
  opponent?: { name?: string | null } | null;
}

export interface TeamNames {
  home: string;
  away: string;
}

/**
 * 화면에 그릴 **사이드별** 팀 이름. 서버 값이 먼저고, 없으면 예전 동작(홈 = 소유자)으로 떨어진다.
 * 폴백이 안전한 이유: 구 서버가 도는 동안 web 이 먼저 나가도 연습·유저홈 리그는 결과가 같다.
 */
export function teamNamesOf(match: TeamNameSource | null | undefined, myName?: string | null): TeamNames {
  return {
    home: match?.homeName ?? match?.ownerName ?? myName ?? "내 팀",
    away: match?.awayName ?? match?.opponent?.name ?? "상대",
  };
}

/**
 * **내 팀이 어느 사이드인가** (안 C, hero 확정 2026-07-30).
 *
 * 어웨이 라운드에는 내 팀이 오른쪽에 서므로, 이름만으로는 유저가 매 라운드 자기 자리를 다시 찾아야
 * 한다. 그래서 표식을 단다. 판정은 **이름 일치**다 — 팀 이름이 곧 닉네임이고(원정 고스트 봇 이름도
 * 수비자의 닉네임이다) 그래서 소유자·관전자 양쪽에서 같은 규칙이 성립한다.
 *
 * 못 찾으면 **null** — 둘 다 남의 팀인 화면(관전 중 봇전 등)에 "내 팀"이라고 거짓말하지 않는다.
 */
export function myTeamSide(names: TeamNames, myName: string | null | undefined): "home" | "away" | null {
  if (!myName) return null;
  if (names.home === myName) return "home";
  if (names.away === myName) return "away";
  return null;
}

export interface ScorePair {
  home: number;
  away: number;
}

/** 서버가 소유하는 확정 스코어들(MatchDetail 의 구조적 부분집합 — 이 파일은 API 타입에 의존하지 않는다). */
export interface SettledScores {
  scoreH1Home?: number | null;
  scoreH1Away?: number | null;
  scoreHome?: number | null;
  scoreAway?: number | null;
}

/** 값을 모를 때의 표기 — 0 으로 단정하지 않는다(#226 선례: 틀린 숫자보다 없는 편이 낫다). */
const UNKNOWN: { home: string; away: string } = { home: "-", away: "-" };

const pairOf = (h: unknown, a: unknown): ScorePair | null =>
  typeof h === "number" && typeof a === "number" ? { home: h, away: a } : null;

/**
 * **지금 재생 중인 하프 앞에 이미 확정된 스코어** (#233).
 *
 * 하프 로그는 그 하프의 골만 갖는다(후반 로그 = 후반 골만, 틱만 절대값). 그래서 후반을 재생하는
 * 상태에서는 재생 델타에 **전반 확정 스코어**를 얹어야 경기 점수가 된다 — 이걸 아무도 안 해서
 * 배포본 후반 헤더가 `0 : 0` 으로 시작했다(라이브 실경기 전반은 1:4 였다).
 *
 * 확정값을 모르면 **null** — 0 으로 때우면 화면에 그 틀린 값이 그대로 남는다.
 */
export function playedBaseline(state: string | undefined, scores: SettledScores): ScorePair | null {
  if (halfForState(state) !== 2) return { home: 0, away: 0 };
  return pairOf(scores.scoreH1Home, scores.scoreH1Away);
}

/**
 * 헤더가 그릴 스코어 — **권위 분리** (#233, #226 을 흡수).
 *
 *   헤더 = [서버 확정] 이미 끝난 하프 전부 + [재생] 지금 하프의 플레이헤드 델타
 *
 * 진행 중 하프의 "지금 점수"는 서버가 정할 수 없다 — 유저가 되감으면 화면의 진실은 서버의 라이브
 * 엣지가 아니라 그 유저의 재생 위치이고, 서버 기준 점수를 그리면 앞선 점수 = 스포일러가 된다.
 * 반대로 **끝난 하프는 재생 위치와 무관하게 확정**이라 서버 값이 이긴다.
 *
 * ⚠️ 상태별 분기를 호출부에서 다시 쓰지 마라 — 그 패턴이 #226(감독시간)·#233(후반) 두 버그를 낳았다.
 */
export function headerScore(
  state: string | undefined,
  scores: SettledScores,
  delta: ScorePair | null,
): { home: number | string; away: number | string } {
  if (state === "FINISHED") return pairOf(scores.scoreHome, scores.scoreAway) ?? { ...UNKNOWN };
  if (isHalftimeState(state)) return pairOf(scores.scoreH1Home, scores.scoreH1Away) ?? { ...UNKNOWN };

  const base = playedBaseline(state, scores);
  if (!base) return { ...UNKNOWN };
  return { home: base.home + (delta?.home ?? 0), away: base.away + (delta?.away ?? 0) };
}

/**
 * **후반 지시(미리 작성) 탭을 띄우는 상태** — 전반뿐이다.
 *
 * 서버는 `POST /prompts{phase:halftime}` 을 FIRST_HALF·HALFTIME 둘 다 허용하지만(`MatchService`),
 * 감독시간에는 **감독 탭이 같은 입력을 프리필된 채로** 갖는다(#284). 둘을 같이 띄우면 같은 문장을
 * 편집하는 칸이 화면에 두 개가 되고, 어느 쪽이 이기는지 유저가 알 방법이 없다.
 * 후반·종료에서는 애초에 낼 곳이 없다(409).
 */
export function briefTabVisible(state: string | undefined): boolean {
  return state === "FIRST_HALF";
}

/**
 * 시트에 뜰 탭 목록 (#284 — 유저 토글이 아니라 **상태**가 정한다).
 * 상태 패널이 먼저(유저가 해야 할 일), 그 뒤 정보 탭이 고정 순서로.
 *
 * 빈 배열이 되는 경우는 없다 — 통계·로그는 항상 있다. 그래서 시트도 항상 있다(이게 #284 의 요구:
 * "애초부터 열려 있게"). `bodyNoSheet` 경로는 남겨 두되 도달하지 않는다.
 */
export function tabsFor(state: string | undefined, statePanel: StatePanelKey | null): TabKey[] {
  const tabs: TabKey[] = [];
  if (statePanel) tabs.push(statePanel);
  // 감독시간에는 무대가 상시가 아니라 **탭**이다(#244) — 감독 패널 바로 다음 자리에 둔다.
  if (statePanel === "halftime") tabs.push("stage");
  for (const k of INFO_TAB_KEYS) {
    if (k === "brief" && !briefTabVisible(state)) continue;
    tabs.push(k);
  }
  return tabs;
}

/**
 * 활성 탭 결정 — 유저가 고른 탭이 아직 살아 있으면 유지.
 *
 * 아니면 기본값인데, **순서가 있다**:
 *  ① 상태 패널(감독·결과)이 있으면 그것 — 지금 해야 할 일이 정보 탭보다 앞선다.
 *  ② 없으면 `DEFAULT_INFO_TAB`(로그, #284 hero 확정). 목록의 첫 탭(통계)이 아니다 —
 *    **표시 순서와 기본 선택은 다른 축**이다. 통계를 먼저 그리는 건 익숙한 순서라서고,
 *    로그를 먼저 여는 건 관전 중 볼 게 있어서다.
 */
export function resolveActiveTab(tabs: readonly TabKey[], preferred: TabKey | null): TabKey | null {
  if (tabs.length === 0) return null;
  if (preferred && tabs.includes(preferred)) return preferred;
  const first = tabs[0];
  if (first === "halftime" || first === "result") return first;
  return tabs.includes(DEFAULT_INFO_TAB) ? DEFAULT_INFO_TAB : (first ?? null);
}

/**
 * 시트 높이 등급 — **콘텐츠와 무관**하다(내용이 쌓여도 높이가 안 변한다). 탭 종류로만 갈린다:
 *  · info(통계·로그) = 낮게 → 무대를 크게 본다(관전이 주목적).
 *  · **input(후반 지시)** = 중간 → 관전 중이지만 **적는** 자리라 입력칸까지는 들어와야 한다.
 *  · state(감독·경기장면) = 높게 → 실제로 조작해야 하는 폼/표라 볼 게 많다.
 *  · **result(결과)** = 가장 높게 → 경기가 끝나 무대는 다시보기라 비중이 낮고, 읽을 것(스코어·
 *    보상·팀 스탯·성장 리포트)이 이 화면에서 가장 많다.
 * 실제 픽셀은 CSS 가 정한다(데스크탑만 구분, 모바일은 무대가 폭으로 정해져 남는 높이를 시트가 가짐).
 *
 * ⚠️ **`brief` 는 `info` 가 아니다** (#348, hero 실사용 제보). 예전엔 통계·로그와 한 등급이라
 * 데스크탑에서 26svh(1280×800 → 시트 208px)를 받았는데, 이 패널은 대상 칩 줄 + 프롬프트 칸 +
 * 저장 상태 + 안내로 **287px** 다 — 실측상 **입력 상자가 통째로 뷰포트 아래**로 밀려나 유저에게는
 * "적을 칸이 없는 화면"이었다(패널 안을 스크롤하면 닿지만, 800px 화면에서 150px 창을 스크롤해야
 * 한다는 걸 알 방법이 없다). "보는 패널"과 "쓰는 패널"은 필요한 세로가 다르다 — 그 축을 여기서 가른다.
 * 계약 = `e2e/p348-desktop-viewport.spec.ts` ①(데스크탑 전 비율에서 입력칸이 화면 안).
 *
 * ⚠️ **`result` 도 `state` 가 아니다** (#355). 40svh(상한 420px)를 받는 동안 결과 패널 내용
 * (449~481px, 성장 리포트가 붙으면 그 이상)이 들어가지 못해 **[로비로] CTA 가 모든 데스크탑
 * 비율에서 화면 밖**이었다 — 3440×1440 에서도 bottom 1576 > 1440 이라 "화면이 크면 괜찮다"가
 * 성립하지 않았다.
 * ⚠️ 다만 **높이를 키우는 것이 그 결함의 해법은 아니다.** 결과 패널 내용에는 상한이 없다
 * (`GrowthReportSection` 이 기용 선수 수만큼 행을 붙인다) — 어떤 고정값도 언젠가 모자란다.
 * CTA 를 지키는 것은 `ResultPanel` 의 **스크롤 밖 고정층**이고(감독시간과 같은 구조), 이 등급은
 * "얼마나 읽히나"를 좋게 할 뿐이다. 둘을 바꿔 생각하면 높이만 만지다 같은 버그로 돌아온다.
 */
export function sheetHeight(tab: TabKey | null): "info" | "input" | "state" | "result" | null {
  if (!tab) return null;
  if (tab === "result") return "result";
  // 경기장면 탭도 "state" 높이를 쓴다 — 정보 패널(통계·로그)보다 크게 봐야 뭘 보는지 알 수 있다.
  if (tab === "halftime" || tab === "stage") return "state";
  return tab === "brief" ? "input" : "info";
}
