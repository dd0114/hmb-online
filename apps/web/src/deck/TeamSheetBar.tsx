import { FORMATION_LAYOUTS, type DeckDraft } from "./deck-logic";
import { powerShare } from "./team-power";
import { sheetMetrics } from "./sheet-metrics";
import styles from "./TeamSheetBar.module.css";

interface TeamSheetBarProps {
  draft: DeckDraft;
  onFormationChange: (formation: string) => void;
  /** 우리 선발 전력(합산 overall, AC-B5) */
  power: number;
  /** 상대 전력 — 브리핑에서만 온다. 없으면 게이지는 우리 값만 표시. */
  opponentPower?: number;
  opponentName?: string;
  /** 상대 파워가 등급 기반 근사값이면 ≈ 로 표기(구 TeamPowerBar 의 주석 대체). */
  opponentApprox?: boolean;
  /**
   * 배치 잠금(감독시간) — 바가 정적 모양이 된다.
   *
   * ⚠️ **AUTO 는 여기 없다**(#455 A3). 구 동작은 이 바(`auto-fill-top`, 폰)와 보드 하단 바
   * (`auto-fill`, 데스크탑)와 빈 상태(`board-empty-auto`)가 **같은 `onAuto` 를 셋이** 그려서,
   * 폭에 따라 어느 것이 보이는지가 달랐다. 지금은 경기장 우측 하단 하나뿐이다
   * (`TacticsBoard.autoFill`). 여기에 다시 붙이면 그 산재가 되살아난다.
   */
  placementLocked?: boolean;
  /**
   * 포메이션 셀렉트를 감춘다 — **배치 잠금과는 다른 축**(#276).
   *
   * #244 는 `placementLocked` 하나로 둘을 묶어 뒀지만(*"감독시간엔 포메이션을 바꾸지 않는다"*),
   * hero 결정으로 그 전제가 뒤집혔다: 감독시간에도 **포메이션과 선발 배치는 바꾼다**. 못 바꾸는
   * 것은 "스쿼드 밖에서 선수를 데려오는 것"뿐이다. 그래서 축을 쪼갠다 —
   * 감독시간은 `placementLocked` 이면서 `formationLocked=false` 다.
   * (보낼 데가 없는 화면 — 스냅샷 없는 구 매치 — 만 다시 true 가 된다: 만져도 아무 데도 안 가는
   *  손잡이를 만들지 않는다.)
   */
  formationLocked?: boolean;
  /** 셀렉트는 보이되 지금은 못 만진다(감독시간 만료 등) — 사라지지 않아야 "끝났다"가 읽힌다. */
  formationDisabled?: boolean;
  /**
   * 상대 정보 시트 열기(#285). **여기에 붙는 이유**: 브리핑 상단에 따로 있던 메타 줄을 걷어내면서
   * 필수 진입점만 남겼는데, 이 줄이 이미 상대 이름·전력을 말하고 있다 = "상대"라는 주제가 있는
   * 유일한 자리다. 별도 줄로 되돌리면 #244 가 회수한 세로 예산을 다시 쓴다.
   * 없으면(덱 화면) 버튼을 그리지 않는다 — 상대가 없는 화면이다.
   */
  onOpponentInfo?: () => void;
}

/**
 * ① 시트 바 (이슈 #106 R1) — 팀 시트의 sticky 헤더.
 *
 * #106 "입력이 흩어져 있다": 포메이션·전력·구성 상태가 화면 곳곳의 별도 블록으로 흩어져 무엇이
 * 무엇을 결정하는지 인지선이 끊겼다. 그 요약을 **한 줄 상태 바**로 모은다:
 *   포메이션 · 전력 게이지(우리 vs 상대) · 선발 n/11 · 벤치 n/7 · 지시 n/11
 * 여기는 "지금 팀이 어떤 상태인가"만 말한다 — 편집은 전부 ② 전술보드(SoT)와 ③ 지시 레일에서.
 * 모바일에서는 보드 하단 바가 접히므로 AUTO 만 이 바에 얹는다(목업 askin-mobile).
 */
export function TeamSheetBar(props: TeamSheetBarProps) {
  const { draft, onFormationChange, power, opponentPower, opponentName, opponentApprox, placementLocked, formationLocked, formationDisabled, onOpponentInfo } = props;
  const m = sheetMetrics(draft);
  const share = opponentPower != null ? powerShare(power, opponentPower) : 1;

  return (
    <header
      className={placementLocked ? `${styles.bar} ${styles.barStatic}` : styles.bar}
      data-testid="team-sheet-bar"
      /* 빈 상태(#106 R3b A) — 선발 0 이면 보드가 안내 오버레이를 띄운다(같은 조건을 여기도 노출해
         E2E 가 "바 3지표 0 ↔ 보드 안내"를 한 상태로 검증한다). */
      data-empty={m.starters === 0 ? "true" : "false"}
    >
      <div className={styles.top}>
        <h2 className={styles.title}>팀 시트</h2>
        {/* 포메이션은 **배치 잠금과 다른 축**이다(#276) — 감독시간에도 바꾼다. `formationLocked` 는
            보낼 데가 없는 화면(스냅샷 없는 구 매치)에서만 true 다. */}
        {!formationLocked && (
        <label className={styles.formationLabel} htmlFor="formation">
          <span className={styles.srOnly}>포메이션</span>
          <select
            id="formation"
            data-testid="formation-select"
            className={styles.formation}
            value={draft.formation}
            disabled={formationDisabled}
            onChange={(e) => onFormationChange(e.target.value)}
          >
            {Object.keys(FORMATION_LAYOUTS).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        )}
      </div>

      <div className={styles.power} data-testid="sheet-power">
        <span className={styles.me}>우리 {power}</span>
        <span className={styles.gauge}>
          <i style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
        <span
          className={styles.op}
          data-testid="sheet-power-opponent"
          title={opponentApprox ? "상대 파워는 보유 선수 등급 기반 근사값" : undefined}
        >
          {opponentPower != null
            ? `${opponentApprox ? "≈" : ""}${opponentPower} ${opponentName ?? "상대"}`
            : "상대 미정"}
        </span>
        {onOpponentInfo && (
          <button
            type="button"
            className={styles.oppInfo}
            data-testid="opp-sheet-open"
            onClick={onOpponentInfo}
          >
            상대 정보 ↗
          </button>
        )}
      </div>

      <div className={styles.fill}>
        <span className={m.starters === m.starterMax ? styles.ok : undefined} data-testid="starter-count">
          선발 {m.starters}/{m.starterMax}
        </span>
        <span data-testid="bench-count">
          벤치 {m.bench}/{m.benchMax}
        </span>
        <span className={styles.ink} data-testid="directive-count">
          <span className={styles.dot} aria-hidden="true" />
          지시 {m.directives}/{m.directiveMax}
        </span>
      </div>
    </header>
  );
}
