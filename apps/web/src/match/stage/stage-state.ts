/**
 * 관전 화면 셸의 순수 상태 로직 (P4-E1 S1, #169).
 * 설계 = docs/plan-v5/layout-game-screen.md §2·§3.
 *
 * 두 종류의 패널을 구분한다 — 이 구분이 "기본은 경기장면만"(AC-W1-1)을 지키는 핵심이다.
 *  · **토글 패널**(stats/log/brief): 유저 소유. 기본 off, localStorage 로 기억.
 *  · **상태 패널**(halftime/result): 매치 상태 소유. 유저가 지금 해야 하는 일(교체·후반시작·결과확인)
 *    이라 상태가 되면 자동으로 열린다. 토글 3개는 이때도 여전히 off.
 */

export type ToggleKey = "stats" | "log" | "brief";
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
export type TabKey = ToggleKey | StatePanelKey | StageTabKey;

export const TOGGLE_KEYS: readonly ToggleKey[] = ["stats", "log", "brief"];

export type Toggles = Record<ToggleKey, boolean>;

/** 기본 = 경기장면만(AC-W1-1). */
export const DEFAULT_TOGGLES: Toggles = { stats: false, log: false, brief: false };

export const TOGGLE_STORAGE_KEY = "hmb.stage.toggles";

/** #244: 이모지를 뺀다 — 색·아이콘이 의미 없이 알록달록해지던 축(재설계 원칙 "색은 4개만"). */
export const TAB_LABELS: Record<TabKey, string> = {
  stats: "통계",
  log: "로그",
  brief: "후반 지시",
  halftime: "감독",
  result: "결과",
  stage: "경기장면",
};

/** 저장값 파싱 — 손상/구버전/부분 저장 전부 기본값으로 흡수(화면이 깨지지 않게). */
export function parseToggles(raw: string | null | undefined): Toggles {
  if (!raw) return { ...DEFAULT_TOGGLES };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_TOGGLES };
    const rec = parsed as Record<string, unknown>;
    const out = { ...DEFAULT_TOGGLES };
    for (const k of TOGGLE_KEYS) if (typeof rec[k] === "boolean") out[k] = rec[k];
    return out;
  } catch {
    return { ...DEFAULT_TOGGLES };
  }
}

export function serializeToggles(t: Toggles): string {
  return JSON.stringify({ stats: t.stats, log: t.log, brief: t.brief });
}

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

/** 매치 상태가 소유하는 패널(없으면 null). */
export function statePanelFor(state: string | undefined): StatePanelKey | null {
  if (isHalftimeState(state)) return "halftime";
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
  const snaps = (log as { tickSnapshots?: { tick?: unknown }[] } | null | undefined)?.tickSnapshots;
  if (!Array.isArray(snaps) || snaps.length === 0) return null;
  const last = snaps[snaps.length - 1];
  return typeof last?.tick === "number" && Number.isFinite(last.tick) ? last.tick : null;
}

/**
 * 헤더 시계가 가리킬 틱 (#226). 감독시간에는 **하프가 끝난 지점**을 고정으로 가리킨다 —
 * 그 하프는 이미 끝났고(스코어도 확정), 그 밑에서 도는 재생은 자유 리뷰라 플레이헤드를 따라가면
 * 헤더가 "전반 결과"가 아니라 "지금 어디까지 다시 보는 중"을 말하게 된다. 되감거나 새로 들어와
 * 재생이 앞쪽에서 시작하면 그대로 `0'` 가 된다(hero 제보 화면).
 *
 * 하프 끝을 모르면(로그 미도착) 재생 플레이헤드로 **되돌아가지 않고** null 을 준다 — 틀린 숫자보다
 * 숫자 없음이 낫다. 라이브 하프(전·후반 진행 중)는 그대로 플레이헤드를 따라간다.
 */
export function headerTick(
  state: string | undefined,
  playheadTick: number | null,
  halfEndTick: number | null,
): number | null {
  return isHalftimeState(state) ? halfEndTick : playheadTick;
}

/** 자리는 지키되 값은 모른다는 표기 — 로그 도착 전 한두 프레임 동안 슬롯이 사라지지 않게 한다. */
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
export function clockLabel(state: string | undefined, tick: number | null): string | null {
  if (isHalftimeState(state)) {
    // 하프 끝은 딱 떨어지지 않는다 — 전반 마지막 스냅샷 틱 2699 는 44.98분이라 내리면 44' 가 된다.
    return tick == null ? null : `${Math.round(tick / 60)}'`;
  }
  return tick == null ? CLOCK_PLACEHOLDER : `${Math.floor(tick / 60)}'`;
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
 * 시트에 뜰 탭 목록. 상태 패널이 먼저(유저가 해야 할 일), 그 뒤 켜진 토글이 고정 순서로.
 * 빈 배열이면 시트 자체가 없다(무대만).
 */
export function tabsFor(toggles: Toggles, statePanel: StatePanelKey | null): TabKey[] {
  const tabs: TabKey[] = [];
  if (statePanel) tabs.push(statePanel);
  // 감독시간에는 무대가 상시가 아니라 **탭**이다(#244) — 감독 패널 바로 다음 자리에 둔다.
  if (statePanel === "halftime") tabs.push("stage");
  for (const k of TOGGLE_KEYS) if (toggles[k]) tabs.push(k);
  return tabs;
}

/**
 * 활성 탭 결정 — 유저가 고른 탭이 아직 살아 있으면 유지, 아니면 첫 탭(=상태 패널 우선).
 * 탭이 없으면 null.
 */
export function resolveActiveTab(tabs: readonly TabKey[], preferred: TabKey | null): TabKey | null {
  if (tabs.length === 0) return null;
  if (preferred && tabs.includes(preferred)) return preferred;
  return tabs[0] ?? null;
}

/**
 * 시트 높이 등급 — **콘텐츠와 무관**하다(내용이 쌓여도 높이가 안 변한다). 탭 종류로만 갈린다:
 *  · info(통계·로그·후반지시) = 낮게 → 무대를 크게 본다(관전이 주목적).
 *  · state(감독·결과) = 높게 → 실제로 조작해야 하는 폼/표라 볼 게 많다.
 * 실제 픽셀은 CSS 가 정한다(데스크탑만 구분, 모바일은 무대가 폭으로 정해져 남는 높이를 시트가 가짐).
 */
export function sheetHeight(tab: TabKey | null): "info" | "state" | null {
  if (!tab) return null;
  // 경기장면 탭도 "state" 높이를 쓴다 — 정보 패널(통계·로그)보다 크게 봐야 뭘 보는지 알 수 있다.
  return tab === "halftime" || tab === "result" || tab === "stage" ? "state" : "info";
}
