import { useMemo, useState } from "react";
import {
  DEFAULT_SORT,
  SORT_KEYS,
  SORT_LABELS,
  defaultSegment,
  motmKeyFor,
  rowsFor,
  sortRows,
  teamSegments,
  type PlayerSelection,
  type SortKey,
} from "../player-stats-view";
import { PlayerStatsTable, PlayerTeamSegments } from "../PlayerStatsTable";
import type { MatchPlayerStats } from "../usePlayerStats";
import type { TeamSide } from "../player-stats";
import styles from "./panels.module.css";

interface PlayerStatsPanelProps {
  stats: MatchPlayerStats;
  /** 사이드 기준 팀 이름(#322 — `homeName = ownerName` 금지, `teamNamesOf` 가 소유). */
  homeName: string;
  awayName: string;
  /** 내 팀 사이드. 모르면 null — 거짓 표식을 달지 않는다. */
  myTeamSide?: "home" | "away" | null;
  /**
   * ── (B) 피치 터치 배선 (옵셔널) ─────────────────────────────────────────────────────────
   * **안 주면 이 탭은 그대로 돈다** — 행이 버튼이 아니고 강조도 없을 뿐이다. #421 선배포로 (B)
   * 통합이 보류된 동안 (A) 가 혼자 나갈 수 있는 이유가 이 옵셔널이다(소유는 계속 #403).
   */
  selected?: PlayerSelection | null;
  onSelect?: (sel: PlayerSelection) => void;
  /**
   * 행 탭 → **선수 상세 모달**(#403 W3, 목업 ① *"행을 누르면 그 선수 상세로 → ③"*).
   *
   * ⚠️ `onSelect`((B) 피치 강조)와 **다른 축**이다. 하나로 합치면 피치 터치가 붙는 순간 토큰을
   * 고르기만 해도 모달이 열린다 — 강조와 열람은 다른 동작이다. 둘 다 안 주면 행은 버튼이
   * 아니고, 이 탭은 그대로 돈다((A) 단독 머지 성질 유지).
   */
  onOpenDetail?: (sel: PlayerSelection) => void;
}

/**
 * **선수 기록 탭** (#403 W2, 목업 화면 ①).
 *
 * 요구 A·B = "경기중에도 진행분만큼 선수별 기록을, 상대 선수까지". 결정 ②(hero) = 상대도
 * **우리와 완전히 동일**하게 보여주고 **지시문(프롬프트)만 비공개**다 — 기록은 이미 벌어진 일이고
 * 관중도 보는 것이라, 그걸 근거로 하프타임 지시를 바꾸는 것이 이 게임의 깊이다.
 *
 * 집계는 `useMatchPlayerStats`(= `player-stats.ts`, W1) 가 하고, 이 파일은 **그리기만** 한다.
 * 순수 판정(정렬·열 값·세그먼트·캡션)은 `player-stats-view.ts` 에 있다 — 화면에서 규칙을 다시
 * 쓰면 계약이 못 잡는 자리가 생긴다.
 *
 * ⚠️ **세그먼트와 표는 `../PlayerStatsTable` 공용 부품이다**(#403 W4). 결과 탭이 같은 것을
 * 그리므로 여기에 사본을 두면 한쪽만 낡는다. 이 파일에 남은 것은 **이 탭에만 있는 것**뿐이다:
 * 라이브 캡션 · 정렬 칩 · 상대 지시 비공개 안내.
 *
 * ⚠️ **아이콘을 쓰지 않는다 — 팀색 원 + 등번호다**(#285 정책 절 "경기장 = 팀색 원 + 등번호").
 * 화면에 `grade === …` 비교가 없고 `CharAvatar` 도 없으므로 아트 노출 정책을 지나갈 일이 아예
 * 없다. 무엇보다 이 표는 **바로 위 경기장 토큰과 같은 것을 가리키므로** 같은 표현이어야
 * 유저가 행↔토큰을 잇는다(번호도 `viewer-skins.jerseyNumbers` 로 코어와 같은 규칙을 쓴다).
 */
export function PlayerStatsPanel({
  stats,
  homeName,
  awayName,
  myTeamSide = null,
  selected = null,
  onSelect,
  onOpenDetail,
}: PlayerStatsPanelProps) {
  const [team, setTeam] = useState<TeamSide>(() => defaultSegment(myTeamSide));
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);

  const { result, roster, coverage, window: win, isLoading, isError } = stats;
  const segments = teamSegments({ home: homeName, away: awayName }, myTeamSide);

  const rows = useMemo(
    () => (result ? sortRows(rowsFor(result, team, roster), sort) : []),
    [result, team, roster, sort],
  );

  if (isLoading) return <p className={styles.note}>선수 기록 불러오는 중…</p>;
  if (isError || !result) return <p className={styles.note}>선수 기록을 불러오지 못했습니다</p>;

  /**
   * ⚠️ 캡션을 여기서 조립하지 마라 — **상한과 같은 출처**(`statsWindow`)에서 온다(BL-1).
   * 둘이 따로 놀던 동안 감독시간이 "7분까지의 기록" 위에 전 선수 0 을 그렸다.
   */
  const caption = win.caption;

  return (
    <div className={styles.playersBody} data-testid="stage-panel-players">
      {/*
        팀 전환 — **순서는 홈 먼저**(#322 안 C). 내 팀을 앞으로 당기지 않고 칩으로 말한다.
        기본 선택만 내 팀이다(`defaultSegment`) — 순서를 안 바꾸는 대신 선택으로 답한다.
      */}
      <PlayerTeamSegments segments={segments} team={team} onChange={setTeam} />

      {/* 라이브면 "N분까지" — 종료 경기면 이 줄이 아예 없다(목업 ①·③: 화면은 같고 문구만 붙고 뗀다). */}
      {caption && (
        <p className={styles.playerLiveCap} data-testid="players-live-caption" data-kind={win.kind}>
          {caption}
        </p>
      )}

      {/* ⚠️ 가로로 긴 줄 — 자기 안에서 스크롤해야 시트를 밀지 않는다(#284 `min-width:0` 함정). */}
      <div className={styles.playerSort} data-testid="players-sort">
        {SORT_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className={`${styles.playerSortChip} ${k === sort ? styles.playerSortOn : ""}`}
            data-testid={`players-sort-${k}`}
            data-selected={k === sort}
            aria-pressed={k === sort}
            onClick={() => setSort(k)}
          >
            {SORT_LABELS[k]}
          </button>
        ))}
      </div>

      <PlayerStatsTable
        rows={rows}
        motmKey={motmKeyFor(result, win)}
        coverage={coverage}
        selected={selected}
        onSelect={onSelect}
        onOpenDetail={onOpenDetail}
      />

      {/*
        결정 ②(hero) = 상대도 **우리와 완전히 동일**, **지시문만 비공개**. 목업 ① 상대 탭에 그
        안내가 그려져 있는데 구현에 없어서 **화면이 그 결정을 말하지 않았다**(독립검증 m5) —
        유저 입장에서는 "왜 상대는 지시가 안 보이지"가 결함으로 읽힌다. 기록이 다 보이는 자리에서
        무엇이 가려져 있는지 말하는 것이 이 줄의 일이다.
      */}
      {myTeamSide != null && team !== myTeamSide && (
        <p className={styles.playerLocked} data-testid="players-opponent-privacy">
          🔒 상대의 <b>지시(프롬프트)</b>는 보이지 않습니다 — 기록만 공개됩니다
        </p>
      )}
    </div>
  );
}
