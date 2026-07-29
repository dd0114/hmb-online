import { type DeckDraft } from "./deck-logic";
import { FormationSelect } from "./FormationSelect";
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
  /** 모바일 시트 바에 붙는 AUTO (데스크탑은 보드 하단 바가 담당) */
  autoDisabled?: boolean;
  autoHint?: string;
  onAuto?: () => void;
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
  const { draft, onFormationChange, power, opponentPower, opponentName, opponentApprox, autoDisabled, autoHint, onAuto } = props;
  const m = sheetMetrics(draft);
  const share = opponentPower != null ? powerShare(power, opponentPower) : 1;

  return (
    <header
      className={styles.bar}
      data-testid="team-sheet-bar"
      /* 빈 상태(#106 R3b A) — 선발 0 이면 보드가 안내 오버레이를 띄운다(같은 조건을 여기도 노출해
         E2E 가 "바 3지표 0 ↔ 보드 안내"를 한 상태로 검증한다). */
      data-empty={m.starters === 0 ? "true" : "false"}
    >
      <div className={styles.top}>
        <h2 className={styles.title}>팀 시트</h2>
        {onAuto && (
          <button
            type="button"
            className={styles.auto}
            data-testid="auto-fill-top"
            disabled={autoDisabled}
            title={autoHint}
            onClick={onAuto}
          >
            AUTO
          </button>
        )}
        {/* 마크업은 FormationSelect 가 소유한다(#276 — 감독시간 라인업 보드와 같은 손잡이).
            클래스를 그대로 넘겨 이 바의 DOM·생김새는 이전과 동일하다. */}
        <FormationSelect
          value={draft.formation}
          onChange={onFormationChange}
          classNames={{ label: styles.formationLabel, srOnly: styles.srOnly, select: styles.formation }}
        />
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
      {autoHint && autoDisabled && (
        <p className={styles.autoHint} data-testid="auto-hint-top">
          {autoHint}
        </p>
      )}
    </header>
  );
}
