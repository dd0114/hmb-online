import {
  coverageLabel,
  passIncomplete,
  passPctLabel,
  ratingTier,
  type PlayerRow,
  type PlayerSelection,
  type TeamSegment,
} from "./player-stats-view";
import type { TeamSide } from "./player-stats";
import styles from "./stage/panels.module.css";

/**
 * **선수 기록 표 · 팀 세그먼트 — 공용 부품** (#403 W4).
 *
 * 선수 탭(`stage/PlayerStatsPanel`)과 결과 탭(`stage/ResultPanel`)이 **같은 컴포넌트**를 쓴다.
 * W3 의 `growth/AttributeLayers` 추출이 그대로 선례이고, 그 선례가 인용한 근거도 같다
 * (`ChoiceCards.tsx` 머리말: *"호출부가 흉내 내기 시작하면 한쪽만 낡는다"*). 같은 경기의 같은
 * 선수가 두 탭에서 다른 열·다른 등급색으로 보이지 않게 하는 것이 요점이다.
 *
 * ⚠️ **`data-testid` 는 `players-*` 를 그대로 쓴다.** 화면별로 이름을 가르면 "두 자리가 같은
 * 컴포넌트"라는 성질을 계약이 확인할 방법이 없다 — 같은 selector 로 양쪽을 재는 것이 그 증거다
 * (W3 이 `growth-*` 를 유지한 것과 같은 이유).
 *
 * ⚠️ **중복 걱정은 구조가 막는다**: 시트는 `activeTab` 으로 패널을 **배타 렌더**하므로
 * (`StageShell` 의 `{activeTab === … && …}`) 선수 탭과 결과 탭이 동시에 DOM 에 있을 수 없다.
 * 그래도 결과 탭 쪽은 `result-players` 컨테이너로 감싸 둔다 — 배타성이 깨지는 날
 * (예: 결과 화면이 페이지로 분리) selector 가 조용히 모호해지는 대신 **스코프가 남아 있게**.
 *
 * ⚠️ **규칙은 여기 없다.** 정렬·행 생성·MOTM 판정·커버리지 계산은 전부 `player-stats-view.ts`
 * 가 소유한다. 이 파일은 그 결과를 그리기만 한다(그래서 두 호출부가 서로 다른 규칙을 못 만든다).
 */

// ── 팀 세그먼트 ──────────────────────────────────────────────────────────

export interface PlayerTeamSegmentsProps {
  /** `teamSegments(names, myTeamSide)` 산출 — **순서는 홈 먼저**(#322 안 C). */
  segments: readonly TeamSegment[];
  team: TeamSide;
  onChange: (side: TeamSide) => void;
}

/**
 * `홈 ↔ 어웨이` 전환 (#403 결정 ② = 상대도 완전히 동일, 지시문만 비공개).
 *
 * ⚠️ **순서를 내 팀 우선으로 뒤집지 마라**(#322 hero 확정 안 C) — 스코어바·통계가 사이드 순서로
 * 읽히는데 여기만 유저 시점이면 어웨이 라운드에서 한 화면의 좌/우가 탭마다 다른 팀을 뜻한다.
 * 어느 쪽이 나인지는 **칩**이 말하고, 기본 선택만 내 팀이다(`defaultSegment`).
 */
