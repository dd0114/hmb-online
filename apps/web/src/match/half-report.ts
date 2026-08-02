/**
 * 하프 리포트 — **골·카드 타임라인 카드의 데이터 조립**(순수 모듈, #421 W2).
 *
 * hero 요구: 스킵하면 *"골 기록·카드 기록 타임라인 1장"* 이 공지사항처럼 뜬다. 결과 화면은
 * **합계 표**만 있고 득점자 목록이 없어서(#421 W0-3) 이 화면은 신규지만, **데이터는 전부 있다** —
 * 아이콘·한글 라벨은 `match-logic.eventDisplay`, 표기 시각은 `timeline-pins.pinClock` 이 이미
 * 소유하므로 여기서 다시 만들지 않는다(재발명 금지, #57). 화면 두 곳이 같은 사건을 다르게
 * 부르면 그게 곧 다음 버그다.
 *
 * ── 이 모듈이 소유하는 규칙 ────────────────────────────────────────────────────────────
 * ① **무엇을 싣는가** = 골 · 카드. 슛·파울·코너는 통계 탭이 말한다(리포트는 "읽을 거리"다).
 * ② **경고 누적 퇴장을 두 줄로 쓰지 않는다** — 엔진은 같은 틱에 `card:"yellow"` 와 `card:"red"` 를
 *    **둘 다** 낸다(루트 CLAUDE §0.5.0 오프사이드·파울·카드). 그대로 그리면 한 사건이 두 줄이 되고
 *    유저는 카드가 두 장 나온 줄 안다. 레드 한 줄로 합치고 `secondYellow` 로 표시한다.
 * ③ **선수 이름 조회의 키는 `(team, playerId)` 다**(#231/#324). 유저 덱과 봇 로스터가 같은 선수
 *    카탈로그를 공유해 **같은 playerId 가 양 팀에 동시 출전**한다. 지금 이름 출처(`/api/players`)는
 *    id 하나로 답할 수 있지만, 조회 함수의 **시그니처를 팀 축까지 받게** 두어 소비자가 그 축을
 *    접지 못하게 한다 — 접는 순간 등번호·아바타처럼 팀이 뒤바뀌는 결함이 되살아난다.
 */

import { eventDisplay, runningScore, type MatchEventLike, type ScorePair } from "./match-logic";
import { pinClock } from "./timeline-pins";

export type ReportRowKind = "goal" | "yellow" | "red";

export interface HalfReportEventLike extends MatchEventLike {
  /** 엔진이 구워 내린 표기 분(0~90'). 없으면 `pinClock` 이 틱 폴백으로 내려간다(#388). */
  minute: number;
}

export interface ReportRow {
  /** React key — 같은 틱·같은 종류가 양 팀에서 나올 수 있으므로 팀·선수를 포함한다(위 ③). */
  key: string;
  tick: number;
  /** 표기 분(`23'`) — 로그가 구운 `minute` 이 SoT(#388, 틱 직독 금지). */
  clock: string;
  kind: ReportRowKind;
  icon: string;
  label: string;
  team?: string;
  playerId?: string;
  /** 카탈로그에서 찾은 이름. 못 찾으면 undefined — 화면이 등번호도 id 도 지어내지 않는다. */
  playerName?: string;
  /** 경고 누적 퇴장(같은 틱에 옐로+레드)인가 — 위 ②. */
  secondYellow?: boolean;
}

/** 선수 이름 조회. **팀 축을 받는다**(위 ③) — id 만 받는 함수로 좁히지 마라. */
export type NameOf = (team: string | undefined, playerId: string | undefined) => string | undefined;

export interface HalfReportOptions {
  nameOf?: NameOf;
}

function kindOf(e: HalfReportEventLike): ReportRowKind | null {
  if (e.type === "goal") return "goal";
  if (e.type !== "card") return null;
  return e.detail === "red" ? "red" : "yellow";
}

/** 같은 사건인가 = 같은 틱 · 같은 팀 · 같은 선수(위 ②의 병합 축). */
function actorKey(e: HalfReportEventLike): string {
  return `${e.tick}:${e.team ?? "?"}:${e.playerId ?? "?"}`;
}

/**
 * 이벤트 → 리포트 타임라인 행. **시각 순**(같은 틱이면 원래 순서 유지)이다.
 *
 * 하프 로그는 그 하프의 이벤트만 담으므로 여기서 하프를 자르지 않는다 — 자르려 들면 하프 경계
 * 규칙이 화면에 두 벌 생긴다(로그를 하프별로 따로 받는 것이 계약이다, #421 W0-3).
 */
export function buildHalfReportRows(
  events: readonly HalfReportEventLike[] | null | undefined,
  opts: HalfReportOptions = {},
): ReportRow[] {
  if (!events || events.length === 0) return [];

  // 경고 누적 퇴장 병합(위 ②): 같은 사건에 레드가 있으면 그 옐로는 행을 만들지 않는다.
  const redActors = new Set<string>();
  for (const e of events) {
    if (kindOf(e) === "red") redActors.add(actorKey(e));
  }

  const rows: ReportRow[] = [];
  for (const e of events) {
    const kind = kindOf(e);
    if (!kind) continue;
    if (typeof e.tick !== "number" || !Number.isFinite(e.tick)) continue;
    if (kind === "yellow" && redActors.has(actorKey(e))) continue;

    const d = eventDisplay(e);
    const name = opts.nameOf?.(e.team, e.playerId);
    rows.push({
      key: `${e.tick}:${e.team ?? "?"}:${e.playerId ?? "?"}:${kind}`,
      tick: e.tick,
      clock: pinClock(e),
      kind,
      icon: d.icon,
      label: d.label,
      ...(e.team !== undefined ? { team: e.team } : {}),
      ...(e.playerId !== undefined ? { playerId: e.playerId } : {}),
      ...(name !== undefined ? { playerName: name } : {}),
      ...(kind === "red" && hasYellow(events, actorKey(e)) ? { secondYellow: true } : {}),
    });
  }

  // 안정 정렬(Array#sort 는 ES2019 부터 안정) — 같은 틱의 골/카드 순서는 로그 순서가 진실이다.
  return rows.sort((a, b) => a.tick - b.tick);
}

function hasYellow(events: readonly HalfReportEventLike[], key: string): boolean {
  return events.some((e) => kindOf(e) === "yellow" && actorKey(e) === key);
}

/**
 * 리포트 헤더에 쓸 스코어.
 *
 * `baseline` = 이 하프 앞에 이미 끝난 하프의 확정 스코어(`stage-state.playedBaseline`). 하프 로그는
 * 그 하프의 골만 갖기 때문에 후반 리포트가 이걸 안 받으면 `0 : 0` 부터 다시 센다(#233 과 같은 함정).
 * 규칙은 `match-logic.runningScore` 가 소유한다 — 여기서 다시 세지 않는다.
 *
 * ⚠️ 스포일러 계약(#238)과 충돌하지 않는다: 이 화면은 유저가 **그 하프를 통째로 건너뛰겠다고
 * 눌러서** 열린 것이고, 서버도 이미 그 하프를 끝냈다(응답 상태가 HALFTIME/FINISHED).
 */
export function halfReportScore(
  events: readonly HalfReportEventLike[] | null | undefined,
  baseline?: ScorePair | null,
): ScorePair {
  const list = (events ?? []) as MatchEventLike[];
  return runningScore(list, list.length, baseline);
}
