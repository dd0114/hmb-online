/**
 * 선수 상세 [이 경기] 탭의 **순수 표시 로직** (#403 W3, 목업 화면 ③).
 *
 * 집계는 `player-stats.ts`(W1) 가 소유한다 — 여기서 지표를 다시 계산하지 않는다. 하는 일은
 * "그 한 줄을 실제 축구 앱처럼 카테고리로 어떻게 묶어 말하나"뿐이다. React·DOM 의존 0.
 *
 * ⚠️ **상한·분(캡션)은 여기 없다.** `statsWindow`(`player-stats-view.ts`)가 단일 출처다 —
 * BL-1 이 정확히 "상한은 훅이, 캡션은 화면이" 따로 만들다가 난 사고였다. 모달은 그 창을 받아
 * 그리기만 한다.
 *
 * ⚠️ **T3 지표를 만들지 않는다**(크로스 · 슛 블록 · 드리블 성공률 · 피파울 · 경합 시도수).
 * 엔진이 기록하지 않아 원리적으로 못 낸다 — 목업에도 일부러 안 넣었고, QA #25 에 레이즈돼 있다.
 * 목업 ③ 에는 있으나 W1 집계에 없어 **빠진 것**: `박스 안 터치` · `공중볼 승리` · `전진 패스`.
 * 채우려면 집계(W1)를 먼저 늘려야 한다 — 화면에서 지어내지 않는다.
 */
import { passPct, type PlayerStatLine } from "./player-stats";

export interface StatItem {
  key: string;
  label: string;
  value: string;
  /** 아무 일도 없었던 줄(전부 0/—) — 화면이 흐리게 그린다. */
  dim?: boolean;
}

export interface StatCategory {
  key: string;
  title: string;
  items: StatItem[];
  /** 카테고리 밑에 붙는 경고(예: 패스 귀속 불완전). */
  note?: string;
  /** 0..1 진행바(패스 성공률). 없으면 안 그린다. */
  bar?: number;
}

/** `1` / 없으면 `—`. 0 을 `0` 으로 쓰면 표가 0 으로 도배된다. */
function n(v: number): string {
  return v > 0 ? String(v) : "—";
}

const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/**
 * GK 선방률(%). **상대한 유효슛 = 선방 + 실점** 은 엔진에서 근사가 아니라 항등식이다
 * (빗나간 슛은 GK 의 일이 아니다 — `player-stats.keeperAxis` 머리말). 유효슛이 0 이면 **null**:
 * 0% 도 100% 도 거짓이다.
 *
 * ⚠️ 이건 **표시용**이다. 평점의 GK 축은 소표본 수축(베이지안)을 쓰고 그 계수는
 * `RATING_WEIGHTS` 소관이다 — 여기 값과 같아야 할 이유가 없고, 같게 만들려고 계수를 건드리지 마라.
 */
export function savePct(line: Pick<PlayerStatLine, "saves" | "goalsConceded">): number | null {
  const faced = line.saves + line.goalsConceded;
  if (faced <= 0) return null;
  return Math.round((line.saves / faced) * 1000) / 10;
}