export function PlayerTeamSegments({ segments, team, onChange }: PlayerTeamSegmentsProps) {
  return (
    <div className={styles.playerSeg} data-testid="players-teams">
      {segments.map((s) => (
        <button
          key={s.side}
          type="button"
          className={`${styles.playerSegBtn} ${s.side === team ? styles.playerSegOn : ""}`}
          data-testid={`players-team-${s.side}`}
          data-side={s.side}
          data-selected={s.side === team}
          aria-pressed={s.side === team}
          onClick={() => onChange(s.side)}
        >
          {/* ⚠️ 줄임표는 **이름에만** 건다 — 칩을 그 안에 넣으면 긴 팀명 뒤에서 통째로 잘리는데
              DOM 엔 남아 `toBeVisible()` 이 통과한다(#322 에서 실제로 당했다). */}
          <span className={styles.playerSegName}>{s.label}</span>
          {s.mine && (
            <span className={styles.myTeamTag} data-testid={`players-my-team-${s.side}`} aria-label="내 팀">
              내 팀
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── 표 ──────────────────────────────────────────────────────────────────

export interface PlayerStatsTableProps {
  /** 이미 정렬된 행들(`sortRows(rowsFor(…), key)`). 표는 순서를 정하지 않는다. */
  rows: readonly PlayerRow[];
  /**
   * MOTM 으로 강조할 키. **`motmKeyFor(result, window)` 한 곳에서 온다** — 진행 중 경기에
   * "이 경기 최우수"는 없으므로 창이 `settled` 일 때만 값이 있다(그 판정을 여기서 다시 하지 마라).
   */
  motmKey?: string | null;
  /** 패스 귀속 커버리지(0..1). 불완전하면 머리글이 그 사실을 **말한다**(숨기지 않는다). */
  coverage?: number | null;
  selected?: PlayerSelection | null;
  onSelect?: (sel: PlayerSelection) => void;
  onOpenDetail?: (sel: PlayerSelection) => void;
  /** 행이 0개일 때의 문구 — 자리마다 뜻이 다르다(관전 초반 vs 기록 없는 과거 경기). */
  emptyLabel?: string;
}

export function PlayerStatsTable({
  rows,
  motmKey = null,
  coverage = null,
  selected = null,
  onSelect,
  onOpenDetail,
  emptyLabel = "아직 기록이 없습니다",
}: PlayerStatsTableProps) {
  const incomplete = passIncomplete(coverage);
  return (
    <>
      <table className={styles.plist} data-testid="players-table">
        <colgroup>
          <col />
          <col className={styles.colRating} />
          <col className={styles.colNum} />
          <col className={styles.colNum} />
          <col className={styles.colPass} />
          <col className={styles.colDef} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">선수</th>
            <th scope="col">평점</th>
            <th scope="col">골</th>
            <th scope="col">슛</th>
            <th scope="col">
              패스%
              {/*
                귀속이 불완전하면 **숨기지 않고 말한다**(W1 독립검증 권고). 스냅샷이 성긴 로그에서는
                소유 체인이 끊겨 패스 시도의 일부가 아무에게도 안 붙는다 — 그때 숫자만 보이면
                "이 선수는 패스를 그만큼밖에 안 했다"는 거짓이 된다.
              */}
              {incomplete && (
                <span
                  className={styles.playerIncomplete}
                  data-testid="players-pass-incomplete"
                  title={`기록 불완전 — ${coverageLabel(coverage)}`}
                >
                  기록 불완전
                </span>
              )}
            </th>
            <th scope="col">수비</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row
              key={r.key}
              row={r}
              motm={motmKey != null && r.key === motmKey}
              picked={selected?.team === r.team && selected?.playerId === r.playerId}
              onSelect={onSelect}
              onOpenDetail={onOpenDetail}
            />
          ))}
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className={styles.note} data-testid="players-empty">
          {emptyLabel}
        </p>
      )}
    </>
  );
}

function Row({
  row,
  motm,
  picked,
  onSelect,
  onOpenDetail,
}: {
  row: PlayerRow;
  motm: boolean;
  picked: boolean;
  onSelect?: (sel: PlayerSelection) => void;
  onOpenDetail?: (sel: PlayerSelection) => void;
}) {
  /** 한 번의 탭이 두 일을 한다: (B) 피치 강조를 갱신하고, 상세를 연다. 둘은 서로를 안 기다린다. */
  const interactive = Boolean(onSelect || onOpenDetail);
  const pick = () => {
    const sel: PlayerSelection = { team: row.team, playerId: row.playerId };
    onSelect?.(sel);
    onOpenDetail?.(sel);
  };
  const tier = ratingTier(row.line.rating, motm);
  return (
    <tr
      className={`${styles.plistRow} ${picked ? styles.plistRowOn : ""}`}
      data-testid={`players-row-${row.team}-${row.playerId}`}
      data-gk={row.isGk}
      data-picked={picked}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      }}
    >
      <td>
        <span className={styles.pcell}>
          {/* 팀색 원 + 등번호 — 경기장 토큰과 **같은 표현**(#285 정책 절). */}
          <i className={`${styles.pnum} ${row.team === "home" ? styles.pnumHome : styles.pnumAway}`} aria-hidden="true">
            {row.num ?? "–"}
          </i>
          <span className={styles.pname}>{row.name}</span>
          {row.position && <span className={styles.ppos}>{row.position}</span>}
        </span>
      </td>
      <td>
        <i
          className={styles.rating}
          data-tier={tier}
          data-testid={`players-rating-${row.team}-${row.playerId}`}
          title={motm ? "이 경기 최우수 선수" : undefined}
        >
          {row.line.rating.toFixed(1)}
        </i>
      </td>
      <td data-testid={`players-goals-${row.team}-${row.playerId}`}>{row.line.goals}</td>
      <td data-testid={`players-shots-${row.team}-${row.playerId}`}>{row.line.shots}</td>
      <td data-testid={`players-passpct-${row.team}-${row.playerId}`}>{passPctLabel(row.passPct)}</td>
      {/*
        GK 는 이 열이 **선방**이다(목업 ①). 숫자만 두면 "GK 가 수비를 5번 했다"로 읽히므로
        화면이 그걸 말한다 — 색·자리만으로 뜻이 갈리게 두지 않는다.
      */}
      <td data-testid={`players-defence-${row.team}-${row.playerId}`}>
        {row.defence}
        {row.isGk && <small className={styles.pnote}>선방</small>}
      </td>
    </tr>
  );
}