/** `72%` / 모르면 `—`. */
export function pctLabel(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)}%`;
}

/** 상단 KPI 4칸 — 이 선수가 이 경기에서 한 일의 요약. GK 는 축이 다르다(목업 ③ 각주). */
export function kpiFor(line: PlayerStatLine, isGk: boolean): StatItem[] {
  if (isGk) {
    return [
      { key: "saves", label: "선방", value: String(line.saves) },
      { key: "conceded", label: "실점", value: String(line.goalsConceded) },
      { key: "savePct", label: "선방률", value: pctLabel(savePct(line)) },
      { key: "passPct", label: "패스%", value: pctLabel(passPct(line)) },
    ];
  }
  return [
    { key: "goals", label: "골", value: String(line.goals) },
    { key: "assists", label: "도움", value: String(line.assists) },
    { key: "shots", label: "슈팅", value: String(line.shots) },
    { key: "xg", label: "xG", value: line.xg.toFixed(2) },
  ];
}

/**
 * 카테고리 묶음 — 공격(GK 는 선방) / 패스 / 수비·경합 / 활동량 / 규율.
 *
 * `coverage` 가 1 미만이면 패스 카테고리에 **"기록 불완전"** 을 단다(W1 독립검증 권고): 스냅샷이
 * 성긴 로그에서는 소유 체인이 끊겨 시도의 일부가 아무에게도 안 붙는데, 숫자만 보여 주면
 * "이 선수는 패스를 그만큼밖에 안 했다"는 거짓이 된다. 판정은 `player-stats-view.passIncomplete`
 * 와 같은 축이라 그 함수를 **호출부에서 받아** 쓴다(두 곳이 다른 임계를 갖지 않게).
 */
export function categoriesFor(
  line: PlayerStatLine,
  isGk: boolean,
  coverageNote: string | null,
): StatCategory[] {
  const pp = passPct(line);
  const cards = disciplineLabel(line);

  const attack: StatCategory = isGk
    ? {
        key: "keeper",
        title: "선방",
        items: [
          { key: "saves", label: "선방", value: n(line.saves) },
          { key: "conceded", label: "실점", value: n(line.goalsConceded) },
          { key: "savePct", label: "선방률", value: pctLabel(savePct(line)), dim: savePct(line) == null },
        ],
      }
    : {
        key: "attack",
        title: "공격",
        items: [
          { key: "shots", label: "슈팅 (유효)", value: `${line.shots} (${line.shotsOnTarget})`, dim: line.shots === 0 },
          { key: "xg", label: "기대득점 xG", value: line.xg.toFixed(2), dim: line.xg <= 0 },
          { key: "keyPasses", label: "기회 창출(키패스)", value: n(line.keyPasses), dim: line.keyPasses === 0 },
          { key: "assists", label: "어시스트", value: n(line.assists), dim: line.assists === 0 },
          { key: "offsides", label: "오프사이드", value: n(line.offsides), dim: line.offsides === 0 },
        ],
      };

  const pass: StatCategory = {
    key: "pass",
    title: "패스",
    items: [
      {
        key: "passes",
        label: "패스 성공 / 시도",
        value: `${line.passesCompleted} / ${line.passesAttempted}`,
        dim: line.passesAttempted === 0,
      },
      { key: "passPct", label: "패스 성공률", value: pctLabel(pp), dim: pp == null },
      {
        key: "longPasses",
        label: "롱 패스 성공 / 시도",
        value: `${line.longPassesCompleted} / ${line.longPasses}`,
        dim: line.longPasses === 0,
      },
    ],
    ...(pp != null ? { bar: pp / 100 } : {}),
    ...(coverageNote ? { note: `기록 불완전 — ${coverageNote}` } : {}),
  };

  const defence: StatCategory = {
    key: "defence",
    title: "수비 · 경합",
    items: [
      { key: "tackles", label: "태클 성공", value: n(line.tackles), dim: line.tackles === 0 },
      { key: "interceptions", label: "가로채기", value: n(line.interceptions), dim: line.interceptions === 0 },
      { key: "clearances", label: "걷어내기", value: n(line.clearances), dim: line.clearances === 0 },
      { key: "dispossessed", label: "볼 뺏김", value: n(line.dispossessed), dim: line.dispossessed === 0 },
    ],
  };

  const work: StatCategory = {
    key: "work",
    title: "활동량",
    items: [
      { key: "distance", label: "뛴 거리", value: `${one(line.distanceM / 1000)} km`, dim: line.distanceM <= 0 },
      { key: "touches", label: "터치", value: n(line.touches), dim: line.touches === 0 },
      {
        key: "carries",
        label: "드리블 전진",
        value: line.carries > 0 ? `${line.carries}회 · ${Math.round(line.carryProgressM)} m` : "—",
        dim: line.carries === 0,
      },
      { key: "minutes", label: "출전 시간", value: `${line.minutesPlayed}분`, dim: line.minutesPlayed <= 0 },
    ],
  };

  const discipline: StatCategory = {
    key: "discipline",
    title: "규율",
    items: [
      { key: "fouls", label: "파울", value: n(line.fouls), dim: line.fouls === 0 },
      { key: "cards", label: "경고 / 퇴장", value: cards.value, dim: cards.dim },
    ],
  };

  return [attack, pass, defence, work, discipline];
}

/**
 * `경고 / 퇴장`. ⚠️ 2번째 옐로는 엔진이 `yellow` 와 `red` 를 **둘 다** 쏜다 — 순진하게 세면
 * 카드가 2장이 된다(W0 §2 구현 함정 ②). 집계가 `secondYellow` 로 알려 주므로 그 옐로를
 * 레드에 흡수하고, 대신 **경고 누적 퇴장이었다는 사실**을 말한다(그게 다른 사건이다).
 */
export function disciplineLabel(
  line: Pick<PlayerStatLine, "yellowCards" | "redCards" | "secondYellow" | "sentOff">,
): { value: string; dim: boolean } {
  const yellows = Math.max(0, line.yellowCards - (line.secondYellow ? 1 : 0));
  const reds = line.sentOff ? Math.max(1, line.redCards) : line.redCards;
  if (yellows === 0 && reds === 0) return { value: "— / —", dim: true };
  const tail = line.secondYellow ? " (경고 누적)" : "";
  return { value: `${n(yellows)} / ${n(reds)}${tail}`, dim: false };
}

/**
 * 히트맵 셀의 0..1 밀도 — 최대 빈을 1 로 정규화한다. 전부 0 이면 **빈 배열**(격자를 안 그린다:
 * 균일한 회색 격자는 "여기저기 다녔다"는 거짓 신호가 된다).
 */
export function heatDensities(heat: readonly number[] | undefined): number[] {
  if (!heat || heat.length === 0) return [];
  let max = 0;
  for (const v of heat) if (Number.isFinite(v) && v > max) max = v;
  if (max <= 0) return [];
  return heat.map((v) => (Number.isFinite(v) && v > 0 ? v / max : 0));
}
